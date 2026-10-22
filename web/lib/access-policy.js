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
    try { result[name] = [...new Set(value[name].map(canonicalProvider))]; }
    catch { throw httpError(400, 'INVALID', `Check the Pubkys in the ${name} list.`); }
  }
  return result;
}

function load() {
  try {
    if (fs.statSync(paths.accessPolicy).size > 65536) throw new Error('too large');
    return validate(JSON.parse(fs.readFileSync(paths.accessPolicy, 'utf8')));
  } catch {
    throw httpError(503, 'ACCESS_POLICY_UNAVAILABLE',
      'Access policy is missing or invalid. New quotes and swaps are denied. Save a valid policy to restore access.');
  }
}

// Upgrade once. A later missing file must never silently turn a private service public.
function initialize() {
  const cfg = settings.load();
  if (cfg.accessPolicyInitialized) return;
  if (!fs.existsSync(paths.accessPolicy)) {
    writeAtomic(paths.accessPolicy, JSON.stringify({ mode: 'open', allowed: [], blocked: [] }) + '\n');
  }
  settings.save({ ...cfg, accessPolicyInitialized: true });
}

async function nativeValidate(file) {
  try {
    await execFile(process.env.SWAP_PROVIDER_BIN || '/usr/local/bin/swap-provider',
      ['--check-access-policy', '--access-policy-file', file],
      { env: engine.childEnv('/dev/null'), timeout: 10000, maxBuffer: 16384 });
  } catch {
    throw httpError(400, 'INVALID',
      'The provider could not validate this policy. Check the Pubkys and that the installed engine supports access controls.');
  }
}

function save(value, check = nativeValidate) {
  const policy = validate(value);
  return enqueue(async () => {
    // Ask the engine to validate actual Ed25519 keys before replacing the active policy.
    const dir = fs.mkdtempSync(path.join(paths.dataDir, '.access-policy-'));
    const candidate = path.join(dir, 'policy.json');
    try {
      writeAtomic(candidate, JSON.stringify(policy) + '\n');
      await check(candidate);
      fs.renameSync(candidate, paths.accessPolicy);
      return policy;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

module.exports = { initialize, load, save, validate };
