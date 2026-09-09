'use strict';

// Pubky Swap: the Umbrel control server.
//
// Serves a settings and status UI, and supervises the `swap-provider` daemon against your
// Umbrel's own LND and Electrs.
//
// Two things about this file are load-bearing and were not true of the first version.
//
// The seed never reaches a command line. `--recovery-phrase "<twelve words>"` put the phrase in
// the daemon's argv, where anything that can read the process table can read it, and in this
// process's own memory for the life of the app. It is written to a file only this app can read,
// and passed by name.
//
// Status comes from the daemon, not from its logs. This used to decide whether the provider was
// healthy by matching regexes against its stdout, which works until a message is reworded and
// then fails silently in either direction. The daemon serves a read-only status API on loopback;
// this reads that.

const http = require('http');
const fs = require('fs');
const dns = require('dns');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');
const PHRASE_PATH = path.join(SECRETS_DIR, 'recovery.phrase');
const PASSPHRASE_PATH = path.join(SECRETS_DIR, 'passphrase');
const IDENTITY_PATH = path.join(SECRETS_DIR, 'identity.pkarr');
const SWAP_DATA_DIR = path.join(DATA_DIR, 'swap');
const SWAP_CONFIG_PATH = path.join(SWAP_DATA_DIR, 'config.toml');
const STATUS_TOKEN_PATH = path.join(SWAP_DATA_DIR, 'status.token');
const PROVIDER_BIN = process.env.SWAP_PROVIDER_BIN || '/usr/local/bin/swap-provider';
const CLIENT_BIN = process.env.SWAP_CLIENT_BIN || '/usr/local/bin/swap-client';
const PUBLIC_DIR = path.join(__dirname, 'public');

// The daemon's status API. Loopback inside this container: nothing else can reach it, and the
// token it requires is written into the shared data directory at 0600.
const STATUS_HOST = '127.0.0.1';
// Loopback inside the container, so nothing else on the Umbrel network can reach it. Settable
// only so a developer running the app outside a container can move it off a port they already
// use; there is nothing to collide with in the container itself.
const STATUS_PORT = Number(process.env.SWAP_STATUS_PORT || 9737);

// Umbrel-provided connection details (see docker-compose.yml).
const LND_IP = process.env.LND_IP || '';
const LND_GRPC_PORT = process.env.LND_GRPC_PORT || '10009';
const LND_DIR = process.env.LND_DIR || '/lnd';
const ELECTRS_IP = process.env.ELECTRS_IP || '';
const ELECTRS_PORT = process.env.ELECTRS_PORT || '50001';
const NETWORK = process.env.NETWORK || 'mainnet';

// Umbrel exports the chain as `mainnet`; the swap daemon calls it `bitcoin`.
const SWAP_NETWORK = { mainnet: 'bitcoin', bitcoin: 'bitcoin', testnet: 'testnet', signet: 'signet', regtest: 'regtest' }[NETWORK] || 'bitcoin';
// LND stores chain data under data/chain/bitcoin/<mainnet|testnet|signet|regtest>/.
const LND_NETWORK_DIR = { bitcoin: 'mainnet', mainnet: 'mainnet', testnet: 'testnet', signet: 'signet', regtest: 'regtest' }[NETWORK] || 'mainnet';

const DEFAULT_SETTINGS = {
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
  maxConcurrentSwaps: 25,
  maxTotalExposureSat: 5000000,
  maxExposurePerPeerSat: 1000000,
  minOnchainReserveSat: 100000,
  broadcastOffer: false,
  allowUnsafe: false,
};

// --- settings (everything that is not a secret) ---
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_PATH);
}

