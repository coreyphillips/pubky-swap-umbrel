'use strict';

// Secrets on disk, and the only way they reach the daemon.
//
// Upstream removed `--recovery-phrase` and `--pass` on purpose: "an argv value is readable by
// anything that can see the process table and lands in shell history on the way there". The
// previous version of this app passed both flags, so it could not start at all against a current
// build. It also kept the phrase in plaintext inside config.json and shipped the daemon's whole
// stdout to an unauthenticated endpoint.
//
// The rule here is that a secret exists in exactly one place -- a 0600 file in a 0700 directory --
// and the daemon is told its *path*, never its value. `PUBKY_SWAP_RECOVERY_PHRASE__FILE` rather
// than `__VALUE`, so even `/proc/<pid>/environ` yields nothing but a filename.

const fs = require('fs');
const paths = require('./paths');
const { writeAtomic, readTrimmed } = require('./atomic');
const { hasControlChar } = require('./text');

const MAX_PHRASE_CHARS = 1024;
const MAX_RECOVERY_FILE_BYTES = 64 * 1024;

function ensureDir() {
  fs.mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  // An existing directory keeps whatever mode it had, so tighten it explicitly.
  try { fs.chmodSync(paths.secretsDir, 0o700); } catch {}
}

function has(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

/**
 * Store a recovery phrase, and clear any recovery file.
 *
 * Upstream refuses to start when both are configured ("use exactly one"), so the exclusion is
 * enforced here rather than left to each caller to remember.
 */
function writePhrase(text) {
  const phrase = String(text || '').trim().replace(/\s+/g, ' ');
  if (!phrase) throw new Error('enter your recovery phrase');
  if (phrase.length > MAX_PHRASE_CHARS) throw new Error('that is too long to be a recovery phrase');
  if (hasControlChar(phrase)) throw new Error('that does not look like a recovery phrase');
  ensureDir();
  writeAtomic(paths.recoveryPhrase, phrase + '\n', 0o600);
  clearRecoveryFile();
}

/** Store an uploaded .pkarr recovery file, and clear any phrase. */
function writeRecoveryFile(buf) {
  if (!buf || !buf.length) throw new Error('that recovery file is empty');
  if (buf.length > MAX_RECOVERY_FILE_BYTES) throw new Error('that file is too large to be a recovery file');
  ensureDir();
  writeAtomic(paths.recoveryFile, buf, 0o600);
  clearPhrase();
}

/** Store or clear the passphrase. It protects either identity kind, so it is orthogonal to both. */
function writePassphrase(text) {
  const pass = String(text == null ? '' : text);
  if (!pass) { clearPassphrase(); return; }
  if (pass.length > MAX_PHRASE_CHARS) throw new Error('that passphrase is too long');
  if (hasControlChar(pass)) throw new Error('a passphrase cannot contain control characters');
  ensureDir();
  writeAtomic(paths.passphrase, pass, 0o600);
}

function clearPhrase() { try { fs.rmSync(paths.recoveryPhrase, { force: true }); } catch {} }
function clearRecoveryFile() { try { fs.rmSync(paths.recoveryFile, { force: true }); } catch {} }
function clearPassphrase() { try { fs.rmSync(paths.passphrase, { force: true }); } catch {} }
function clearAll() { clearPhrase(); clearRecoveryFile(); clearPassphrase(); }

/** 'file' | 'phrase' | 'none'. The two identity kinds can never coexist; see writePhrase. */
function identityKind() {
  if (has(paths.recoveryFile)) return 'file';
  if (has(paths.recoveryPhrase)) return 'phrase';
  return 'none';
}

function hasPassphrase() { return has(paths.passphrase); }
function isConfigured() { return identityKind() !== 'none'; }

/**
 * The environment fragment that hands a daemon its identity. Only ever paths.
 *
 * When the identity is a recovery file its path goes in the generated TOML instead, as
 * `recovery_file`. That is not a style choice: `swap-client`'s positionals are provider then
 * recovery file, so passing the path on argv without a provider would silently bind it to the
 * provider pubky.
 */
function identityEnv() {
  const env = {};
  if (identityKind() === 'phrase') env.PUBKY_SWAP_RECOVERY_PHRASE__FILE = paths.recoveryPhrase;
  if (hasPassphrase()) env.PUBKY_SWAP_PASSPHRASE__FILE = paths.passphrase;
  return env;
}

/** The recovery file path, when that is the configured identity, else ''. */
function recoveryFilePath() {
  return identityKind() === 'file' ? paths.recoveryFile : '';
}

/**
 * The live secret values, for the log redactor only.
 *
 * Read fresh rather than cached: the redactor has to be correct immediately after an identity
 * change, and a stale needle is a leak.
 */
function liveSecrets() {
  return [readTrimmed(paths.recoveryPhrase), readTrimmed(paths.passphrase)].filter(Boolean);
}

module.exports = {
  ensureDir, writePhrase, writeRecoveryFile, writePassphrase,
  clearPhrase, clearRecoveryFile, clearPassphrase, clearAll,
  identityKind, hasPassphrase, isConfigured, identityEnv, recoveryFilePath, liveSecrets,
};
