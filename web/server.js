'use strict';

// Pubky Swap -- Umbrel control panel.
//
// This file is wiring: environment, routes, listen, shut down. Everything with a decision in it
// lives in web/lib.
//
// The shape worth knowing before reading: the panel does not learn about the daemon by reading its
// logs. `swap-provider` serves a read-only status API on loopback, and lib/status-client polls it.
// Upstream wrote that API because this app used to match regexes against stdout, "which works until
// a message is reworded and then fails silently, reporting a healthy daemon or an unhealthy one
// with equal confidence". Log lines are still ingested, but as something to read, not as a source
// of truth -- with two exceptions, both about startup failures that happen before the API can bind,
// and about the four real-money alarms that have no API equivalent.

const http = require('http');
const fs = require('fs');

const paths = require('./lib/paths');
const settings = require('./lib/settings');
const secrets = require('./lib/secrets');
const engine = require('./lib/engine');
const doctor = require('./lib/doctor');
const snapshot = require('./lib/snapshot');
const { LogBuffer } = require('./lib/logbuf');
const { Redactor } = require('./lib/redact');
const { Notices } = require('./lib/notices');
const { StatusClient } = require('./lib/status-client');
const { Provider } = require('./lib/provider');
const { Taker } = require('./lib/taker');
const { Sse } = require('./lib/sse');
const { createAccessGuard } = require('./lib/access');
const {
  httpError, sendJson, sendError, readBody, readJson, guardMutation, serveStatic, notFound,
} = require('./lib/http');

const PORT = parseInt(process.env.PORT || '3000', 10);

// --- wiring ------------------------------------------------------------------------------------

const notices = new Notices();
const redactor = new Redactor();
const sse = new Sse({ onCount: (n) => statusClient.setWatchers(n) });

const logs = new LogBuffer({
  redactor,
  onLines: (lines) => {
    notices.scan(lines);
    sse.broadcast('log', { source: 'provider', lines });
  },
});

const statusClient = new StatusClient({ onChange: (name) => onStatusChange(name) });
const provider = new Provider({ logs, statusClient, redactor, notices });
const taker = new Taker({ logs, notices });

let lastDoctor = null;
let doctorRunning = false;

function state() {
  return snapshot.build({ provider, statusClient, taker, notices, health: lastDoctor });
}

let broadcastQueued = false;
function broadcast() {
  if (broadcastQueued || !sse.count) return;
  broadcastQueued = true;
  // Coalesce: several status endpoints can land in the same tick, and a browser only needs the
  // resulting state once.
  setImmediate(() => { broadcastQueued = false; sse.broadcast('snapshot', state()); });
}

function onStatusChange() { broadcast(); }

const allowChange = createAccessGuard({ log: (m) => logs.note(m) });

// --- routes ------------------------------------------------------------------------------------

