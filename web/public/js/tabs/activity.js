// Activity. Layer 3.
//
// One question: what happened, and to which swap?
//
// The "needs attention" section is deliberately hard to get into. A panel that raises a banner for
// every warning teaches people to ignore banners, so only five things qualify: an open swap nothing
// is driving, a realised or threatened loss, a write that failed, a reorg marker, and a stale error.
// A merely slow swap is in flight, and a swap that refunded cleanly is history.

import { el, fill } from '../dom.js';
import * as fmt from '../format.js';
import * as c from '../components.js';
import { api } from '../api.js';
import { track, stepList, describeSwap, exposureLine, timeoutLine, directionLabel, retryPhrase } from '../swapview.js';

let filter = 'all';
let search = '';

export default {
  id: 'activity',
  label: 'Activity',

  mount(root) {
    fill(root, el('div.stack', {},
      el('div', { attrs: { id: 'acAlarms' } }),
      el('div', { attrs: { id: 'acTable' } })));
  },

  render(root, snap) {
    fill(root.querySelector('#acAlarms'), alarmsCard(snap));
    fill(root.querySelector('#acTable'), tableCard(snap, root));
  },

  badge(snap) {
    const n = ((snap.swaps && snap.swaps.active) || []).length + ((snap.taker && snap.taker.swaps.active) || []).length;
    const attention = needsAttention(snap).length;
    return n ? { count: n, tone: attention ? 'bad' : null } : null;
  },
};

function allSwaps(snap) {
  const provider = ((snap.swaps && snap.swaps.active) || []).concat((snap.swaps && snap.swaps.recent) || [])
    .map((s) => ({ ...s, role: 'provider' }));
  const taker = ((snap.taker && snap.taker.swaps.active) || []).concat((snap.taker && snap.taker.swaps.recent) || [])
    .map((s) => ({ ...s, role: 'client' }));
  return [...provider, ...taker].sort((a, b) => b.updated_at_unix - a.updated_at_unix);
}

// Exported for the regression test: the membership rule here is the difference between an alarm
// that means something and one that cries wolf, and it has already been wrong once.
export function needsAttention(snap) {
  // The server's clock, when the snapshot carries one. Every timestamp compared here was stamped
  // by the daemon, so measuring them against the browser's clock imports whatever skew the viewing
  // device has into a decision about whether money is stuck.
  const now = snap.now_unix || Math.floor(Date.now() / 1000);
  return allSwaps(snap).filter((s) => {
    const terminal = ['claimed', 'refunded', 'expired', 'failed'].includes(s.state);
    if (!terminal && s.role === 'client' && snap.taker.state === 'idle') return true;
    if (s.reorg_seen_at_height && !terminal) return true;
    // The daemon's own verdict that it cannot drive this swap. Kept separate from the rule below
    // rather than folded into it: that one is arithmetic on a timestamp, and a swap in the recovery
    // loop keeps its timestamp fresh forever, so it would never qualify.
    if (s.needs_recovery && !terminal) return true;
    // Still load-bearing despite the clause above: a taker record carries no `needs_recovery` at
    // all, so this is the only thing that catches one that went quiet holding an error.
    if (s.last_error && !terminal && now - s.updated_at_unix > 600) return true;
    return false;
  });
}

function alarmsCard(snap) {
  const notices = snap.notices || [];
  const stuck = needsAttention(snap);
  if (!notices.length && !stuck.length) return null;

  return c.card({ title: 'Needs attention', tone: 'bad' },
    el('div.stack', { style: { gap: 'var(--s-3)' } },
      ...notices.map((n) => c.note(n.message, {
        tone: n.level === 'error' ? 'bad' : 'warn',
        // The daemon's own sentence, kept whole: it names the txid and the heights, which is the
        // part that lets an operator actually look into it.
        quoted: n.remedy || n.detail || null,
        actions: [c.button({
          label: 'Acknowledge', size: 'sm',
          onClick: async () => { await api.ackNotice(n.code); },
        })],
      })),
      // Two different things land in this list and they want opposite words. A record nothing is
      // driving needs someone to start driving it, and Resume does that. A swap the engine is
      // already retrying does not: "nothing is driving it" would be false, and offering Resume
      // would imply the operator can fix it by pressing a button.
      ...stuck.map((s) => {
        const retrying = Boolean(s.needs_recovery);
        return el('div.row', {},
          c.badge(s.role === 'client' ? 'yours' : 'served', s.role === 'client' ? 'accent' : 'idle'),
          el('span.num', { text: fmt.sats(s.onchain_amount_sat) }),
          track(s, { compact: true }),
          el('span.small.muted', {
            text: retrying
              ? [s.last_error || 'the engine cannot make progress', retryPhrase(s.next_retry_at_unix)]
                .filter(Boolean).join('. ')
              : 'open, and nothing is driving it',
          }),
          el('span.spacer'),
          retrying
            ? null
            : c.button({
              label: 'Resume', size: 'sm', variant: 'primary',
              onClick: async () => { await api.resumeSwaps(); },
            }));
      })));
}

