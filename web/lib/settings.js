'use strict';

// Rates, limits and preferences. Never secrets.
//
// The pre-facelift file was `config.json` and it held the recovery phrase and passphrase in
// plaintext alongside the fee settings. `migrateLegacy()` splits those apart on first boot: the
// secrets move into 0600 files under /data/secrets, everything else lands here, and the old file
// is overwritten and removed.

const fs = require('fs');
const paths = require('./paths');
const secrets = require('./secrets');
const { writeAtomic, scrub } = require('./atomic');

const NETWORK = process.env.NETWORK || 'bitcoin';
const IS_MAINNET = NETWORK === 'bitcoin';

/**
 * Defaults, chosen for the network this node is actually on.
 *
 * The amount floor is the one worth explaining. Upstream advertises
 * `max(min_amount_sat, onchain_fee_sat * 10)` and re-prices the on-chain half against a live fee
 * estimate, so a 10,000 sat minimum is a number that is simply not true most of the time on
 * mainnet -- at 30 sat/vB the real floor is nearer 70,000. Defaulting to 100,000 means the
 * advertised minimum is usually the configured one, and the operator is not surprised by a floor
 * they never set. On a test network the fee pressure does not exist, so the small numbers stand.
 *
 * Confirmations and the fee floor are the mainnet minimums upstream enforces; below them it
 * refuses to start unless `allowUnsafe` is set.
 */
const DEFAULTS = {
  // What the operator said they wanted this app for, asked before anything else in setup.
  // 'earn' | 'taker' | 'both'. A taker-only install never auto-starts the provider.
  role: 'both',

  directions: 'submarine,reverse',
  minAmount: IS_MAINNET ? 100000 : 10000,
  maxAmount: 1000000,
  baseFee: IS_MAINNET ? 1000 : 100,
  feePpm: 2500,
  confirmations: IS_MAINNET ? 2 : 1,
  onchainFeeRate: IS_MAINNET ? 5 : 2,
  timeoutBlocks: 144,
  invoiceExpiry: 3600,
  maxRoutingFeeMsat: 10000,
  quoteTtl: 300,
  broadcastOffer: false,
  allowUnsafe: false,

  // Risk ceilings, seeded from upstream's current defaults. There is no editor for these yet, but
  // pinning them means an upstream default change cannot silently move a live operator's exposure,
  // and the Overview meter's denominator is the number actually in force.
  maxConcurrentSwaps: 25,
  maxConcurrentPerPeer: 2,
  maxTotalExposureSat: 5000000,
  maxExposurePerPeerSat: 1000000,
  minOnchainReserveSat: 100000,
  maxNewSwapsPerPeerPerHour: 6,

  // Taker-side guards. These are the operator's own protections, not the provider's.
  takerMaxFeeBps: 500,
  takerMaxTotalSat: 0,
  takerMinConfirmations: IS_MAINNET ? 2 : 1,
  takerClaimAddress: '',

  // Off by default: following a txid to a block explorer tells a third party which transactions
  // belong to this node, which is a strange default for a self-hosted privacy tool. Txids stay
  // copyable either way.
  explorerLinks: false,

  // Set once the guided setup has been completed, so a half-finished setup is resumable.
  setupComplete: false,
};

const NUMERIC = {
  minAmount: [1, 1e12],
  maxAmount: [1, 1e12],
  baseFee: [0, 1e9],
  feePpm: [0, 1e7],
  confirmations: [1, 12],
  onchainFeeRate: [1, 1000],
  timeoutBlocks: [18, 1008],
  invoiceExpiry: [60, 86400],
  maxRoutingFeeMsat: [0, 1e12],
  quoteTtl: [30, 3600],
  maxConcurrentSwaps: [1, 1000],
  maxConcurrentPerPeer: [1, 100],
  maxTotalExposureSat: [0, 1e12],
  maxExposurePerPeerSat: [0, 1e12],
  minOnchainReserveSat: [0, 1e12],
  maxNewSwapsPerPeerPerHour: [1, 1000],
  takerMaxFeeBps: [0, 10000],
  takerMaxTotalSat: [0, 1e12],
  takerMinConfirmations: [1, 12],
};

const BOOLEAN = ['broadcastOffer', 'allowUnsafe', 'explorerLinks', 'setupComplete'];

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(paths.settings, 'utf8')); } catch {}
  cache = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  return cache;
}

function save(next) {
  writeAtomic(paths.settings, JSON.stringify(next, null, 2) + '\n', 0o600);
  cache = next;
  return cache;
}

/** Drop the in-memory copy, so the next load re-reads from disk. */
function invalidate() { cache = null; }