const routes = [
  ['GET', '/api/bootstrap', async (req, res) => {
    sendJson(res, 200, { ...state(), log: { provider: logs.tail(200), seq: logs.seq } });
  }],

  ['GET', '/api/state', async (req, res) => sendJson(res, 200, state())],

  ['GET', '/api/stream', async (req, res) => { sse.subscribe(req, res, state()); }],

  ['GET', '/api/logs', async (req, res, url) => {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    sendJson(res, 200, { seq: logs.seq, lines: logs.since(since, limit) });
  }],

  ['GET', '/api/diagnostics', async (req, res) => {
    sendJson(res, 200, { report: lastDoctor, running: doctorRunning });
  }],

  ['POST', '/api/diagnostics/run', async (req, res) => {
    guardMutation(req);
    if (doctorRunning) throw httpError(409, 'BUSY', 'A check is already running.');
    doctorRunning = true;
    broadcast();
    try { lastDoctor = await doctor.run(); }
    finally { doctorRunning = false; }
    broadcast();
    sendJson(res, 200, { report: lastDoctor });
  }],

  ['POST', '/api/settings', async (req, res) => {
    guardMutation(req);
    const body = await readJson(req);
    const saved = settings.apply(body);
    // Saving rates does not restart the daemon. It has no reload signal, so a change only reaches
    // the wire on a restart, and pretending otherwise would mean the panel showed rates nobody was
    // being offered. The UI shows "advertising X, saved Y" and asks for the restart explicitly.
    let restarted = false;
    if (body.restart === true && provider.desired === 'running') {
      await provider.restart();
      restarted = true;
    }
    broadcast();
    sendJson(res, 200, { ok: true, settings: saved, restarted });
  }],

  ['POST', '/api/identity/phrase', async (req, res) => {
    guardMutation(req);
    const { phrase } = await readJson(req);
    secrets.writePhrase(phrase);
    redactor.refresh();
    broadcast();
    sendJson(res, 200, { ok: true, identity: secrets.identityKind() });
  }],

  ['POST', '/api/identity/file', async (req, res) => {
    guardMutation(req, { allowOctet: true });
    // Raw bytes rather than base64 in JSON: half the size, and no decode step that quietly accepts
    // garbage as an empty buffer.
    const buf = await readBody(req, { limit: 256 * 1024 });
    secrets.writeRecoveryFile(buf);
    redactor.refresh();
    broadcast();
    sendJson(res, 200, { ok: true, identity: secrets.identityKind() });
  }],

  ['POST', '/api/identity/passphrase', async (req, res) => {
    guardMutation(req);
    const { passphrase } = await readJson(req);
    secrets.writePassphrase(passphrase);
    redactor.refresh();
    broadcast();
    sendJson(res, 200, { ok: true, hasPassphrase: secrets.hasPassphrase() });
  }],

  ['POST', '/api/identity/probe', async (req, res) => {
    guardMutation(req);
    sendJson(res, 200, await taker.probeIdentity());
  }],

  ['POST', '/api/identity/clear', async (req, res) => {
    guardMutation(req);
    await provider.stop();
    secrets.clearAll();
    try { fs.rmSync(paths.settings, { force: true }); } catch {}
    settings.invalidate();
    redactor.refresh();
    logs.note('Identity and settings cleared. Swap records were kept.');
    broadcast();
    sendJson(res, 200, { ok: true });
  }],

  ['POST', '/api/provider/start', async (req, res) => {
    guardMutation(req);
    await provider.start();
    broadcast();
    sendJson(res, 200, { ok: true, provider: provider.view() });
  }],

  ['POST', '/api/provider/stop', async (req, res) => {
    guardMutation(req);
    // Deliberately not awaited: stopping allows the daemon twenty seconds to unwind its drivers
    // cleanly, and an HTTP request should not hold a connection open for that. The stream reports
    // the transition.
    provider.stop().then(broadcast);
    sendJson(res, 200, { ok: true, state: 'stopping' });
  }],

  ['POST', '/api/provider/restart', async (req, res) => {
    guardMutation(req);
    provider.restart().then(broadcast);
    sendJson(res, 200, { ok: true, state: 'restarting' });
  }],

  ['POST', '/api/taker/quote', async (req, res) => {
    guardMutation(req);
    const input = validateSwapInput(await readJson(req));
    try {
      sendJson(res, 200, { ok: true, quote: await taker.quote(input) });
    } catch (e) {
      // A provider that does not answer is an outcome, not a server error: it needs to render as a
      // readable message in the quote card, not as a failed request.
      if (e.code === 'NO_QUOTE') return sendJson(res, 200, { ok: false, error: e.message, detail: e.remedy });
      throw e;
    }
  }],

  ['POST', '/api/taker/swap', async (req, res) => {
    guardMutation(req);
    const input = validateSwapInput(await readJson(req));
    const started = await taker.startSwap(input);
    broadcast();
    sendJson(res, 200, { ok: true, ...started });
  }],

  ['POST', '/api/taker/cancel', async (req, res) => {
    guardMutation(req);
    const { force } = await readJson(req);
    const result = await taker.cancel({ force: force === true });
    broadcast();
    sendJson(res, 200, { ok: true, ...result });
  }],

  ['POST', '/api/taker/resume', async (req, res) => {
    guardMutation(req);
    const started = await taker.resume();
    broadcast();
    sendJson(res, 200, { ok: true, ...started });
  }],

  ['POST', '/api/notices/ack', async (req, res) => {
    guardMutation(req);
    const { code } = await readJson(req);
    notices.acknowledge(String(code || ''));
    broadcast();
    sendJson(res, 200, { ok: true });
  }],
];