const FILTERS = [
  ['all', 'All'],
  ['active', 'In flight'],
  ['claimed', 'Completed'],
  ['unwound', 'Unwound'],
  ['failed', 'Failed'],
];

function matches(swap) {
  if (filter === 'active') return !['claimed', 'refunded', 'expired', 'failed'].includes(swap.state);
  if (filter === 'unwound') return swap.state === 'refunded' || swap.state === 'expired';
  if (filter === 'claimed') return swap.state === 'claimed';
  if (filter === 'failed') return swap.state === 'failed';
  return true;
}

function searches(swap) {
  if (!search) return true;
  const hay = `${swap.swap_id} ${swap.peer} ${swap.funding || ''} ${swap.spend || ''}`.toLowerCase();
  return hay.includes(search);
}

function tableCard(snap, root) {
  const all = allSwaps(snap);
  const shown = all.filter((s) => matches(s) && searches(s));

  const pills = el('div.row', {}, ...FILTERS.map(([value, label]) =>
    el('button.btn', {
      text: label, dataset: { size: 'sm', variant: filter === value ? 'primary' : undefined },
      attrs: { type: 'button' },
      on: { click: () => { filter = value; rerender(root, snap); } },
    })));

  const searchInput = el('input', {
    attrs: { type: 'search', placeholder: 'Filter by pubky, txid or swap id', value: search, 'aria-label': 'Search swaps' },
  });
  searchInput.addEventListener('input', () => { search = searchInput.value.trim().toLowerCase(); rerender(root, snap); });

  if (!all.length) {
    return c.card({ title: 'Activity' },
      c.empty({
        title: 'No swaps yet.',
        body: 'Swaps you provide and swaps you take both land here.',
      }));
  }

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: '' }),
      el('th', { text: 'Direction' }),
      el('th', { text: 'Amount' }),
      el('th', { text: 'Counterparty' }),
      el('th', { text: 'Progress' }),
      el('th', { text: 'Fee' }),
      el('th', { text: 'Updated' }))),
    el('tbody', {}, ...shown.map((swap) => row(swap, snap))));

  // Counting the same thing twice reads as a contradiction: the shown rows include swaps still in
  // flight, while finished_total counts only the ones that ended. Say what each number is.
  const finished = snap.swaps && snap.swaps.finished_total;
  const meta = shown.length === all.length
    ? (finished ? `${all.length} here, ${finished} finished in total` : `${all.length} swaps`)
    : `${shown.length} of ${all.length} shown`;

  return c.card({ title: 'Activity', meta },
    el('div.row', { style: { 'margin-bottom': 'var(--s-3)' } }, pills, el('span.spacer'), searchInput),
    shown.length
      ? el('div.table-wrap', {}, table)
      : c.empty({
          title: 'No swaps match this filter.',
          action: c.button({ label: 'Clear filter', onClick: () => { filter = 'all'; search = ''; rerender(root, snap); } }),
        }),
    snap.swaps && snap.swaps.recent_limit
      ? el('p.small.faint', { style: { 'margin-top': 'var(--s-3)' },
          text: `The engine keeps the ${snap.swaps.recent_limit} most recent finished swaps for this view; older ones live in its records.` })
      : null);
}

function rerender(root, snap) {
  fill(root.querySelector('#acTable'), tableCard(snap, root));
}

function row(swap, snap) {
  const d = describeSwap(swap);
  const tr = el('tr.clickable', {
    attrs: { tabindex: '0', role: 'button', 'aria-label': `${directionLabel(swap.direction, { role: swap.role })}, ${fmt.sats(swap.onchain_amount_sat)}, ${d.headline}` },
  },
    el('td', {}, c.badge(swap.role === 'client' ? 'yours' : 'served', swap.role === 'client' ? 'accent' : 'idle')),
    // Which way the sats went. Without it the table says how much and to whom and never what
    // happened, and the two directions put your money in opposite places.
    el('td.small.muted', { text: directionLabel(swap.direction, { role: swap.role, short: true }) }),
    el('td.num', { text: fmt.sats(swap.onchain_amount_sat) }),
    el('td.mono.small', { text: fmt.shortKey(swap.peer) }),
    el('td', {}, el('div.row', { style: { gap: 'var(--s-2)' } }, track(swap, { compact: true }), el('span.small.muted', { text: d.headline }))),
    el('td.num', { text: swap.state === 'claimed' && swap.role === 'provider' ? `+${fmt.sats(swap.service_fee_sat, { unit: false })}` : '—' }),
    el('td.small.muted', { text: fmt.relTime(swap.updated_at_unix) }));

  const open = () => detailModal(swap, snap);
  tr.addEventListener('click', open);
  tr.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
  });
  return tr;
}

