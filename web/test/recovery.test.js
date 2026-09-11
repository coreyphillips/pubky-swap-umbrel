'use strict';

// What the panel does with a swap the engine has given up driving.
//
// These lock the bump to the upstream range that added `needs_recovery`. Before it, a driver that
// could not make progress burned a budget of ten re-entries and then wrote `failed`, which is
// terminal, so the panel painted it red and quoted the reason. Now the engine retries forever on a
// backoff capped at five minutes and never makes the record terminal. Every one of those attempts
// stamps `updated_at_unix`.
//
// That is what makes this worth a test rather than a careful read: both of the panel's "this swap
// is in trouble" signals were arithmetic on that timestamp, against thresholds of ten minutes and
// up. A permanently retrying swap keeps its timestamp fresher than any of them, so the arithmetic
// could never fire again and the failure mode was silent in the worst direction: a funded swap
// nobody is driving, rendered as a healthy one waiting politely on its counterparty.

const test = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

const teardown = installDom();
test.after(teardown);

let sv;
let activity;
test.before(async () => {
  sv = await import('../public/js/swapview.js');
  activity = await import('../public/js/tabs/activity.js');
});

const NOW = 1_800_000_000;

/** A provider swap sitting on a funded HTLC, retried two minutes ago. */
function retrying(extra = {}) {
  return {
    swap_id: 'abc', role: 'provider', direction: 'reverse', state: 'lockup_confirmed',
    peer: 'pk', onchain_amount_sat: 250000, service_fee_sat: 700, onchain_fee_sat: 1400,
    updated_at_unix: NOW - 120,
    needs_recovery: true, retry_count: 47, next_retry_at_unix: NOW + 180,
    last_error: 'electrum: connection refused',
    ...extra,
  };
}

test('a swap the engine cannot drive is not described as progress, however fresh its timestamp', () => {
  const d = sv.describeSwap(retrying(), { nowUnix: NOW });

  // The exact shape of the bug: two minutes of age against a 4h stall threshold, so every
  // timestamp-derived signal says this swap is fine.
  assert.equal(d.kind, 'recovery');
  assert.equal(d.tone, 'bad');
  assert.equal(d.reason, 'electrum: connection refused', 'the daemon gets to say why, verbatim');
  assert.equal(d.stalledFor, null, 'it is not stalled, which is a different claim');
});

test('without the flag the same swap still reads as ordinary progress', () => {
  const swap = retrying({ needs_recovery: false });
  const d = sv.describeSwap(swap, { nowUnix: NOW });

  assert.equal(d.kind, 'progress');
  assert.equal(d.headline, 'Funding confirmed');
});

test('recovery outranks the stall arithmetic when both would apply', () => {
  // Old enough to be stalled as well. The daemon's own verdict is the more specific claim.
  const d = sv.describeSwap(retrying({ updated_at_unix: NOW - 20 * 3600 }), { nowUnix: NOW });
  assert.equal(d.kind, 'recovery');
});

test('the retry phrase looks forward, because the retry has not happened yet', () => {
  // relTime only looks backwards and answers a future timestamp with "just now", which reads as
  // though the retry already ran and achieved nothing.
  assert.match(sv.retryPhrase(NOW + 180, { nowUnix: NOW }), /^Retrying in /);
  assert.equal(sv.retryPhrase(NOW - 5, { nowUnix: NOW }), 'Retrying now.');
  assert.equal(sv.retryPhrase(null, { nowUnix: NOW }), null);
});

test('a swap in recovery needs attention', () => {
  const snap = {
    now_unix: NOW,
    swaps: { active: [retrying()], recent: [] },
    taker: { state: 'idle', swaps: { active: [], recent: [] } },
  };
  assert.equal(activity.needsAttention(snap).length, 1);
});

test('a terminal record does not, even carrying the flag', () => {
  const snap = {
    now_unix: NOW,
    swaps: { active: [], recent: [retrying({ state: 'claimed' })] },
    taker: { state: 'idle', swaps: { active: [], recent: [] } },
  };
  assert.equal(activity.needsAttention(snap).length, 0);
});

test('the stale-error rule still catches a taker record, which carries no recovery flag', () => {
  // swap-client writes no `needs_recovery`, and the server's projection would strip it anyway, so
  // removing this rule in favour of the flag would lose every taker swap.
  const taker = {
    swap_id: 'zzz', role: 'client', direction: 'submarine', state: 'lockup_confirmed',
    onchain_amount_sat: 100000, updated_at_unix: NOW - 4000,
    last_error: 'lnd: no route', peer: 'pk',
  };
  const snap = {
    now_unix: NOW,
    swaps: { active: [], recent: [] },
    taker: { state: 'running', swaps: { active: [taker], recent: [] } },
  };
  assert.equal(activity.needsAttention(snap).length, 1);
});

// ---- durable admission ----

test('a reverse swap admitted without its invoice does not claim an invoice was issued', () => {
  // Upstream persists the record before asking Lightning for the hold invoice, so a client can
  // retry without spending another quote. When that call fails the record sits in `created` with
  // nothing behind it, and the stock first step would describe it as "Invoice issued, waiting for
  // them to pay it": wrong on both halves.
  const swap = {
    swap_id: 'def', role: 'provider', direction: 'reverse', state: 'created',
    peer: 'pk', onchain_amount_sat: 90000, updated_at_unix: NOW - 30,
    awaiting_invoice: true,
  };
  const d = sv.describeSwap(swap, { nowUnix: NOW });

  assert.equal(d.headline, 'Admitted, invoice not created');
  assert.notEqual(d.who, 'them', 'there is nobody on the other side to wait for');
});

test('an ordinary reverse swap in the same state is untouched', () => {
  const swap = {
    swap_id: 'def', role: 'provider', direction: 'reverse', state: 'created',
    peer: 'pk', onchain_amount_sat: 90000, updated_at_unix: NOW - 30,
  };
  const d = sv.describeSwap(swap, { nowUnix: NOW });

  assert.equal(d.headline, 'Invoice issued');
  assert.equal(d.who, 'them');
});

test('the substitution does not mutate the shared track', () => {
  // The tracks are module-level constants shared by every render. Rewriting step 0 in place would
  // relabel every reverse swap on the page after one uninvoiced record went past.
  sv.describeSwap({ direction: 'reverse', state: 'created', awaiting_invoice: true, updated_at_unix: NOW }, { nowUnix: NOW });
  assert.equal(sv.stepsFor('reverse')[0].label, 'Invoice issued');
});

test('the compact track says so, because a table row has nowhere else to say it', () => {
  // In the Activity table the headline is the step label, which for a swap in recovery reads as
  // ordinary progress ("They claimed on-chain"). Caught by looking at a screenshot of the running
  // panel, not by the assertions above, which were all satisfied while the row still looked fine.
  const node = sv.track(retrying(), { compact: true });
  assert.match(node.textContent, /needs recovery/);
  assert.match(node.getAttribute('aria-label') || '', /^Needs recovery: /);
});
