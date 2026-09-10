'use strict';

// The one property this projection cannot get wrong.

const test = require('node:test');
const assert = require('node:assert');
const { project, isTerminal } = require('../lib/swapview');

function record(overrides = {}) {
  return {
    swap_id: '4f2a91c4-0000-0000-0000-00000000abcd',
    role: 'client',
    direction: 'submarine',
    peer: 'peerpubky',
    state: { state: 'lockup_confirmed' },
    secret_key_hex: 'aa'.repeat(32),
    preimage_hex: 'bb'.repeat(32),
    invoice: 'lnbcrt1...',
    onchain_amount_sat: 250000,
    service_fee_sat: 1200,
    onchain_fee_sat: 250,
    funding_txid_hex: 'cc'.repeat(32),
    funding_vout: 1,
    updated_at_unix: 1757400000,
    ...overrides,
  };
}

test('no key material reaches the wire', () => {
  const json = JSON.stringify(project(record()));
  assert.ok(!json.includes('aa'.repeat(32)), 'the branch key reached the wire');
  assert.ok(!json.includes('bb'.repeat(32)), 'the preimage reached the wire');
  assert.ok(json.includes('peerpubky'), 'and the projection is not simply empty');
});

test('a failure reason is a field, not part of the state name', () => {
  const view = project(record({ state: { state: 'failed', detail: 'the peer never paid' } }));
  assert.equal(view.state, 'failed');
  assert.equal(view.state_detail, 'the peer never paid');

  const ok = project(record());
  assert.equal(ok.state, 'lockup_confirmed');
  assert.equal(ok.state_detail, null);
});

test('funding is an outpoint, and absent rather than half-formed', () => {
  assert.equal(project(record()).funding, 'cc'.repeat(32) + ':1');
  assert.equal(project(record({ funding_vout: undefined })).funding, null);
});

test('terminality matches the engine', () => {
  for (const state of ['claimed', 'refunded', 'expired', 'failed']) {
    assert.ok(isTerminal(project(record({ state: { state } }))), `${state} is terminal`);
  }
  for (const state of ['created', 'lockup_pending', 'lockup_confirmed', 'invoice_pending', 'invoice_paid']) {
    assert.ok(!isTerminal(project(record({ state: { state } }))), `${state} is not terminal`);
  }
});
