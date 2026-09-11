// Overview. Layer 3.
//
// One question: is my node safely making money right now, and is anything stuck?
//
// Health answers "am I safe", exposure answers "how much of me is at risk", in-flight answers "is
// anything stuck". Everything else on this tab is one click from somewhere better.

import { el, fill } from '../dom.js';
import * as fmt from '../format.js';
import * as c from '../components.js';
import { track, describeSwap } from '../swapview.js';

export default {
  id: 'overview',
  label: 'Overview',

  mount(root) {
    fill(root,
      el('div.stack', {},
        el('div', { attrs: { id: 'ovHealth' } }),
        el('div.grid.c2', {},
          el('div', { attrs: { id: 'ovExposure' } }),
          el('div', { attrs: { id: 'ovEarnings' } })),
        el('div', { attrs: { id: 'ovFlight' } }),
        el('div', { attrs: { id: 'ovOffer' } })));
  },

  render(root, snap) {
    fill(root.querySelector('#ovHealth'), healthCard(snap));
    fill(root.querySelector('#ovExposure'), exposureCard(snap));
    fill(root.querySelector('#ovEarnings'), earningsCard(snap));
    fill(root.querySelector('#ovFlight'), inFlightCard(snap));
    fill(root.querySelector('#ovOffer'), offerCard(snap));
  },
};

function healthCard(snap) {
  const h = snap.health || {};
  const p = snap.provider || {};

  if (h.state === 'unknown' || !h.checks) {
    return c.card({ title: 'System' },
      p.running
        ? c.skeleton({ height: 60 })
        : c.note('The provider is not running, so there is nothing to check yet.', { tone: 'idle' }));
  }
  if (h.state === 'checking') {
    return c.card({ title: 'System' },
      c.note(h.detail || 'Running the first health check.', { tone: 'info' }),
      c.skeleton({ height: 44 }));
  }

  const tone = h.failures ? 'bad' : h.warnings ? 'warn' : 'ok';
  const summary = h.failures
    ? `${h.failures} check${h.failures === 1 ? '' : 's'} need attention`
    : h.warnings
      ? `${h.warnings} warning${h.warnings === 1 ? '' : 's'}`
      : 'Everything checks out';

  return c.card({
    title: 'System',
    // Say how fresh this is rather than implying it is live.
    meta: h.checked_at_unix ? `checked ${fmt.relTime(h.checked_at_unix)}` : null,
  },
    el('div.row', {},
      c.badge(summary, tone, { dot: true, pulse: tone === 'ok' && p.capable }),
      el('span.small.muted', { text: `${(h.checks || []).length} checks` }),
      el('span.spacer'),
      h.stale ? c.badge('may be out of date', 'warn') : null),
    (h.failures || h.warnings)
      ? el('div', { style: { 'margin-top': 'var(--s-4)' } }, c.checkList(h.checks || []))
      : null);
}

function exposureCard(snap) {
  const l = snap.limits;
  if (!l) {
    return c.card({ title: 'Exposure' },
      snap.provider.running ? c.skeleton({ height: 56 })
        : c.note('Nothing is committed while the provider is stopped.', { tone: 'idle' }));
  }
  return c.card({ title: 'Exposure' },
    el('div.stat-value', {}, el('span.num', { text: fmt.sats(l.committed_sat) })),
    el('div.stat-sub', { text: `committed of a ${fmt.satsCompact(l.max_total_exposure_sat)} ceiling` }),
    el('div', { style: { 'margin-top': 'var(--s-3)' } },
      c.meter({
        value: l.committed_sat, max: l.max_total_exposure_sat,
        legendLeft: `${l.in_flight} of ${l.max_concurrent_swaps} swaps in flight`,
        legendRight: fmt.pct(l.exposure_pct),
      })));
}

function earningsCard(snap) {
  const e = snap.earnings;
  if (!e) {
    return c.card({ title: 'Earnings' },
      snap.provider.running ? c.skeleton({ height: 56 })
        : c.note('Start the provider to begin earning.', { tone: 'idle' }));
  }
  if (!e.completed) {
    return c.card({ title: 'Earnings' },
      // An em-dash, not a zero: zero is a claim, and there is nothing yet to claim about.
      el('div.stat-value', {}, el('span.num', { text: '—' })),
      el('div.stat-sub', { text: 'No completed swaps yet. Fees show up here once someone swaps with you.' }));
  }
  return c.card({ title: 'Earnings' },
    el('div.stat-value', {}, el('span.num', { text: fmt.sats(e.service_fee_sat) })),
    el('div.stat-sub', {
      text: `from ${e.completed} completed swap${e.completed === 1 ? '' : 's'}, ${fmt.satsCompact(e.volume_sat)} of volume`,
    }));
}