// Read-only shims, so a tab left open across an app update does not poll a 404 forever. Every
// mutating route from the old API is gone rather than shimmed -- particularly
// `POST /api/control {action:'clear'}`, which was reachable cross-site and wiped the identity.
const LEGACY_READ = new Set(['/api/status', '/api/config']);
const LEGACY_WRITE = new Set(['/api/config', '/api/quote', '/api/swap', '/api/swap-cancel', '/api/control']);

function validateSwapInput(body) {
  const provider = String(body.provider || '').trim();
  if (!/^[a-z0-9]{45,70}$/i.test(provider)) throw httpError(400, 'INVALID', 'That does not look like a provider pubky.');
  const direction = body.direction === 'submarine' ? 'submarine' : 'reverse';
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > 1e12) throw httpError(400, 'INVALID', 'Enter an amount in sats.');
  return { provider, direction, amount };
}

// --- server ------------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return notFound(res); }
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) {
      // Only changes are gated. See lib/access.js: a wrong allow list should cost you a refused
      // action with an explanation, not a blank dashboard.
      if (req.method !== 'GET' && req.method !== 'HEAD' && !allowChange(req)) {
        return sendError(res, httpError(403, 'FORBIDDEN',
          'Changes are only accepted through Umbrel\'s proxy. The app log names the address to allow.'));
      }

      if (req.method === 'POST' && LEGACY_WRITE.has(path)) {
        return sendError(res, httpError(410, 'GONE', 'This endpoint has moved. Reload the page.'));
      }
      if (req.method === 'GET' && LEGACY_READ.has(path)) {
        return sendJson(res, 200, legacyView(path));
      }

      const route = routes.find(([method, p]) => method === req.method && p === path);
      if (!route) return sendError(res, httpError(404, 'NOT_FOUND', 'No such endpoint.'));
      return await route[2](req, res, url);
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, path);
    return sendError(res, httpError(405, 'INVALID', 'Method not allowed.'));
  } catch (e) {
    if (!res.headersSent) sendError(res, e);
    else res.destroy();
  }
});

/** Just enough of the old shape for a stale tab to notice it should reload. */
function legacyView(path) {
  const s = state();
  if (path === '/api/config') {
    return { ...s.settings, hasPubky: s.setup.configured, identityType: s.setup.identity, outdated: true };
  }
  return {
    configured: s.setup.configured,
    running: s.provider.running,
    pubky: s.provider.pubky || '',
    network: s.env.network,
    outdated: true,
    log: ['This panel has been updated. Reload the page.'],
  };
}

// Node defaults requestTimeout to 300s, which would silently cut every SSE stream at five minutes.
server.requestTimeout = 0;
server.headersTimeout = 60000;

async function bootstrap() {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const migrated = settings.migrateLegacy();
  if (migrated) notices.raise(migrated);
  redactor.refresh();

  logs.note(`Pubky Swap control panel on port ${PORT} (network ${engine.NETWORK}).`);

  // Before anything can start a new swap: records left outside the volume by an older build hold
  // the only key that can recover the funds in them.
  const rescued = taker.rescueStranded();
  if (rescued) logs.note(`Recovered ${rescued} swap record(s) from outside the data volume.`, 'WARN');

  const cfg = settings.load();
  const open = taker.unfinished();
  if (open.length) {
    logs.note(`${open.length} swap(s) from an earlier run are unfinished; driving them.`, 'WARN');
    taker.resume().catch(() => {});
  }

  // A taker-only install never starts a provider. The old panel had no notion of a role, so anyone
  // who only wanted to swap their own funds still ended up advertising to the network.
  if (secrets.isConfigured() && cfg.role !== 'taker') {
    provider.start().then(broadcast);
  } else if (!secrets.isConfigured()) {
    logs.note('No identity loaded yet. Open the panel to finish setup.');
  }

  server.listen(PORT, () => logs.note('Ready.'));
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  sse.closeAll();
  statusClient.stop();
  await Promise.race([
    Promise.all([provider.stop(), taker.cancel({ force: true }).catch(() => {})]),
    new Promise((r) => setTimeout(r, 25000)),
  ]);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

bootstrap();
