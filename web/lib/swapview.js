'use strict';

// Projecting a swap record into something safe to send to a browser.
//
// A SwapRecord on disk holds `secret_key_hex` -- the branch key that can move the funds on this
// side's HTLC -- and, on the client side, the preimage. Upstream's own status API solves this by
// building every response from a view type that has no field for either, "so the secret cannot
// reach the wire through a struct someone later adds a Serialize to", and has a test asserting it.
// This is the same projection for the records this app reads directly, built the same way.
//
// Note the construction: an explicit allowlist, never a spread-and-delete. A copy-then-omit is one
// forgotten key away from leaking, and the key it would leak is the one that spends the money.

const TERMINAL = new Set(['claimed', 'refunded', 'expired', 'failed']);

/**
 * Flatten the on-disk state into the shape upstream's API serves.
 *
 * `SwapState` is adjacently tagged, so the record's `state` field is itself an object:
 * `{"state":"lockup_confirmed"}`, or `{"state":"failed","detail":"..."}`. A dashboard has to be
 * able to switch on the state without parsing it, and the reason belongs in its own field -- which
 * is exactly why upstream stopped rendering it with Debug, where a failure came out as
 * `Failed("the peer never paid")`, quotes and all, and went straight into a badge.
 */
function splitState(state) {
  if (typeof state === 'string') return { state, detail: null };
  if (state && typeof state === 'object') {
    return { state: String(state.state || 'created'), detail: state.detail == null ? null : String(state.detail) };
  }
  return { state: 'created', detail: null };
}

function project(record) {
  if (!record || typeof record !== 'object') return null;
  const { state, detail } = splitState(record.state);
  const funding = record.funding_txid_hex && record.funding_vout != null
    ? `${record.funding_txid_hex}:${record.funding_vout}`
    : null;

  return {
    swap_id: String(record.swap_id || ''),
    role: record.role === 'client' ? 'client' : 'provider',
    direction: String(record.direction || '').toLowerCase(),
    state,
    state_detail: detail,
    peer: String(record.peer || ''),
    onchain_amount_sat: num(record.onchain_amount_sat),
    service_fee_sat: num(record.service_fee_sat),
    onchain_fee_sat: num(record.onchain_fee_sat),
    quote_total_sat: num(record.quote_total_sat),
    required_confirmations: num(record.required_confirmations),
    timeout_height: num(record.timeout_height),
    funding,
    spend: record.spend_txid_hex ? String(record.spend_txid_hex) : null,
    reorg_seen_at_height: record.reorg_seen_at_height == null ? null : num(record.reorg_seen_at_height),
    last_error: record.last_error == null ? null : String(record.last_error),
    updated_at_unix: num(record.updated_at_unix),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isTerminal(view) {
  return Boolean(view) && TERMINAL.has(view.state);
}

module.exports = { project, splitState, isTerminal, TERMINAL };
