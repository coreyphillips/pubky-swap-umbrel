// Showing a swap honestly. Layer 2.
//
// The state enum is shared between the two directions, but the paths through it are not, and the
// difference is not cosmetic. Reading the provider's progress sink settles it: `lockup_pending` is
// only ever written when *we* broadcast the funding, which happens only in a reverse swap;
// `invoice_pending` is only written when we pay an invoice, which happens only in a submarine one;
// and `claim_pending` is never written at all, because the call that broadcasts a spend
// deliberately leaves the state alone -- the same call fires for a claim and for a refund, and
// labelling a refund "claim pending" would describe it as the opposite of what it is.
//
// So a single seven-step bar would render two dead nodes on every swap. Two five-step tracks render
// none, and they stay visually comparable side by side in a table.
//
// The second idea here is `who`. Each step records whose move it is, and that drives the motion:
// when we are the ones acting the dot pulses and the connector marches, and when we are waiting on
// the counterparty everything is still. Movement means work is happening on our side.

import { el } from './dom.js';
import * as fmt from './format.js';

const SUBMARINE = [
  { key: 'created', who: 'them', label: 'Quoted', note: 'waiting for their on-chain lockup' },
  { key: 'lockup_confirmed', who: 'us', label: 'Their lockup confirmed', note: 'about to pay their invoice' },
  { key: 'invoice_pending', who: 'us', label: 'Paying their invoice' },
  { key: 'invoice_paid', who: 'us', label: 'Invoice paid', note: 'sweeping the on-chain HTLC' },
  { key: 'claimed', who: 'us', label: 'Swept on-chain', terminal: true },
];

const REVERSE = [
  { key: 'created', who: 'them', label: 'Invoice issued', note: 'waiting for them to pay it' },
  { key: 'lockup_pending', who: 'us', label: 'Funding broadcast' },
  { key: 'lockup_confirmed', who: 'them', label: 'Funding confirmed', note: 'waiting for them to claim' },
  { key: 'invoice_paid', who: 'us', label: 'They claimed on-chain', note: 'settling the invoice' },
  { key: 'claimed', who: 'us', label: 'Invoice settled', terminal: true },
];

/**
 * How long a state can sit unchanged before it is worth mentioning.
 *
 * Per state, because "no movement" means very different things at different points: an unpaid
 * invoice after ten minutes is notable, a funded HTLC waiting out a counterparty's claim window is
 * not.
 */
const STALL_SECS = {
  created: 10 * 60,
  lockup_pending: 30 * 60,
  lockup_confirmed: 4 * 3600,
  invoice_pending: 15 * 60,
  invoice_paid: 60 * 60,
};

const TONES = {
  us: { tone: 'var(--info)', dim: 'var(--info-dim)' },
  them: { tone: 'var(--warn)', dim: 'var(--warn-dim)' },
};

export function stepsFor(direction) {
  return direction === 'submarine' ? SUBMARINE : REVERSE;
}

/**
 * Everything the renderers need, derived once.
 *
 * `kind` separates two things that look alike and are not: a swap that *failed* is a fact the
 * daemon reported and wrote down, and a swap that is merely *stalled* is arithmetic we did on a
 * timestamp. The first is terminal and red and quotes the daemon; the second keeps its live colours
 * and says only how long it has been quiet.
 */
export function describeSwap(swap, { nowUnix = Math.floor(Date.now() / 1000) } = {}) {
  const steps = stepsFor(swap.direction);
  const index = steps.findIndex((s) => s.key === swap.state);
  const age = nowUnix - (swap.updated_at_unix || nowUnix);

  if (swap.state === 'claimed') {
    return base('settled', steps, steps.length - 1, 'ok', 'Completed', null);
  }
  if (swap.state === 'refunded' || swap.state === 'expired') {
    // Not red. Nothing went wrong: the timelock fired and the protocol did what it promised.
    const reached = index >= 0 ? index : Math.max(0, steps.length - 3);
    return base('unwound', steps, reached, 'idle',
      swap.state === 'refunded' ? 'Refunded' : 'Expired',
      swap.state === 'refunded'
        ? 'The swap did not complete and the funds went back.'
        : 'The swap expired before it started.');
  }
  if (swap.state === 'failed') {
    const reached = index >= 0 ? index : 0;
    return base('failed', steps, reached, 'bad', 'Failed', swap.state_detail || null);
  }
  if (index < 0) {
    // A state that cannot occur on this direction. Say so rather than inventing a position for it.
    return {
      kind: 'unknown', steps, index: -1, who: null, tone: 'idle',
      headline: fmt.titleCase(swap.state),
      sub: 'An unexpected state for this direction.',
      reason: null, stalledFor: null,
    };
  }

  const step = steps[index];
  const limit = STALL_SECS[swap.state];
  const stalled = limit != null && age > limit;
  return {
    kind: stalled ? 'stalled' : 'progress',
    steps,
    index,
    who: step.who,
    tone: step.who === 'us' ? 'info' : 'warn',
    headline: step.label,
    sub: step.note || null,
    reason: null,
    stalledFor: stalled ? age : null,
  };
}

function base(kind, steps, index, tone, headline, sub) {
  return { kind, steps, index, who: null, tone, headline, sub, reason: sub, stalledFor: null };
}

