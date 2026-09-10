'use strict';

// The HTTP plumbing: reading bodies, serving assets, and the headers that make both safe.

const fs = require('fs');
const path = require('path');
const { hasControlChar } = require('./text');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // A wrong MIME here does not degrade, it fails outright: the browser refuses the module with
  // "Failed to load module script" and the whole page is blank.
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// No 'unsafe-inline' anywhere. That is a structural backstop against the class of bug where a
// value parsed out of a *remote provider's* output reaches the page as markup: even if a future
// edit reintroduces an innerHTML, the injected script cannot run. It is also why index.html carries
// no inline <style> or <script> and no style="" attributes. CSSOM writes from JS still work, so
// JS-driven bars and per-swap tone tokens are unaffected.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CSP,
};

function httpError(status, code, message, remedy = null) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.remedy = remedy;
  return err;
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(buf);
}

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  sendJson(res, status, {
    error: {
      code: (err && err.code) || 'INTERNAL',
      // Fixed messages only. An error that echoes the submitted body is how a recovery phrase ends
      // up in a browser's network tab.
      message: (err && err.message) || 'Something went wrong.',
      remedy: (err && err.remedy) || null,
    },
  });
}

/**
 * Read a request body, always settling.
 *
 * The old version destroyed the request past its limit and never resolved or rejected, so the
 * awaiting handler hung forever: uploading a recovery file over the limit left the Save button
 * saying "Saving..." with no error, permanently. It also measured length in UTF-16 code units of a
 * growing string, so the limit was wrong for multibyte input and the concatenation was quadratic.
 */
function readBody(req, { limit = 64 * 1024, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      done(reject, httpError(408, 'TIMEOUT', 'The request took too long.'));
      req.destroy();
    }, timeoutMs);

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        done(reject, httpError(413, 'TOO_LARGE', 'That is larger than this endpoint accepts.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks)));
    req.on('aborted', () => done(reject, httpError(400, 'ABORTED', 'The request was interrupted.')));
    req.on('close', () => done(reject, httpError(400, 'ABORTED', 'The connection closed.')));
    req.on('error', () => done(reject, httpError(400, 'INVALID', 'The request could not be read.')));
  });
}

async function readJson(req, opts) {
  const buf = await readBody(req, opts);
  if (!buf.length) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw httpError(400, 'INVALID', 'That request body was not valid JSON.');
  }
}

/**
 * Reject requests that a cross-site page could have made without the browser asking permission.
 *
 * A form post or a `text/plain` fetch is a CORS-*simple* request: no preflight, so any page on the
 * LAN could have driven the old panel's endpoints -- starting a swap, replacing the identity, or
 * clearing it entirely. Requiring a JSON or octet-stream content type is enough on its own, since
 * neither is simple; `Sec-Fetch-Site` and `Origin` are belt and braces for browsers that send them.
 */
function guardMutation(req, { allowOctet = false } = {}) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const allowed = allowOctet ? ['application/json', 'application/octet-stream'] : ['application/json'];
  if (!allowed.includes(type)) {
    throw httpError(415, 'INVALID', 'This endpoint only accepts JSON.');
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    throw httpError(403, 'FORBIDDEN', 'Cross-site requests are not accepted.');
  }
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (!host || host !== req.headers.host) {
      throw httpError(403, 'FORBIDDEN', 'Cross-origin requests are not accepted.');
    }
  }
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end('not found');
}

/**
 * Serve a static asset.
 *
 * Three fixes over the old version, in descending order of severity. There was no `'error'` handler
 * on the read stream, so an EISDIR or EACCES -- or a file deleted between the existence check and
 * the open -- threw an uncaught exception and took the entire control panel down. The traversal
 * check compared with `startsWith(PUBLIC_DIR)` without a separator, so a sibling directory named
 * `public-anything` would have passed. And the content-type table was missing most of what the new
 * UI serves, which for `.js` means the page simply does not load.
 */
function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return notFound(res); }
  if (hasControlChar(rel)) return notFound(res);

  const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel === '/' ? '/index.html' : rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);

  let stat;
  try { stat = fs.statSync(file); } catch { return notFound(res); }
  let target = file;
  if (stat.isDirectory()) {
    target = path.join(file, 'index.html');
    try { stat = fs.statSync(target); } catch { return notFound(res); }
  }

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, ...SECURITY_HEADERS });
    return res.end();
  }

  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
    'Content-Length': stat.size,
    // "revalidate every time", which on a LAN is a few milliseconds and guarantees that replacing
    // the container never leaves a week-old tab running last month's JavaScript.
    'Cache-Control': 'no-cache',
    ETag: etag,
    ...SECURITY_HEADERS,
  };
  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(target);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
}

module.exports = {
  PUBLIC_DIR, CONTENT_TYPES, CSP, SECURITY_HEADERS,
  httpError, sendJson, sendError, readBody, readJson, guardMutation, serveStatic, notFound,
};
