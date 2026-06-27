'use strict';

// Pubky Swap — Umbrel control server.
//
// Serves a small settings/status UI and supervises the `swap-provider` daemon: you load your Pubky,
// set your rates, and save; this starts the provider against your Umbrel's LND + Electrs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SWAP_DATA_DIR = path.join(DATA_DIR, 'swap');
const PROVIDER_BIN = process.env.SWAP_PROVIDER_BIN || '/usr/local/bin/swap-provider';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Umbrel-provided connection details (see docker-compose.yml).
const LND_IP = process.env.LND_IP || '';
const LND_GRPC_PORT = process.env.LND_GRPC_PORT || '10009';
const LND_DIR = process.env.LND_DIR || '/lnd';
const ELECTRS_IP = process.env.ELECTRS_IP || '';
const ELECTRS_PORT = process.env.ELECTRS_PORT || '50001';
const NETWORK = process.env.NETWORK || 'bitcoin';

// LND stores chain data under data/chain/bitcoin/<mainnet|testnet|signet|regtest>/.
const LND_NETWORK_DIR = { bitcoin: 'mainnet', testnet: 'testnet', signet: 'signet', regtest: 'regtest' }[NETWORK] || 'mainnet';

const DEFAULT_CONFIG = {
  pubkyRecoveryPhrase: '',
  pubkyPassphrase: '',
  directions: 'submarine,reverse',
  minAmount: 10000,
  maxAmount: 1000000,
  baseFee: 1000,
  feePpm: 2000,
  confirmations: 3,
  onchainFeeRate: 5,
  invoiceExpiry: 3600,
  maxRoutingFeeMsat: 10000,
  quoteTtl: 300,
  broadcastOffer: false,
  allowUnsafe: false,
};

// --- config persistence ---
function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}
function isConfigured(cfg) {
  // The funding wallet is LND's own on-chain wallet, so only the Pubky identity is needed.
  return Boolean(cfg.pubkyRecoveryPhrase);
}

// --- provider supervision ---
let child = null;
let providerPubky = '';
let lndConnected = false;
let executionCapable = false;
const LOG_MAX = 300;
const logBuf = [];

function pushLog(line) {
  for (const l of String(line).split('\n')) {
    if (!l.trim()) continue;
    logBuf.push(l);
    if (logBuf.length > LOG_MAX) logBuf.shift();
    parseLogLine(l);
  }
}
function parseLogLine(l) {
  let m = l.match(/Provider pubky:\s*(\S+)/);
  if (m) providerPubky = m[1];
  if (/Connected to LND node/.test(l)) lndConnected = true;
  if (/Lightning backend not ready|network mismatch/.test(l)) lndConnected = false;
  if (/execution-capable/.test(l)) executionCapable = true;
  if (/negotiation-only/.test(l)) executionCapable = false;
}

function providerArgs(cfg) {
  const args = [
    '--recovery-phrase', cfg.pubkyRecoveryPhrase,
    '--network', NETWORK,
    '--directions', cfg.directions,
    '--min-amount', String(cfg.minAmount),
    '--max-amount', String(cfg.maxAmount),
    '--base-fee', String(cfg.baseFee),
    '--fee-ppm', String(cfg.feePpm),
    '--confirmations', String(cfg.confirmations),
    '--onchain-fee-rate', String(cfg.onchainFeeRate),
    '--invoice-expiry', String(cfg.invoiceExpiry),
    '--max-routing-fee-msat', String(cfg.maxRoutingFeeMsat),
    '--quote-ttl', String(cfg.quoteTtl),
    '--lnd-address', `https://${LND_IP}:${LND_GRPC_PORT}`,
    '--lnd-cert', path.join(LND_DIR, 'tls.cert'),
    '--lnd-macaroon', path.join(LND_DIR, 'data', 'chain', 'bitcoin', LND_NETWORK_DIR, 'admin.macaroon'),
    '--electrum-url', `tcp://${ELECTRS_IP}:${ELECTRS_PORT}`,
    // Fund reverse-swap HTLCs from LND's own on-chain wallet (no separate seed).
    '--wallet', 'lnd',
    '--data-dir', SWAP_DATA_DIR,
  ];
  if (cfg.pubkyPassphrase) args.push('--pass', cfg.pubkyPassphrase);
  if (cfg.broadcastOffer) args.push('--broadcast-offer');
  if (cfg.allowUnsafe) args.push('--allow-unsafe');
  return args;
}

