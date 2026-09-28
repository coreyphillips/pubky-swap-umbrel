'use strict';

// What the child processes are told, and what they must not be told.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  assert.equal(client.negotiation, 'auto');
});

test('an unknown network cannot silently configure mainnet', () => {
  const result = spawnSync(process.execPath, ['-e', 'require("./lib/engine")'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, NETWORK: 'unknown' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported Bitcoin network/);
});

test('network changes select independent provider and client stores', () => {
  const result = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./lib/paths")))'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, NETWORK: 'regtest' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const regtest = JSON.parse(result.stdout);
  assert.notEqual(regtest.providerDir, paths.providerDir);
  assert.notEqual(regtest.clientDir, paths.clientDir);
  assert.match(regtest.clientDir, /networks\/regtest\/client$/);
  assert.match(paths.clientDir, /networks\/bitcoin\/client$/);
});

test('old flat recovery state is preserved and cannot be silently abandoned', () => {
  const directory = path.join(dataDir, 'client', 'swaps');
  fs.mkdirSync(directory, { recursive: true });
  const record = path.join(directory, 'pending.json');
  fs.writeFileSync(record, '{"state":"created"}');
  const result = spawnSync(process.execPath, ['-e', 'require("./lib/paths")'], {
    cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit network migration/);
  assert.equal(fs.readFileSync(record, 'utf8'), '{"state":"created"}');
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