/** The compact dotted track, for a table row or a card header. */
export function track(swap, { compact = false } = {}) {
  const d = describeSwap(swap);
  const node = el('div.track' + (compact ? '.compact' : ''), {
    attrs: {
      role: 'img',
      'aria-label': trackLabel(swap, d),
    },
  });
  if (d.kind === 'unknown') {
    node.appendChild(el('span.small.faint', { text: fmt.titleCase(swap.state) }));
    return node;
  }
  if (d.kind === 'failed') node.classList.add('frozen');

  const palette = TONES[d.who] || null;
  if (palette) {
    node.style.setProperty('--tone', palette.tone);
    node.style.setProperty('--tone-dim', palette.dim);
  }

  d.steps.forEach((step, i) => {
    if (i > 0) {
      const conn = el('span.track-conn');
      if (i <= d.index) conn.classList.add('done');
      // Marching only into the step we are actively working on.
      if (i === d.index && d.who === 'us' && d.kind === 'progress') conn.classList.add('active');
      node.appendChild(conn);
    }
    const wrap = el('span.track-step', {
      dataset: { who: step.who },
      attrs: { title: step.label },
    }, el('span.track-dot'));
    if (i < d.index || d.kind === 'settled') wrap.classList.add('done');
    else if (i === d.index) wrap.classList.add('current');
    node.appendChild(wrap);
  });

  if (d.kind === 'unwound') {
    node.appendChild(el('span.track-conn.back'));
    node.appendChild(el('span.track-cap', { text: d.headline.toLowerCase(), dataset: { kind: 'unwound' } }));
  } else if (d.kind === 'failed') {
    node.appendChild(el('span.track-cap', { text: 'failed', dataset: { kind: 'failed' } }));
  }
  return node;
}

function trackLabel(swap, d) {
  if (d.kind === 'settled') return 'Completed';
  if (d.kind === 'failed') return `Failed: ${d.reason || 'no reason given'}`;
  if (d.kind === 'unwound') return d.headline;
  if (d.index < 0) return d.headline;
  return `Step ${d.index + 1} of ${d.steps.length}: ${d.headline}`;
}

/** The expanded step list, for a detail view. */
export function stepList(swap) {
  const d = describeSwap(swap);
  const list = el('div.steps');
  d.steps.forEach((step, i) => {
    const done = i < d.index || d.kind === 'settled';
    const current = i === d.index && d.kind !== 'settled';
    const mark = done ? 'ok' : current ? '' : '';
    const row = el('div.step' + (done || current ? '' : '.pending'), {},
      el('span.step-mark', {},
        done
          ? el('span.checkmark', { text: 'ok', dataset: { status: 'pass' } })
          : el('span.track-dot')),
      el('div', {},
        el('div.step-title', { text: step.label }),
        current && step.note ? el('div.step-meta', { text: step.note }) : null,
        current && d.who ? el('div.step-meta', {
          text: d.who === 'us' ? 'Your node is working on this.' : 'Waiting on the other side.',
        }) : null));
    list.appendChild(row);
  });
  return list;
}

/**
 * What is at stake, in one sentence, for this direction at this point.
 *
 * The most operator-relevant line in the whole app, and the only one that answers "is my money
 * currently exposed" without making someone reason about HTLCs.
 */
export function exposureLine(swap, { role = 'provider' } = {}) {
  const amount = fmt.sats(swap.onchain_amount_sat);
  const funded = ['lockup_pending', 'lockup_confirmed', 'invoice_pending', 'invoice_paid'].includes(swap.state);
  if (swap.state === 'claimed') return 'Settled. Nothing is at stake.';
  if (swap.state === 'refunded' || swap.state === 'expired') return 'Unwound. The funds came back.';

  if (role === 'client') {
    if (swap.direction === 'submarine') {
      return funded
        ? `${amount} of yours is locked in the swap address until this completes or the timeout passes.`
        : 'Nothing of yours is locked on-chain yet.';
    }
    return funded
      ? 'Your Lightning payment is held until the on-chain side lands. Nothing of yours is locked on-chain.'
      : 'Nothing of yours has moved yet.';
  }
  if (swap.direction === 'reverse') {
    return funded ? `${amount} of yours is committed on-chain.` : 'Nothing of yours is committed yet.';
  }
  return funded
    ? 'Their coins are locked on-chain; nothing of yours is committed until you pay their invoice.'
    : 'Nothing of yours is committed.';
}

export function directionLabel(direction, { role = 'provider' } = {}) {
  if (role === 'client') {
    return direction === 'submarine' ? 'Send on-chain' : 'Receive on-chain';
  }
  return direction === 'submarine' ? 'They sent on-chain' : 'They received on-chain';
}

export function directionArrow(direction) {
  return direction === 'submarine' ? 'down' : 'up';
}

/** Blocks left before the refund branch opens, when we know the tip. */
export function timeoutLine(swap, tipHeight) {
  if (!swap.timeout_height) return null;
  if (!tipHeight) return `Refund opens at block ${swap.timeout_height.toLocaleString()}.`;
  const left = swap.timeout_height - tipHeight;
  if (left <= 0) return `The refund branch opened at block ${swap.timeout_height.toLocaleString()}.`;
  return `Refund opens at block ${swap.timeout_height.toLocaleString()}, about ${left} block${left === 1 ? '' : 's'} away (${fmt.blocksToTime(left)}).`;
}

export { STALL_SECS };
