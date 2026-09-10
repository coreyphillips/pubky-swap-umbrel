'use strict';

// The supervision regression that matters most.
//
// The old server sent SIGTERM and immediately dropped its reference to the child, then spawned the
// replacement. Hundreds of milliseconds later the *old* process actually died, and its exit handler
// -- still holding a closure over the supervisor -- cleared the handle now belonging to the *new*
// provider. The panel reported "stopped" while a provider was running, could no longer stop it, and
// two daemons could end up sharing one identity, one macaroon and one data directory.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubky-swap-provider-test-'));
process.env.DATA_DIR = dataDir;
process.env.NETWORK = 'regtest';
// The real grace period is 20s. The behaviour under test is the handler guard, not the wait.
process.env.PROVIDER_STOP_GRACE_MS = '80';
process.env.PROVIDER_STOP_HARD_MS = '80';

const secrets = require('../lib/secrets');
const { LogBuffer } = require('../lib/logbuf');
const { Redactor } = require('../lib/redact');
const { Provider } = require('../lib/provider');

/** A child process that exits only when told to. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  child.die = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  return child;
}

function build() {
  const spawned = [];
  const logs = new LogBuffer({ redactor: new Redactor() });
  const statusClient = {
    configure() {}, reset() {}, start() {}, stop() {},
    get: () => null, value: () => null, get reachable() { return false; },
  };
  const provider = new Provider({
    logs,
    statusClient,
    redactor: new Redactor(),
    notices: { raise() {} },
    spawnFn: () => { const c = fakeChild(); spawned.push(c); return c; },
  });
  return { provider, spawned, logs };
}

test("a stale child's exit does not clear the running provider", async () => {
  secrets.writePhrase('abandon abandon ability able about above absent absorb abstract absurd abuse access');
  const { provider, spawned } = build();

  await provider.start();
  assert.equal(spawned.length, 1, 'the first provider was spawned');
  const first = spawned[0];

  // A restart, with the first process never acknowledging SIGTERM. The supervisor gives up waiting
  // and spawns the replacement, which is the situation the bug needed.
  await provider.restart();
  assert.equal(spawned.length, 2, 'a replacement was spawned while the first was still alive');
  assert.equal(provider.child, spawned[1]);

  // Only now does the first process finally die. Its exit handler still closes over the supervisor.
  first.die(143, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(provider.child, 'the supervisor still holds a child');
  assert.equal(provider.child, spawned[1], 'and it is the new one, not the corpse of the old');
  assert.notEqual(provider.state, 'stopped', 'state should not be "stopped" while a provider runs');
  assert.equal(provider.restartTimer, null, 'and no restart was scheduled for a process we replaced');

  await provider.stop();
});

test('an exit while stopping is not treated as a crash to restart from', async () => {
  const { provider, spawned } = build();
  await provider.start();
  const stopping = provider.stop();
  await new Promise((r) => setTimeout(r, 20));
  spawned[spawned.length - 1].die(0, 'SIGTERM');
  await stopping;

  assert.equal(provider.state, 'stopped');
  assert.equal(provider.child, null);
  assert.equal(provider.restartTimer, null, 'no restart was scheduled');
});

test('the status token is 64 hex characters at 0600, and is adopted on the next start', async () => {
  const { provider } = build();
  const first = provider.ensureStatusToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  const paths = require('../lib/paths');
  assert.equal(fs.statSync(paths.statusToken).mode & 0o777, 0o600);
  assert.equal(provider.ensureStatusToken(), first, 'a valid token is reused, not regenerated');
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
