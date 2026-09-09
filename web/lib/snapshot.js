'use strict';

// The one state document the panel renders from.
//
// Built in a single place so the SSE stream and the polling fallback cannot drift: /api/state and
// the `snapshot` event are byte-identical, which means the render path is shared and the fallback
// is never the poorly-tested branch.
//
// The rule for each block: pass upstream's own shape through untouched, and add only what the
// browser cannot compute for itself. Upstream's field names carry their own honesty -- an
// `expected_onchain_cost_sat` is deliberately "expected" -- and renaming them here would quietly
// launder that away.

const settings = require('./settings');
const secrets = require('./secrets');
const engine = require('./engine');
const swapview = require('./swapview');

// Upstream's MIN_AMOUNT_FEE_MULTIPLE. Below this the fee dominates the trade, so the advertised
// minimum rises with the fee environment instead of staying at a number chosen when fees were low.
const MIN_AMOUNT_FEE_MULTIPLE = 10;

const APP_VERSION = require('../package.json').version;

function build({ provider, statusClient, taker, notices, health }) {
  const cfg = settings.load();
  const now = Math.floor(Date.now() / 1000);
  const providerView = provider.view();

  return {
    v: 1,
    now_unix: now,
    app: { version: APP_VERSION },
    env: {
      network: engine.NETWORK,
      lnd: { ip: engine.LND_IP, port: engine.LND_GRPC_PORT },
      electrs: { ip: engine.ELECTRS_IP, port: engine.ELECTRS_PORT },
    },
    setup: {
      identity: secrets.identityKind(),
      hasPassphrase: secrets.hasPassphrase(),
      configured: secrets.isConfigured(),
      role: cfg.role,
      complete: Boolean(cfg.setupComplete),
    },
    provider: providerView,
    health: buildHealth(statusClient, health, now),
    offer: buildOffer(statusClient, now),
    limits: buildLimits(statusClient),
    earnings: statusClient.value('earnings'),
    swaps: buildSwaps(statusClient),
    taker: taker.view(),
    settings: publicSettings(cfg),
    notices: notices.list(),
  };
}

/**
 * The health report, from the status API when the daemon is up and from a doctor run when it is
 * not. `checks` passes through verbatim in both cases -- the remedies are upstream prose that names
 * the exact flags and paths found on this machine, and rewriting them would destroy the part an
 * operator actually pastes.
 */
function buildHealth(statusClient, lastDoctor, now) {
  const entry = statusClient.get('health');
  const live = entry && entry.value;

  if (live && live.checking) {
    return { state: 'checking', detail: live.detail, checks: [], source: 'status-api' };
  }
  if (live && Array.isArray(live.checks)) {
    const age = entry.fetchedAt ? now - Math.floor(entry.fetchedAt / 1000) : null;
    return {
      state: live.capable ? (live.warnings ? 'degraded' : 'ok') : 'failed',
      capable: live.capable,
      failures: live.failures,
      warnings: live.warnings,
      checks: live.checks,
      checked_at_unix: live.checked_at_unix,
      refresh_secs: live.refresh_secs,
      age_secs: age,
      // Say how fresh this is rather than implying it is live. Three refresh periods without an
      // update means the panel has probably lost contact, not that the node is fine.
      stale: age != null && live.refresh_secs ? age > live.refresh_secs * 3 : false,
      source: 'status-api',
    };
  }
  if (lastDoctor) {
    return {
      state: lastDoctor.capable ? (lastDoctor.warnings ? 'degraded' : 'ok') : 'failed',
      capable: lastDoctor.capable,
      failures: lastDoctor.failures,
      warnings: lastDoctor.warnings,
      checks: lastDoctor.checks,
      checked_at_unix: lastDoctor.checked_at_unix,
      age_secs: now - lastDoctor.checked_at_unix,
      error: lastDoctor.error,
      stale: now - lastDoctor.checked_at_unix > 300,
      source: 'doctor',
    };
  }
  return { state: 'unknown', checks: [], source: null };
}

/**
 * The live offer, plus the number that is actually advertised.
 *
 * `effective_min_amount_sat` is a method upstream, not a serialized field, so it does not come over
 * the wire -- but it is the minimum other people see, it moves with the mempool, and showing the
 * configured minimum instead would be showing a number that is untrue most of the time on mainnet.
 * Computed here rather than in the browser so the multiple lives next to the comment explaining it.
 */
function buildOffer(statusClient, now) {
  const offer = statusClient.value('offer');
  if (!offer || typeof offer !== 'object') return null;
  const effective = Math.max(
    Number(offer.min_amount_sat) || 0,
    (Number(offer.onchain_fee_sat) || 0) * MIN_AMOUNT_FEE_MULTIPLE,
  );
  const validFor = offer.valid_until_unix ? offer.valid_until_unix - now : null;
  return {
    ...offer,
    effective_min_amount_sat: effective,
    // True when the configured floor is not the one being advertised, which is the case the Earn
    // tab has to explain rather than quietly paper over.
    min_is_fee_driven: effective > (Number(offer.min_amount_sat) || 0),
    valid_for_secs: validFor,
    expired: validFor != null && validFor <= 0,
  };
}

function buildLimits(statusClient) {
  const limits = statusClient.value('limits');
  if (!limits || typeof limits !== 'object') return null;
  const max = Number(limits.max_total_exposure_sat) || 0;
  const committed = Number(limits.committed_sat) || 0;
  const maxSwaps = Number(limits.max_concurrent_swaps) || 0;
  return {
    ...limits,
    // Computed here so a zero ceiling cannot render as NaN% in a meter.
    exposure_pct: max > 0 ? Math.min(100, (committed / max) * 100) : 0,
    in_flight_pct: maxSwaps > 0 ? Math.min(100, ((Number(limits.in_flight) || 0) / maxSwaps) * 100) : 0,
  };
}

function buildSwaps(statusClient) {
  const swaps = statusClient.value('swaps');
  if (!swaps || typeof swaps !== 'object') {
    return { active: [], recent: [], recent_limit: 0, finished_total: 0, available: false };
  }
  const tag = (list) => (Array.isArray(list) ? list : []).map((s) => ({ ...s, role: 'provider' }));
  return {
    active: tag(swaps.active),
    recent: tag(swaps.recent),
    recent_limit: swaps.recent_limit || 0,
    finished_total: swaps.finished_total || 0,
    available: true,
  };
}

/** Everything the browser may see. Secrets are absent by construction, not by deletion. */
function publicSettings(cfg) {
  const out = {};
  for (const key of Object.keys(settings.DEFAULTS)) out[key] = cfg[key];
  return out;
}

module.exports = { build, MIN_AMOUNT_FEE_MULTIPLE };