/**
 * Merge a patch of user-supplied values, validating each.
 *
 * Absent keys are left alone rather than reset. That is what lets the UI send only what changed,
 * and it is why a cleared number field must arrive as `undefined` rather than as 0 -- the old UI
 * coerced empty inputs with `Number('')` and every save of a blank advanced field failed with a
 * flat "invalid confirmations".
 */
function apply(patch) {
  const cfg = { ...load() };
  const body = patch && typeof patch === 'object' ? patch : {};

  for (const [key, [min, max]] of Object.entries(NUMERIC)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${label(key)} must be between ${min} and ${max}`);
    }
    cfg[key] = value;
  }

  for (const key of BOOLEAN) {
    if (typeof body[key] === 'boolean') cfg[key] = body[key];
  }

  if (typeof body.role === 'string' && ['earn', 'taker', 'both'].includes(body.role)) {
    cfg.role = body.role;
  }
  if (typeof body.directions === 'string' &&
      /^(submarine|reverse)(,(submarine|reverse))?$/.test(body.directions) &&
      new Set(body.directions.split(',')).size === body.directions.split(',').length) {
    cfg.directions = body.directions;
  }
  if (typeof body.takerClaimAddress === 'string') {
    const addr = body.takerClaimAddress.trim();
    if (addr && !/^[a-z0-9]{14,90}$/i.test(addr)) throw new Error('that does not look like a Bitcoin address');
    cfg.takerClaimAddress = addr;
  }

  if (cfg.maxAmount < cfg.minAmount) throw new Error('the largest swap must be at least the smallest');
  return save(cfg);
}

function label(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase();
}

/**
 * Move a pre-facelift config.json into the split layout, once.
 *
 * Guarded by the existence of settings.json and idempotent, so an interrupted run re-runs safely:
 * every write is atomic and the scrub of the old file happens last.
 *
 * Returns a notice to show the operator, or null. The notice says out loud that the phrase is
 * already in every Umbrel backup taken before this update, because it is, and no amount of local
 * scrubbing changes that.
 */
function migrateLegacy() {
  if (fs.existsSync(paths.settings)) return null;
  if (!fs.existsSync(paths.legacyConfig)) { save({ ...DEFAULTS }); return null; }

  let legacy = {};
  try { legacy = JSON.parse(fs.readFileSync(paths.legacyConfig, 'utf8')) || {}; } catch {}

  let movedSecret = false;
  try {
    if (typeof legacy.pubkyRecoveryPhrase === 'string' && legacy.pubkyRecoveryPhrase.trim()) {
      secrets.writePhrase(legacy.pubkyRecoveryPhrase);
      movedSecret = true;
    }
    if (typeof legacy.pubkyPassphrase === 'string' && legacy.pubkyPassphrase) {
      secrets.writePassphrase(legacy.pubkyPassphrase);
      movedSecret = true;
    }
  } catch { /* a malformed legacy secret is not worth failing a boot over */ }

  if (fs.existsSync(paths.legacyIdentity)) {
    secrets.ensureDir();
    try { fs.renameSync(paths.legacyIdentity, paths.recoveryFile); }
    catch { // EXDEV, if /data/secrets ever lands on another device
      try {
        fs.copyFileSync(paths.legacyIdentity, paths.recoveryFile);
        fs.rmSync(paths.legacyIdentity, { force: true });
      } catch {}
    }
    try { fs.chmodSync(paths.recoveryFile, 0o600); } catch {}
    // A phrase and a file cannot coexist; the uploaded file was what the old app preferred.
    if (secrets.identityKind() === 'file') secrets.clearPhrase();
  }

  const carried = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (legacy[key] !== undefined) carried[key] = legacy[key];
  }
  // The old app had no role, and it always ran a provider. Keep that behaviour for an upgrade.
  carried.role = 'both';
  carried.setupComplete = secrets.isConfigured();
  save({ ...DEFAULTS, ...carried });

  scrub(paths.legacyConfig);
  scrub(paths.legacyConfigTmp);

  if (!movedSecret) return null;
  return {
    level: 'warn',
    code: 'SECRETS_MIGRATED',
    message: 'Your recovery phrase was moved out of config.json, where it was stored in plain ' +
      'text, into /data/secrets/recovery.phrase with owner-only permissions. The old file has ' +
      'been removed.',
    remedy: 'Any Umbrel backup taken before this update still contains the phrase in plain text. ' +
      'If that matters to you, move to a new Pubky identity.',
  };
}

module.exports = { DEFAULTS, NETWORK, IS_MAINNET, load, save, apply, invalidate, migrateLegacy };