function detailModal(swap, snap) {
  const d = describeSwap(swap);
  const explorer = snap.settings.explorerLinks;
  const tip = null; // The chain tip is not on the status API; no time claim without it.

  const money = swap.role === 'provider'
    ? [
      ['Amount', fmt.sats(swap.onchain_amount_sat)],
      ['Your fee', `+${fmt.sats(swap.service_fee_sat)}`],
      ['Miner cost', `${fmt.sats(swap.onchain_fee_sat)} (priced at quote time, not measured)`],
    ]
    : [
      ['Amount', fmt.sats(swap.onchain_amount_sat)],
      ['Total committed', swap.quote_total_sat ? fmt.sats(swap.quote_total_sat) : null],
      ['Their fee', fmt.sats(swap.service_fee_sat + swap.onchain_fee_sat)],
    ];

  const m = c.modal({
    title: `${directionLabel(swap.direction, { role: swap.role })} · ${fmt.sats(swap.onchain_amount_sat)}`,
    body: el('div', {},
      el('div', { style: { 'margin-bottom': 'var(--s-3)' } }, track(swap)),
      el('p', { text: d.headline }),
      d.sub ? el('p.small.muted', { text: d.sub }) : null,
      d.kind === 'failed' && d.reason
        ? c.note('The engine said:', { tone: 'bad', quoted: d.reason })
        : null,
      d.kind === 'recovery'
        ? c.note(
          [
            'The engine cannot make progress on this swap and is retrying on its own.',
            retryPhrase(d.retryAt),
            d.retries ? `${d.retries} attempts so far.` : null,
          ].filter(Boolean).join(' '),
          { tone: 'bad', title: 'Needs recovery', quoted: d.reason || null })
        : null,
      d.kind === 'stalled'
        ? c.note(
          swap.awaiting_invoice
            // Worth separating from an ordinary quiet swap: this one is not waiting on anybody, so
            // "it may still complete" would send an operator off to check the wrong side.
            ? `No movement for ${fmt.duration(d.stalledFor)}. The invoice was never created, so there is nothing for the other side to pay. The engine retries this when the provider restarts.`
            : `No movement for ${fmt.duration(d.stalledFor)}. It may still complete; nothing here says it failed.`,
          { tone: 'warn' })
        : null,
      el('p.small.muted', { text: exposureLine(swap, { role: swap.role }) }),
      stepList(swap),
      el('div.card-foot', {},
        c.detail([
          ...money,
          ['Counterparty', c.copyText(swap.peer, { short: true })],
          ['Swap id', c.copyText(swap.swap_id, { short: true })],
          ['Funding', swap.funding ? c.copyText(swap.funding, { short: true }) : 'not broadcast'],
          ['Spend', swap.spend ? c.copyText(swap.spend, { short: true }) : 'not broadcast'],
          ['Timeout', timeoutLine(swap, tip)],
          ['Confirmations required', swap.required_confirmations || null],
          ['Reorg', swap.reorg_seen_at_height ? `seen at height ${swap.reorg_seen_at_height}` : null],
          // Only a live swap can carry one: the engine clears `last_error` on every write that moves
          // the state, so a record that reached any outcome has none. Labelled rather than presented
          // as a cause: it is the *last* error, not necessarily the reason for anything.
          ['Last error', swap.last_error || null],
          ['Retries', swap.retry_count || null],
          ['Started', swap.created_at_unix ? fmt.absTime(swap.created_at_unix) : null],
          ['Took', swap.created_at_unix && swap.updated_at_unix > swap.created_at_unix
            ? fmt.duration(swap.updated_at_unix - swap.created_at_unix)
            : null],
          ['Updated', `${fmt.relTime(swap.updated_at_unix)} · ${fmt.absTime(swap.updated_at_unix)}`],
          ['Technical', `${swap.direction} swap, as the ${swap.role === 'client' ? 'taker' : 'provider'}`],
        ]))),
    actions: [c.button({ label: 'Close', onClick: () => m.close() })],
  });
}
