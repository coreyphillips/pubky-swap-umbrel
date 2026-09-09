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

const DATA_DIR = process.env.DATA_DIR || '/data';

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
  providerDir: path.join(DATA_DIR, 'swap'),
  providerConfig: path.join(DATA_DIR, 'swap', 'config.toml'),
  providerSwaps: path.join(DATA_DIR, 'swap', 'swaps'),
  statusToken: path.join(DATA_DIR, 'swap', 'status.token'),

  // Taker. `swaps/` holds the only key that can recover funds from an unfinished swap.
  clientDir: path.join(DATA_DIR, 'client'),
  clientConfig: path.join(DATA_DIR, 'client', 'config.toml'),
  clientSwaps: path.join(DATA_DIR, 'client', 'swaps'),
  clientRuns: path.join(DATA_DIR, 'client', 'runs.jsonl'),

  // One throwaway directory per quote check, so the client's resume pass has nothing to resume.
  // On the volume rather than /tmp: `--quote-only` returns before any record is written, but if
  // that ever changes, a record in /tmp is a destroyed refund key.
  quoteDir: path.join(DATA_DIR, 'quote'),

  // Where a pre-fix build left taker records: relative to the server's cwd, inside the image.
  strandedClientSwaps: path.resolve(process.cwd(), 'pubky-swap-client-data', 'swaps'),
};

module.exports = paths;