function inFlightCard(snap) {
  const provider = (snap.swaps && snap.swaps.active) || [];
  const taker = (snap.taker && snap.taker.swaps && snap.taker.swaps.active) || [];
  const all = [...provider.map((s) => ({ ...s, role: 'provider' })), ...taker.map((s) => ({ ...s, role: 'client' }))];

  if (!all.length) {
    const pubky = snap.provider && snap.provider.pubky;
    return c.card({ title: 'In flight' },
      c.empty({
        title: 'Nothing in flight.',
        body: snap.provider.capable
          ? 'Your offer is live. Swaps appear here the moment someone takes one.'
          : 'Swaps you provide and swaps you take both show up here.',
        action: pubky ? c.copyButton(pubky, 'Copy your pubky') : null,
      }));
  }

  // Anything that has stopped moving sorts to the top: it is the only thing on this card that might
  // need a person.
  // A swap the engine has told us it cannot drive outranks one we merely timed, because that is the
  // daemon's own verdict rather than our arithmetic.
  const rank = (swap) => {
    const kind = describeSwap(swap).kind;
    return kind === 'recovery' ? 0 : kind === 'stalled' ? 1 : 2;
  };
  const sorted = all.sort((a, b) => rank(a) - rank(b) || b.updated_at_unix - a.updated_at_unix);

  return c.card({ title: 'In flight', meta: `${all.length} swap${all.length === 1 ? '' : 's'}` },
    el('div.stack', { style: { gap: 'var(--s-3)' } },
      ...sorted.map((swap) => {
        const d = describeSwap(swap);
        return el('div.row', { style: { gap: 'var(--s-3)' } },
          el('span.badge', { dataset: { tone: swap.role === 'client' ? 'accent' : 'idle' }, text: swap.role === 'client' ? 'yours' : 'served' }),
          el('span.num', { text: fmt.sats(swap.onchain_amount_sat), style: { 'min-width': '110px' } }),
          track(swap, { compact: true }),
          el('span.small.muted', { text: d.headline }),
          el('span.spacer'),
          d.kind === 'recovery'
            ? c.badge('needs recovery', 'bad')
            : d.kind === 'stalled'
              ? c.badge(`no movement for ${fmt.duration(d.stalledFor)}`, 'warn')
              : el('span.small.faint', { text: fmt.relTime(swap.updated_at_unix) }));
      })));
}

function offerCard(snap) {
  const o = snap.offer;
  if (!o) {
    return c.card({ title: 'Your offer' },
      snap.provider.running
        ? c.skeleton({ height: 60 })
        : c.note('Nothing is being advertised while the provider is stopped.', { tone: 'idle' }));
  }
  const rows = [
    ['Directions', fmt.directions(o.directions)],
    ['Amounts', `${fmt.sats(o.effective_min_amount_sat)} to ${fmt.sats(o.max_amount_sat)}`],
    ['Your fee', `${fmt.sats(o.base_fee_sat)} + ${(o.fee_ppm / 10000).toFixed(2)}%`],
    ['Miner fee', `${fmt.sats(o.onchain_fee_sat)} at ${o.fee_rate_sat_vb} sat/vB, charged on top`],
    ['Confirmations', String(o.required_confirmations)],
    ['Refund timeout', `${o.htlc_timeout_blocks} blocks (${fmt.blocksToTime(o.htlc_timeout_blocks)})`],
  ];
  return c.card({
    title: 'Your offer',
    meta: o.valid_for_secs != null ? `re-priced, valid ${fmt.duration(Math.max(0, o.valid_for_secs))}` : null,
  },
    c.detail(rows),
    // The advertised minimum is not always the configured one, and the difference is not the
    // operator's mistake -- it moves with the mempool. Say so where the number is.
    o.min_is_fee_driven
      ? el('div.small.muted', { style: { 'margin-top': 'var(--s-3)' } },
          `Your configured minimum is ${fmt.sats(o.min_amount_sat)}, but the engine never advertises a swap smaller than ten times its own on-chain cost, so the real minimum is ${fmt.sats(o.effective_min_amount_sat)} right now and moves with miner fees.`)
      : null);
}
