'use strict';

// Exit code 0 does not mean a swap happened.
//
// `swap-client` has two paths that warn and return Ok(()) having moved nothing -- when it has
// negotiated a swap but has no execution backends configured. The old panel reported
// `code === 0 ? 'success' : 'failed'`, so it showed a green tick for a swap in which not one
// satoshi moved. The record on disk is the only thing that actually knows.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubky-swap-taker-test-'));
process.env.DATA_DIR = dataDir;
process.env.NETWORK = 'regtest';

// Stands in for swap-client, and behaves like one whose provider never answers: it says who the
// identity is and then waits. Everything the identity check is asked to get right is visible in
// what it prints before that, so it prints its arguments and the configuration it was given.
const STUB = path.join(dataDir, 'swap-client-stub.sh');
fs.writeFileSync(STUB, [
  '#!/bin/sh',
  'echo "argv: $*"',
  'cat "$PUBKY_SWAP_CONFIG"',
  'echo "Client pubky: pk-from-the-stub"',
  'sleep 5',
  'echo "the run carried on"',
  '',
].join('\n'), { mode: 0o755 });
process.env.SWAP_CLIENT_BIN = STUB;

const paths = require('../lib/paths');
const secrets = require('../lib/secrets');
const { LogBuffer } = require('../lib/logbuf');
const { Taker, parseQuoteLine } = require('../lib/taker');

function taker(logs = new LogBuffer()) {
  return new Taker({ logs, notices: { raise() {} } });
}

function writeRecord(id, state, extra = {}) {
  fs.mkdirSync(paths.clientSwaps, { recursive: true });
  fs.writeFileSync(path.join(paths.clientSwaps, `${id}.json`), JSON.stringify({
    swap_id: id, role: 'client', direction: 'submarine', peer: 'providerpubky',
    state: typeof state === 'string' ? { state } : state,
    secret_key_hex: 'aa'.repeat(32), preimage_hex: 'bb'.repeat(32),
    onchain_amount_sat: 250000, updated_at_unix: Math.floor(Date.now() / 1000), ...extra,
  }));
}

function clearRecords() {
  try { fs.rmSync(paths.clientSwaps, { recursive: true, force: true }); } catch {}
}

const NOOP_STDOUT =
  'Reverse swap negotiated and HTLC verified, but execution config is missing. To pay the hold ' +
  'invoice and claim on-chain, rebuild with --features full and pass --lnd-address.';

test('exit 0 with nothing moved is not a success', () => {
  clearRecords();
  const t = taker();
  const run = { provider: 'providerpubky', swap_ids: [] };
  const { outcome, detail } = t.determineOutcome(run, new Set(), NOOP_STDOUT, 0);
  assert.equal(outcome, 'nothing_happened', 'exit 0 with no record must not read as success');
  assert.match(detail, /execution config is missing/);
});

test('exit 0 with no record and no explanation is unknown, never success', () => {
  clearRecords();
  const t = taker();
  const { outcome } = t.determineOutcome({ provider: 'p', swap_ids: [] }, new Set(), 'nothing useful', 0);
  assert.equal(outcome, 'unknown');
});

test('the record decides, in every terminal state', () => {
  for (const [state, expected] of [
    ['claimed', 'succeeded'], ['refunded', 'refunded'], ['expired', 'refunded'],
  ]) {
    clearRecords();
    writeRecord(`id-${state}`, state);
    const t = taker();
    const { outcome } = t.determineOutcome({ provider: 'providerpubky', swap_ids: [] }, new Set(), '', 0);
    assert.equal(outcome, expected, `${state} should read as ${expected}`);
  }
});

test('a failed record carries the engine\'s own reason', () => {
  clearRecords();
  writeRecord('id-failed', { state: 'failed', detail: 'invoice payment failed: no route' });
  const t = taker();
  const { outcome, detail } = t.determineOutcome({ provider: 'providerpubky', swap_ids: [] }, new Set(), '', 1);
  assert.equal(outcome, 'failed');
  assert.equal(detail, 'invoice payment failed: no route');
});

test('a non-terminal record after the process died means funds may still be committed', () => {
  clearRecords();
  writeRecord('id-open', 'lockup_confirmed');
  const t = taker();
  const { outcome, detail } = t.determineOutcome({ provider: 'providerpubky', swap_ids: [] }, new Set(), '', 0);
  assert.equal(outcome, 'interrupted', 'an open swap must never read as finished');
  assert.match(detail, /still open/);
});

test('records left outside the volume are rescued, not moved', () => {
  clearRecords();
  const stray = path.join(dataDir, 'stray', 'swaps');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'orphan.json'), JSON.stringify({
    swap_id: 'orphan', role: 'client', direction: 'submarine', peer: 'p',
    state: { state: 'lockup_confirmed' }, secret_key_hex: 'cc'.repeat(32),
  }));
  const t = taker();
  assert.equal(t.rescueFrom(stray, 'a test'), 1);
  assert.ok(fs.existsSync(path.join(paths.clientSwaps, 'orphan.json')), 'the record was copied to safety');
  assert.ok(fs.existsSync(path.join(stray, 'orphan.json')), 'and the original was left alone');
  assert.equal(t.unfinished().length, 1);
});

test('the QUOTE line is parsed, and its Debug-cased direction folded', () => {
  const q = parseQuoteLine(
    'some noise\nQUOTE provider=pk1 direction=Reverse amount_sat=250000 fee_sat=3405 ' +
    'total_sat=253405 timeout_blocks=144 confirmations=2\nmore noise');
  assert.equal(q.direction, 'reverse', 'Reverse must fold to the lowercase spelling used everywhere else');
  assert.equal(q.total_sat, 253405);
  assert.equal(q.service_fee_sat, null, 'fields upstream does not print are absent, not zero');
  assert.equal(parseQuoteLine('no quote here'), null);
});

/**
 * The identity check, after upstream moved the identity load out of `--resume-only`.
 *
 * Three things have to hold, and the stub can show all three. The check has to run the mode that
 * still loads the identity; it has to name a provider nothing can be sent to, because a quote
 * needs a counterparty and this one must not be a real person; and it has to stop at the line it
 * came for, so a check never turns into a run that outlives it.
 */
test('the identity check reads the pubky and ends the run there', async () => {
  clearRecords();
  // Only so an identity counts as configured; the stub never looks at it.
  secrets.writePhrase('a phrase belonging to nobody, written by a test');
  try {
    const logs = new LogBuffer();
    const started = Date.now();
    const { pubky } = await taker(logs).probeIdentity();
    const elapsed = Date.now() - started;
    const printed = logs.tailText(200);

    assert.equal(pubky, 'pk-from-the-stub');
    assert.match(printed, /--quote-only/, 'the only mode that still loads the identity');
    assert.match(printed, /--no-rendezvous-iroh/, "a check rings nobody's doorbell");
    assert.match(printed, /provider_pkarr = "identity-check-only"/, 'and names nobody as the provider');
    assert.ok(!/the run carried on/.test(printed), 'the run must not outlive the line it was started for');
    assert.ok(elapsed < 4000, `the check waited ${elapsed}ms for a line it already had`);
  } finally {
    secrets.clearAll();
  }
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