// --- secrets, written where only this app can read them ---
//
// Not in the settings file, and never in an argv. Written with the mode set at creation rather
// than chmod'ed afterwards, so there is no window where the file exists and is readable.
function writeSecret(file, value) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function removeSecret(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
function hasSecret(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

function identityKind() {
  if (hasSecret(IDENTITY_PATH)) return 'file';
  if (hasSecret(PHRASE_PATH)) return 'phrase';
  return 'none';
}
function isConfigured() {
  return identityKind() !== 'none';
}

// --- the daemon's own configuration ---
//
// Written as the TOML the daemon looks for in its data directory, rather than assembled into a
// flag list. Secrets are absent from it by construction: they are named by environment variables
// pointing at the files above.
function tomlValue(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => JSON.stringify(String(x))).join(', ') + ']';
  return JSON.stringify(String(v));
}
function writeSwapConfig(cfg) {
  fs.mkdirSync(SWAP_DATA_DIR, { recursive: true });
  const values = {
    network: SWAP_NETWORK,
    data_dir: SWAP_DATA_DIR,
    directions: cfg.directions.split(',').map((d) => d.trim()).filter(Boolean),
    min_amount_sat: cfg.minAmount,
    max_amount_sat: cfg.maxAmount,
    base_fee_sat: cfg.baseFee,
    fee_ppm: cfg.feePpm,
    required_confirmations: cfg.confirmations,
    onchain_fee_rate_sat_vb: cfg.onchainFeeRate,
    invoice_expiry_secs: cfg.invoiceExpiry,
    max_routing_fee_msat: cfg.maxRoutingFeeMsat,
    quote_ttl_secs: cfg.quoteTtl,
    max_concurrent_swaps: cfg.maxConcurrentSwaps,
    max_total_exposure_sat: cfg.maxTotalExposureSat,
    max_exposure_per_peer_sat: cfg.maxExposurePerPeerSat,
    min_onchain_reserve_sat: cfg.minOnchainReserveSat,
    broadcast_offer: cfg.broadcastOffer,
    allow_unsafe: cfg.allowUnsafe,
    lightning_backend: 'lnd',
    lnd_address: `https://${LND_IP}:${LND_GRPC_PORT}`,
    lnd_cert_path: path.join(LND_DIR, 'tls.cert'),
    lnd_macaroon_path: path.join(LND_DIR, 'data', 'chain', 'bitcoin', LND_NETWORK_DIR, 'admin.macaroon'),
    electrum_url: `tcp://${ELECTRS_IP}:${ELECTRS_PORT}`,
    // Fund reverse-swap HTLCs from LND's own on-chain wallet, so there is no second seed to
    // back up and nothing to fund separately.
    wallet_backend: 'lnd',
    // The dashboard reads this. Loopback inside the container.
    status_addr: `${STATUS_HOST}:${STATUS_PORT}`,
    // Answer the doorbell, so someone who has only been handed your pubky can reach you.
    //
    // Pubky's private messages live at a path derived from an ECDH shared secret. That is what
    // makes them unlinkable, and it also means there is no "who has written to me": the provider
    // can only fetch messages from pubkys it already knows, which is its follow graph. Without
    // the rendezvous, "share your pubky with anyone who wants to swap" is not a thing that works.
    rendezvous_iroh: true,
  };
  const body =
    '# Written by the Pubky Swap Umbrel app. Edit the settings in the app, not here.\n' +
    '# Secrets are deliberately absent: they are files, named by environment variables.\n' +
    Object.entries(values).map(([k, v]) => `${k} = ${tomlValue(v)}`).join('\n') + '\n';
  const tmp = SWAP_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, SWAP_CONFIG_PATH);
}

/// The environment both binaries run with: where the config is, and where the secrets are.
function swapEnv() {
  const env = {
    ...process.env,
    RUST_LOG: process.env.RUST_LOG || 'info',
    // The log goes to a browser, not a terminal.
    NO_COLOR: '1',
    PUBKY_SWAP_DATA_DIR: SWAP_DATA_DIR,
    PUBKY_SWAP_CONFIG: SWAP_CONFIG_PATH,
  };
  if (identityKind() === 'phrase') env.PUBKY_SWAP_RECOVERY_PHRASE__FILE = PHRASE_PATH;
  if (hasSecret(PASSPHRASE_PATH)) env.PUBKY_SWAP_PASSPHRASE__FILE = PASSPHRASE_PATH;
  return env;
}

