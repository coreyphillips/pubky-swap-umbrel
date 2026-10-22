'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const paths = require('./paths');
const settings = require('./settings');
const engine = require('./engine');
const { canonicalProvider } = require('./pubky');
const { writeAtomic } = require('./atomic');
const { httpError } = require('./http');
const { createQueue } = require('./proc');
const enqueue = createQueue();

function validate(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some((key) => !['mode', 'allowed', 'blocked'].includes(key)) ||
      !['open', 'approved_only'].includes(value.mode)) {
    throw httpError(400, 'INVALID', 'Choose open or approved-only access.');
  }
  const result = { mode: value.mode };
  for (const name of ['allowed', 'blocked']) {
    if (!Array.isArray(value[name]) || value[name].length > 256 ||
        value[name].some((key) => typeof key !== 'string')) {
      throw httpError(400, 'INVALID', 'Each access list must contain at most 256 Pubkys.');
    }
    result[name] = value[name].map((key, index) => {
      try { return canonicalProvider(key); }
      catch { throw invalidKey(name, index + 1); }
    });
  }
  return result;
}

function invalidKey(list, entry) {
  return httpError(400, 'INVALID', `Invalid Pubky in the ${list === 'allowed' ? 'approved' : 'blocked'} list at entry ${entry}.`);
}

function unavailable(message = '') {
  return httpError(503, 'ACCESS_POLICY_UNAVAILABLE',
    `Access policy is missing or invalid. New quotes and swaps are denied. ${message} Save a valid policy to restore access.`.trim());
}

function load(check = nativeValidate) {
  return enqueue(async () => {
    let policy;
    try {
      if (fs.statSync(paths.accessPolicy).size > 65536) throw new Error('too large');
      policy = validate(JSON.parse(fs.readFileSync(paths.accessPolicy, 'utf8')));
    } catch { throw unavailable(); }
    try {
      // Validate the same snapshot the editor will show, including manually changed files.
      await withCandidate(policy, check);
      return policy;
    } catch (error) {
      if (error.code === 'VALIDATOR_UNAVAILABLE') throw error;
      throw unavailable(error.code === 'INVALID' ? error.message : '');
    }
  });
}

// This marker survives identity resets and missing or corrupt settings.json.
// Write it first so an interrupted initialization fails closed on the next start.
function initialize() {
  if (fs.existsSync(paths.accessPolicyInitialized)) return;
  const createDefault = !fs.existsSync(paths.accessPolicy) && !settings.load().accessPolicyInitialized;
  writeAtomic(paths.accessPolicyInitialized, 'initialized\n');
  if (createDefault) {
    writeAtomic(paths.accessPolicy, JSON.stringify({ mode: 'open', allowed: [], blocked: [] }) + '\n');
  }
}

async function nativeValidate(file) {
  try {
    await execFile(process.env.SWAP_PROVIDER_BIN || '/usr/local/bin/swap-provider',
      ['--check-access-policy', '--access-policy-file', file],
      { env: engine.childEnv('/dev/null'), timeout: 10000, maxBuffer: 16384 });
  } catch (error) {
    const invalid = error.code === 1 && /invalid (allowed|blocked) pubky at entry (\d+)/.exec(error.stderr || '');
    if (invalid) throw invalidKey(invalid[1], invalid[2]);
    throw httpError(503, 'VALIDATOR_UNAVAILABLE',
      'The provider could not validate the policy. Check that the engine is installed, supports access controls, and can run.');
  }
}

async function withCandidate(policy, action) {
  const dir = fs.mkdtempSync(path.join(paths.dataDir, '.access-policy-'));
  const candidate = path.join(dir, 'policy.json');
  try {
    writeAtomic(candidate, JSON.stringify(policy) + '\n');
    return await action(candidate);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function save(value, check = nativeValidate) {
  const policy = validate(value);
  return enqueue(() => withCandidate(policy, async (candidate) => {
    await check(candidate);
    // Saving after an identity reset must preserve the initialized state too.
    writeAtomic(paths.accessPolicyInitialized, 'initialized\n');
    fs.renameSync(candidate, paths.accessPolicy);
    return policy;
  }));
}

module.exports = { initialize, load, save, validate };
