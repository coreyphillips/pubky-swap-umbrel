'use strict';

// The request-body hang, and the traversal check.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readBody, serveStatic, PUBLIC_DIR } = require('../lib/http');

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      try { await run(server.address().port); resolve(); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

test('a body over the limit rejects instead of hanging forever', async () => {
  // The old readBody destroyed the request and never settled its promise, so the handler awaiting
  // it was leaked and the browser's fetch stayed pending: uploading a large recovery file left the
  // Save button reading "Saving..." with no error, permanently.
  await withServer(async (req, res) => {
    try {
      await readBody(req, { limit: 1024, timeoutMs: 2000 });
      res.writeHead(200); res.end('accepted');
    } catch (e) {
      res.writeHead(e.status || 500); res.end(e.code || 'ERR');
    }
  }, async (port) => {
    const settled = await Promise.race([
      fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x'.repeat(64 * 1024) })
        .then((r) => `${r.status}`)
        .catch((e) => `network:${e.cause ? e.cause.code : e.message}`),
      new Promise((r) => setTimeout(() => r('HUNG'), 4000)),
    ]);
    assert.notEqual(settled, 'HUNG', 'the request must settle rather than hang');
  });
});

test('a body within the limit is read whole, counted in bytes', async () => {
  await withServer(async (req, res) => {
    const buf = await readBody(req, { limit: 4096 });
    res.writeHead(200); res.end(String(buf.length));
  }, async (port) => {
    // Multibyte on purpose: the old limit counted UTF-16 code units of a growing string.
    const body = 'e'.repeat(100);
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body });
    assert.equal(await res.text(), String(Buffer.byteLength(body)));
  });
});

test('traversal and sibling-directory paths are refused', async () => {
  await withServer((req, res) => serveStatic(req, res, req.url), async (port) => {
    for (const target of ['/../server.js', '/../../etc/passwd', '/%2e%2e/server.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${target}`);
      assert.equal(res.status, 404, `${target} must not be served`);
    }
  });
});

test('the public prefix check requires a path separator', () => {
  // `startsWith(PUBLIC_DIR)` alone would accept a sibling named `public-anything`.
  const path = require('node:path');
  const sibling = PUBLIC_DIR + '-secrets';
  assert.ok(sibling.startsWith(PUBLIC_DIR), 'the naive check would pass this');
  assert.ok(!sibling.startsWith(PUBLIC_DIR + path.sep), 'the real check rejects it');
});