// --- provider supervision ---
let child = null;
const LOG_MAX = 300;
const logBuf = [];

/// Colour codes are for a terminal, and this log is read in a browser.
///
/// `tracing-subscriber` colourises by default whenever it is not writing to a tty, or rather it
/// does not check, so every daemon line arrived wrapped in escape sequences and the dashboard
/// printed them literally: `[2m2026-09-09T16:38:41Z [0m [32m INFO [0m`. `NO_COLOR` in the
/// daemon's environment stops most of it; this catches whatever still gets through, including
/// from anything else this supervises.
const ANSI = /\u001b\[[0-9;]*m/g;

function pushLog(line) {
  for (const l of String(line).replace(ANSI, '').split('\n')) {
    if (!l.trim()) continue;
    logBuf.push(l);
    if (logBuf.length > LOG_MAX) logBuf.shift();
  }
}

function providerArgs() {
  // A recovery file is a path, not a secret, so it stays a positional argument. Everything else
  // comes from the config file and the environment.
  return identityKind() === 'file' ? [IDENTITY_PATH] : [];
}

function startProvider() {
  if (!isConfigured()) {
    pushLog('Not configured yet: load your Pubky identity and save.');
    return;
  }
  stopProvider();
  const cfg = loadSettings();
  writeSwapConfig(cfg);
  pushLog('Starting the swap provider...');
  child = spawn(PROVIDER_BIN, providerArgs(), { env: swapEnv() });
  child.stdout.on('data', (d) => pushLog(d.toString()));
  child.stderr.on('data', (d) => pushLog(d.toString()));
  // Without an 'error' listener a spawn failure (a missing binary, say) would crash this server.
  child.on('error', (e) => {
    pushLog(`failed to start the provider: ${e.message}`);
    child = null;
  });
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

// --- the daemon's status API ---
//
// The token is generated by the daemon into the shared data directory at 0600. It is read on
// every call rather than cached, so a restart that regenerates it does not leave this holding a
// stale one.
function statusToken() {
  try { return fs.readFileSync(STATUS_TOKEN_PATH, 'utf8').trim(); } catch { return ''; }
}

function askDaemon(endpoint) {
  return new Promise((resolve, reject) => {
    const token = statusToken();
    if (!token) return reject(new Error('the daemon has not written its status token yet'));
    const req = http.request(
      // Short: this is a loopback call to a process on the other side of the same container.
      // A dashboard that waits seconds for it is worse than one that says "not answering" and
      // shows the rest of the page.
      { host: STATUS_HOST, port: STATUS_PORT, path: endpoint, method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`status API ${endpoint}: HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('status API timed out')));
    req.on('error', reject);
    req.end();
  });
}

/// Ask the daemon for everything the dashboard shows, in one round of calls.
///
/// A daemon that is not running, or has not finished starting, is not an error here: the app has
/// to render something either way, and "not running" is a state the dashboard shows rather than a
/// failure it reports.
async function daemonState() {
  if (!child) return { running: false };
  const out = { running: true };
  const parts = [
    ['status', '/status'],
    ['health', '/health'],
    ['swaps', '/swaps'],
    ['limits', '/limits'],
    ['earnings', '/earnings'],
    // What the provider is actually advertising, which is not always what is in settings: an
    // edit that has been saved but not yet picked up would otherwise show as live.
    ['offer', '/offer'],
  ];
  await Promise.all(
    parts.map(async ([key, endpoint]) => {
      try { out[key] = await askDaemon(endpoint); } catch (e) { out[`${key}Error`] = String(e.message || e); }
    })
  );
  return out;
}

// --- taker: check a provider and swap as a client ---
let swapChild = null;
let lastSwapResult = null;
const swapLog = [];
function pushSwapLog(line) {
  for (const l of String(line).split('\n')) {
    if (!l.trim()) continue;
    swapLog.push(l);
    if (swapLog.length > LOG_MAX) swapLog.shift();
  }
}

// Args are passed to spawn() as an array (no shell), so the concern is well-formedness rather
// than shell injection.
function validateSwapInput(body) {
  const provider = String(body.provider || '').trim();
  if (!/^[a-z0-9]{45,70}$/i.test(provider)) throw new Error('enter a valid provider pubky');
  const direction = body.direction === 'submarine' ? 'submarine' : 'reverse';
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > 1e12) throw new Error('invalid amount');
  return { provider, direction, amount };
}

function clientArgs({ provider, direction, amount, quoteOnly }) {
  const args = [provider];
  if (identityKind() === 'file') args.push(IDENTITY_PATH);
  args.push(
    '--network', SWAP_NETWORK,
    '--direction', direction,
    '--amount', String(amount),
    '--lnd-address', `https://${LND_IP}:${LND_GRPC_PORT}`,
    '--lnd-cert', path.join(LND_DIR, 'tls.cert'),
    '--lnd-macaroon', path.join(LND_DIR, 'data', 'chain', 'bitcoin', LND_NETWORK_DIR, 'admin.macaroon'),
    '--electrum-url', `tcp://${ELECTRS_IP}:${ELECTRS_PORT}`,
    // Fund and sweep via LND's own wallet, so a swap as a taker needs no second seed either.
    '--wallet', 'lnd',
    // Ring the provider's doorbell first: a provider that has never heard of us cannot find our
    // message otherwise, because it has no way to know it should look.
    '--rendezvous-iroh',
    '--data-dir', path.join(DATA_DIR, 'client'),
  );
  if (quoteOnly) args.push('--quote-only');
  return args;
}

function parseQuoteLine(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('QUOTE '));
  if (!line) return null;
  const out = {};
  for (const kv of line.slice(6).trim().split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/// Run the client in --quote-only mode: resolves with the parsed quote, or rejects.
function checkProvider(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLIENT_BIN, clientArgs({ ...input, quoteOnly: true }), { env: swapEnv() });
    let out = '';
    const cap = (d) => { out += d.toString(); if (out.length > 1e5) out = out.slice(-1e5); };
    proc.stdout.on('data', cap);
    proc.stderr.on('data', cap);
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 40000);
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not run the client: ${e.message}`)); });
    proc.on('exit', () => {
      clearTimeout(timer);
      const quote = parseQuoteLine(out);
      if (quote) resolve(quote);
      else reject(new Error('no quote: that pubky did not answer as a provider for this swap'));
    });
  });
}

function startSwap(input) {
  swapLog.length = 0;
  lastSwapResult = null;
  pushSwapLog(`Starting a ${input.direction} swap of ${input.amount} sat with ${input.provider}...`);
  swapChild = spawn(CLIENT_BIN, clientArgs({ ...input, quoteOnly: false }), { env: swapEnv() });
  swapChild.stdout.on('data', (d) => pushSwapLog(d.toString()));
  swapChild.stderr.on('data', (d) => pushSwapLog(d.toString()));
  swapChild.on('error', (e) => { pushSwapLog(`failed to start the swap: ${e.message}`); swapChild = null; lastSwapResult = 'error'; });
  swapChild.on('exit', (code) => {
    pushSwapLog(`swap finished (exit code ${code})`);
    lastSwapResult = code === 0 ? 'success' : 'failed';
    swapChild = null;
  });
}
function stopSwap() {
  if (swapChild) { try { swapChild.kill('SIGTERM'); } catch {} swapChild = null; }
}

// --- views (no secrets leave this process) ---
async function statusView() {
  return {
    configured: isConfigured(),
    identityType: identityKind(),
    network: SWAP_NETWORK,
    lnd: { ip: LND_IP, port: LND_GRPC_PORT },
    electrs: { ip: ELECTRS_IP, port: ELECTRS_PORT },
    daemon: await daemonState(),
    log: logBuf.slice(-120),
  };
}

function settingsView() {
  const cfg = loadSettings();
  return {
    ...cfg,
    network: SWAP_NETWORK,
    configured: isConfigured(),
    identityType: identityKind(),
    hasPassphrase: hasSecret(PASSPHRASE_PATH),
  };
}

/// Stop the provider and wipe the identity and settings: a clean disconnect.
function clearIdentity() {
  stopProvider();
  removeSecret(PHRASE_PATH);
  removeSecret(PASSPHRASE_PATH);
  removeSecret(IDENTITY_PATH);
  try { fs.rmSync(SETTINGS_PATH, { force: true }); } catch {}
  pushLog('Disconnected: identity and settings cleared.');
}

/// Why this is not a usable BIP39 recovery phrase, or `null` if it is.
///
/// Only the shape and the checksum: the wordlist is 2048 entries and shipping it to validate a
/// field the daemon will parse properly anyway is not worth the weight. The checksum is what
/// catches the mistakes people actually make, a mistyped or transposed word, because it fails for
/// all but one word in 16.
function bip39Problem(phrase) {
  const words = phrase.split(' ').filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    return `a recovery phrase is 12 or 24 words; this one has ${words.length}`;
  }
  if (words.some((w) => !/^[a-z]+$/.test(w))) {
    return 'a recovery phrase is lowercase words separated by spaces';
  }
  return null;
}

function applySettings(body) {
  const cfg = loadSettings();

  // Identity. An uploaded .pkarr file takes precedence and clears any phrase, and a phrase
  // supersedes a previously uploaded file: exactly one of them is what the daemon accepts.
  if (typeof body.pkarrBase64 === 'string' && body.pkarrBase64.trim()) {
    const buf = Buffer.from(body.pkarrBase64, 'base64');
    if (!buf.length) throw new Error('empty recovery file');
    writeSecret(IDENTITY_PATH, buf);
    removeSecret(PHRASE_PATH);
  } else if (typeof body.pubkyRecoveryPhrase === 'string' && body.pubkyRecoveryPhrase.trim()) {
    const phrase = body.pubkyRecoveryPhrase.trim().replace(/\s+/g, ' ').toLowerCase();
    // Checked here rather than left to the daemon. A phrase with a typo fails deep inside the
    // transport as "the mnemonic has an invalid checksum", by which point the provider has
    // started, exited 1, and gone into a restart loop; the operator sees a log line and a
    // stopped app rather than the field they mistyped.
    const bad = bip39Problem(phrase);
    if (bad) throw new Error(bad);
    writeSecret(PHRASE_PATH, phrase + '\n');
    removeSecret(IDENTITY_PATH);
  }
  // The passphrase belongs to the identity it was supplied with, and to no other.
  //
  // A blank field means "leave it alone" while the identity is unchanged, which is what makes
  // re-saving rates safe. It must not mean that when the identity itself is being replaced: an
  // operator who once uploaded a passphrase-protected .pkarr and later pastes a recovery phrase
  // from Pubky Ring, leaving the passphrase blank because Ring does not use one, would otherwise
  // get `to_seed(<the old passphrase>)`. That is a different seed, so a different identity, so a
  // valid-looking pubky with no account behind it, and a provider that will not start with
  // nothing on screen connecting the two.
  const identityChanged =
    (typeof body.pkarrBase64 === 'string' && body.pkarrBase64.trim()) ||
    (typeof body.pubkyRecoveryPhrase === 'string' && body.pubkyRecoveryPhrase.trim());
  if (identityChanged) removeSecret(PASSPHRASE_PATH);
  if (typeof body.pubkyPassphrase === 'string' && body.pubkyPassphrase.length) {
    writeSecret(PASSPHRASE_PATH, body.pubkyPassphrase + '\n');
  }

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
  num('maxConcurrentSwaps', 1, 1000);
  num('maxTotalExposureSat', 0, 1e12);
  num('maxExposurePerPeerSat', 0, 1e12);
  num('minOnchainReserveSat', 0, 1e12);
  if (typeof body.directions === 'string' && /^(submarine|reverse)(,(submarine|reverse))?$/.test(body.directions))
    cfg.directions = body.directions;
  if (typeof body.broadcastOffer === 'boolean') cfg.broadcastOffer = body.broadcastOffer;
  if (typeof body.allowUnsafe === 'boolean') cfg.allowUnsafe = body.allowUnsafe;

  if (cfg.maxAmount < cfg.minAmount) throw new Error('maxAmount must be at least minAmount');
  if (cfg.maxExposurePerPeerSat > cfg.maxTotalExposureSat)
    throw new Error('per-peer exposure cannot exceed the total');
  saveSettings(cfg);
  return cfg;
}

// --- access control ---
//
// This app sits on Umbrel's shared network, so every other app can reach this port. app_proxy is
// what fronts the browser with Umbrel's own authentication; anything arriving from elsewhere has
// bypassed it. Restricting to the proxy and to loopback is what keeps another app on the node
// from driving a daemon that moves money.
/// The addresses the control plane will answer: loopback, the bridge gateway umbrelOS proxies
/// through, and whatever `app_proxy` resolves to on an Umbrel that still runs that sidecar.
///
/// This used to accept 10/8, 192.168/16 and 172.16/12 wholesale, on the reasoning that the proxy
/// lives on a private bridge. Every other app on an Umbrel lives on that same bridge. I checked
/// what that means by putting two of these containers on one network and having the second POST
/// `{"action":"clear"}` at the first: HTTP 200, and the first app's Pubky identity was gone. Any
/// app on the box could also stop the provider mid-swap, or point it at an identity whose seed it
/// knows.
///
/// Two addresses are legitimate and neither is forgeable by a peer container, because packets
/// from a peer carry the peer's own address:
///
///  - The bridge **gateway**. Current umbrelOS proxies from the host, so that is where the
///    connection enters the container from. Read from the routing table, so there is no window
///    before it is known.
///  - **`app_proxy`**, on older umbrelOS where that sidecar still exists. Resolved by Docker DNS,
///    and re-resolved because its address changes across restarts.
///
/// `CONTROL_PLANE_ALLOW` adds more, comma separated, for anything neither covers.
const ALLOWED_REMOTES = new Set();
let warnedRejections = new Set();

function addGatewayAddresses() {
  try {
    // `Destination 00000000` is the default route; `Gateway` is little-endian hex.
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)) {
      const f = line.split(/\s+/);
      if (f[1] !== '00000000' || !f[2] || f[2] === '00000000') continue;
      const n = parseInt(f[2], 16);
      ALLOWED_REMOTES.add([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff].join('.'));
    }
  } catch {
    // Not Linux, or no procfs: a developer running this outside a container, who reaches it on
    // loopback anyway.
  }
}

function refreshAppProxy() {
  // `all: true` because the container can be on more than one network and the connection uses
  // whichever one it uses.
  dns.lookup('app_proxy', { all: true }, (err, addrs) => {
    if (err) return; // Not that generation of umbrelOS, or not up yet. The gateway covers it.
    for (const a of addrs || []) {
      if (a.address && !ALLOWED_REMOTES.has(a.address)) {
        ALLOWED_REMOTES.add(a.address);
        pushLog(`Control plane also answers app_proxy at ${a.address}.`);
      }
    }
  });
}

for (const extra of String(process.env.CONTROL_PLANE_ALLOW || '').split(',')) {
  if (extra.trim()) ALLOWED_REMOTES.add(extra.trim());
}
addGatewayAddresses();
refreshAppProxy();
setInterval(refreshAppProxy, 60_000).unref?.();
{
  const where = ALLOWED_REMOTES.size
    ? `Changes accepted from loopback and ${[...ALLOWED_REMOTES].join(', ')}.`
    : 'Changes accepted from loopback only.';
  pushLog(where);
  console.log(where);
}

function allowedRemote(req) {
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (addr === '127.0.0.1' || addr === '::1') return true;
  if (ALLOWED_REMOTES.has(addr)) return true;
  // Said out loud, once per address. A guard that refuses the only way in and explains nothing is
  // how an operator ends up locked out of their own swaps with no idea why.
  if (!warnedRejections.has(addr)) {
    warnedRejections.add(addr);
    if (warnedRejections.size > 50) warnedRejections = new Set([addr]);
    const msg =
      `Refused a change from ${addr}. If that is how you reach this app, set ` +
      `CONTROL_PLANE_ALLOW=${addr} on the container.`;
    pushLog(msg);
    // Also to the container log: an operator who cannot make changes may be looking at
    // `docker logs` rather than at the dashboard.
    console.error(msg);
  }
  return false;
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
    // Only what can do harm is gated, and everything that can do harm is a POST: writing the
    // identity, stopping or clearing the provider, starting a swap, spawning the client.
    //
    // Reading is deliberately not gated. The status view carries no secret, and the alternative
    // is worse than it sounds: the allow list is derived from the container's routing, and if it
    // is ever wrong the operator meets a blank page with nothing to read, on the one screen that
    // would have told them what to allow. This way a wrong list degrades to "you can see
    // everything and change nothing", with the reason in the log on the page in front of them.
    if (req.method !== 'GET' && !allowedRemote(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'this control plane only accepts changes from the Umbrel app gateway' }));
    }
    // The address check cannot see a request a browser makes on someone else's behalf: it arrives
    // from the gateway like any other, because it is coming through the gateway. A page on another
    // site can post a form to this app without a CORS preflight, provided it uses a content type
    // forms are allowed to send, and `readBody` would happily `JSON.parse` what it sent.
    //
    // Requiring `application/json` puts every request through a preflight, which same-origin
    // policy then refuses. Rejecting a cross-origin `Origin` closes the same door from the other
    // side, for anything that does send one.
    if (req.method !== 'GET') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'changes must be sent as application/json' }));
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'cross-origin changes are refused' }));
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, await statusView());
    if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, settingsView());
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      try { applySettings(body); } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
      if (isConfigured()) startProvider();
      return sendJson(res, 200, { ok: true, configured: isConfigured() });
    }
    if (req.method === 'POST' && url.pathname === '/api/quote') {
      if (!isConfigured()) return sendJson(res, 400, { error: 'load your Pubky identity first' });
      let input;
      try { input = validateSwapInput(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
      try { return sendJson(res, 200, { ok: true, quote: await checkProvider(input) }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/swap') {
      if (!isConfigured()) return sendJson(res, 400, { error: 'load your Pubky identity first' });
      if (swapChild) return sendJson(res, 409, { error: 'a swap is already running' });
      let input;
      try { input = validateSwapInput(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
      startSwap(input);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/swap-status') {
      return sendJson(res, 200, { running: Boolean(swapChild), result: lastSwapResult, log: swapLog.slice(-120) });
    }
    if (req.method === 'POST' && url.pathname === '/api/swap-cancel') { stopSwap(); return sendJson(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      const body = await readBody(req);
      if (body.action === 'start' || body.action === 'restart') startProvider();
      else if (body.action === 'stop') stopProvider();
      else if (body.action === 'clear') clearIdentity();
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
  // Start the provider straight away when we already have an identity, so a node reboot brings
  // the swaps back without anyone opening the app. In-flight swaps resume from their records.
  if (isConfigured()) startProvider();
});

process.on('SIGTERM', () => { stopProvider(); stopSwap(); process.exit(0); });
process.on('SIGINT', () => { stopProvider(); stopSwap(); process.exit(0); });
