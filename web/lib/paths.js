'use strict';

// Every path this app touches under DATA_DIR, defined once.
//
// The taker paths are the reason this file exists. `swap-client` defaults its data directory to
// `./pubky-swap-client-data`, relative to the working directory, and an earlier build of this app
// never passed `--data-dir` at all -- so taker swap records landed inside the container image
// rather than on the persistent volume. A submarine swap's refund key is generated into that
// directory and exists nowhere else in the world; losing it does not fail the swap, it makes the
// on-chain output unspendable by anyone, forever. Naming these paths in one place is the cheapest
// guard against that ever being ambiguous again.

const path = require('path');
const fs = require('fs');
const { SWAP_NETWORK } = require('./network');

const DATA_DIR = process.env.DATA_DIR || '/data';
const CHAIN_DIR = path.join(DATA_DIR, 'networks', SWAP_NETWORK);

for (const directory of ['swap', 'client', 'quote']) {
  if (containsLegacyState(path.join(DATA_DIR, directory))) {
    throw new Error('Existing flat swap data needs an explicit network migration before startup. Keep the original data volume.');
  }
}

function containsLegacyState(directory) {
  if (!fs.existsSync(directory)) return false;
  return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
    if (entry.isDirectory()) return containsLegacyState(path.join(directory, entry.name));
    return !['config.toml', 'status.token'].includes(entry.name);
  });
}

const paths = {
  dataDir: DATA_DIR,

  // Rates, limits and preferences. Never secrets.
  settings: path.join(DATA_DIR, 'settings.json'),

  // Pre-facelift config, migrated and scrubbed on first boot. Held a plaintext recovery phrase.
  legacyConfig: path.join(DATA_DIR, 'config.json'),
  legacyConfigTmp: path.join(DATA_DIR, 'config.json.tmp'),
  legacyIdentity: path.join(DATA_DIR, 'identity.pkarr'),

  // 0700. Everything inside is 0600 and reaches the daemon as a path, never as a value.
  secretsDir: path.join(DATA_DIR, 'secrets'),
  recoveryPhrase: path.join(DATA_DIR, 'secrets', 'recovery.phrase'),
  passphrase: path.join(DATA_DIR, 'secrets', 'passphrase'),
  recoveryFile: path.join(DATA_DIR, 'secrets', 'identity.pkarr'),

  // Provider daemon.
  providerDir: path.join(CHAIN_DIR, 'swap'),
  providerConfig: path.join(CHAIN_DIR, 'swap', 'config.toml'),
  providerSwaps: path.join(CHAIN_DIR, 'swap', 'swaps'),
  statusToken: path.join(CHAIN_DIR, 'swap', 'status.token'),

  // Taker. `swaps/` holds the only key that can recover funds from an unfinished swap.
  clientDir: path.join(CHAIN_DIR, 'client'),
  clientConfig: path.join(CHAIN_DIR, 'client', 'config.toml'),
  clientSwaps: path.join(CHAIN_DIR, 'client', 'swaps'),
  clientRuns: path.join(CHAIN_DIR, 'client', 'runs.jsonl'),

  // Temporary quote and identity configurations. Recovery data is never swept on exit.
  quoteDir: path.join(CHAIN_DIR, 'quote'),

  // Where a pre-fix build left taker records: relative to the server's cwd, inside the image.
  strandedClientSwaps: path.resolve(process.cwd(), 'pubky-swap-client-data', 'swaps'),
};

module.exports = paths;
