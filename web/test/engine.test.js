'use strict';

// What the child processes are told, and what they must not be told.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubky-swap-engine-test-'));
process.env.DATA_DIR = dataDir;
process.env.NETWORK = 'mainnet';

const paths = require('../lib/paths');
const engine = require('../lib/engine');

/**
 * The engine layers config file, environment and flags, most specific last, so an environment
 * variable does not merely *locate* the config file, it overrides what is inside it.
 *
 * This is the bug that regression-locks: `PUBKY_SWAP_DATA_DIR` was set to the provider's directory
 * for every child, which silently overrode the `data_dir` in the taker's own generated config. Its
 * swap records went to the provider's store, so the panel could not find them, a swap that had
 * completely succeeded reported an unknown outcome, and the provider counted a taker's swaps among
 * its own earnings.
 */
test('the child environment cannot override the config file it points at', () => {
  const env = engine.childEnv('/data/client/config.toml');
  const overrides = Object.keys(env).filter(
    (k) => k.startsWith('PUBKY_SWAP_') && k !== 'PUBKY_SWAP_CONFIG' && !k.includes('__FILE'),
  );
  assert.deepEqual(overrides, [],
    `only PUBKY_SWAP_CONFIG and secret file paths may be set; found ${overrides.join(', ')}`);
  assert.equal(env.PUBKY_SWAP_CONFIG, '/data/client/config.toml');
});

test('the child environment is built from a whitelist, not inherited', () => {
  process.env.PUBKY_SWAP_FEE_PPM = '999999';
  try {
    const env = engine.childEnv('/data/swap/config.toml');
    assert.equal(env.PUBKY_SWAP_FEE_PPM, undefined,
      'a stray PUBKY_SWAP_* in the container must not reach the daemon and outrank its config');
  } finally {
    delete process.env.PUBKY_SWAP_FEE_PPM;
  }
});

test('the taker and the provider are given different data directories', () => {
  const settings = require('../lib/settings');
  const cfg = settings.load();
  const provider = engine.providerConfig(cfg, '127.0.0.1:9737');
  const client = engine.clientConfig(cfg, { dataDir: paths.clientDir });
  assert.equal(provider.data_dir, paths.providerDir);
  assert.equal(client.data_dir, paths.clientDir);
  assert.notEqual(provider.data_dir, client.data_dir,
    'a taker writing into the provider store makes its swaps the provider\'s earnings');
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