function startProvider() {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) {
    pushLog('Not configured yet — load your Pubky and set your rates, then Save.');
    return;
  }
  stopProvider();
  providerPubky = '';
  lndConnected = false;
  executionCapable = false;
  fs.mkdirSync(SWAP_DATA_DIR, { recursive: true });
  pushLog('Starting pubky-swap provider...');
  child = spawn(PROVIDER_BIN, providerArgs(cfg), {
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'info' },
  });
  child.stdout.on('data', (d) => pushLog(d.toString()));
  child.stderr.on('data', (d) => pushLog(d.toString()));
  child.on('exit', (code, sig) => {
    pushLog(`provider exited (code=${code} signal=${sig || ''})`);
    child = null;
  });
}
function stopProvider() {
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    child = null;
  }
}

// --- status / config views (no secrets leaked) ---
function statusView() {
  const cfg = loadConfig();
  return {
    configured: isConfigured(cfg),
    running: Boolean(child),
    pubky: providerPubky,
    network: NETWORK,
    lnd: { ip: LND_IP, port: LND_GRPC_PORT, connected: lndConnected },
    electrs: { ip: ELECTRS_IP, port: ELECTRS_PORT },
    executionCapable,
    rates: {
      directions: cfg.directions,
      minAmount: cfg.minAmount,
      maxAmount: cfg.maxAmount,
      baseFee: cfg.baseFee,
      feePpm: cfg.feePpm,
    },
    log: logBuf.slice(-120),
  };
}
function configView() {
  const cfg = loadConfig();
  return {
    network: NETWORK,
    directions: cfg.directions,
    minAmount: cfg.minAmount,
    maxAmount: cfg.maxAmount,
    baseFee: cfg.baseFee,
    feePpm: cfg.feePpm,
    confirmations: cfg.confirmations,
    onchainFeeRate: cfg.onchainFeeRate,
    invoiceExpiry: cfg.invoiceExpiry,
    maxRoutingFeeMsat: cfg.maxRoutingFeeMsat,
    quoteTtl: cfg.quoteTtl,
    broadcastOffer: cfg.broadcastOffer,
    allowUnsafe: cfg.allowUnsafe,
    hasPubky: Boolean(cfg.pubkyRecoveryPhrase),
  };
}

function applyConfig(body) {
  const cfg = loadConfig();
  // Secrets: only overwrite when a non-empty value is supplied (so re-saving doesn't wipe them).
  if (typeof body.pubkyRecoveryPhrase === 'string' && body.pubkyRecoveryPhrase.trim())
    cfg.pubkyRecoveryPhrase = body.pubkyRecoveryPhrase.trim();
  if (typeof body.pubkyPassphrase === 'string') cfg.pubkyPassphrase = body.pubkyPassphrase;

  const num = (k, min, max) => {
    if (body[k] === undefined || body[k] === null || body[k] === '') return;
    const v = Math.floor(Number(body[k]));
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`invalid ${k}`);
    cfg[k] = v;
  };
  num('minAmount', 1, 1e12);
  num('maxAmount', 1, 1e12);
  num('baseFee', 0, 1e9);
  num('feePpm', 0, 1e7);
  num('confirmations', 1, 100);
  num('onchainFeeRate', 1, 1000);
  num('invoiceExpiry', 60, 86400);
  num('maxRoutingFeeMsat', 0, 1e12);
  num('quoteTtl', 30, 86400);
  if (typeof body.directions === 'string' && /^(submarine|reverse)(,(submarine|reverse))?$/.test(body.directions))
    cfg.directions = body.directions;
  if (typeof body.broadcastOffer === 'boolean') cfg.broadcastOffer = body.broadcastOffer;
  if (typeof body.allowUnsafe === 'boolean') cfg.allowUnsafe = body.allowUnsafe;

  if (cfg.maxAmount < cfg.minAmount) throw new Error('maxAmount must be >= minAmount');
  saveConfig(cfg);
  return cfg;
}

// --- tiny HTTP layer ---
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, statusView());
    if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, configView());
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      let cfg;
      try { cfg = applyConfig(body); } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
      if (isConfigured(cfg)) startProvider();
      return sendJson(res, 200, { ok: true, configured: isConfigured(cfg) });
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      const body = await readBody(req);
      if (body.action === 'start' || body.action === 'restart') startProvider();
      else if (body.action === 'stop') stopProvider();
      else return sendJson(res, 400, { error: 'unknown action' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    res.writeHead(405); res.end('method not allowed');
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  pushLog(`Pubky Swap control panel on :${PORT}`);
  // Auto-start the provider if we're already configured (e.g. after a restart).
  if (isConfigured(loadConfig())) startProvider();
});

process.on('SIGTERM', () => { stopProvider(); process.exit(0); });
process.on('SIGINT', () => { stopProvider(); process.exit(0); });
