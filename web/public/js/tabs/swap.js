// Swap. Layer 3.
//
// One question: what will this cost me, and is this provider actually live?
//
// The words here are the taker's, not the protocol's. Nobody thinks in submarine and reverse; they
// think about which side their sats end up on. The technical names appear exactly twice in the whole
// panel, both in a details block, so the UI can still be matched up with the logs.

import { el, fill } from '../dom.js';
import * as fmt from '../format.js';
import * as c from '../components.js';
import { api } from '../api.js';
import { toast, announce } from '../toast.js';
import { track, stepList, exposureLine, describeSwap } from '../swapview.js';

let form = null;
let quote = null;
let quoteError = null;

export default {
  id: 'swap',
  label: 'Swap',

  mount(root) {
    fill(root, el('div.stack', {},
      el('div', { attrs: { id: 'swRecovery' } }),
      el('div', { attrs: { id: 'swForm' } }),
      el('div', { attrs: { id: 'swLive' } })));
  },

  render(root, snap) {
    fill(root.querySelector('#swRecovery'), recoveryCard(snap));
    // The form holds typed input, so it is built once and left alone.
    if (!form) fill(root.querySelector('#swForm'), formCard(snap));
    fill(root.querySelector('#swLive'), liveCard(snap));
  },

  deactivate() { form = null; quote = null; quoteError = null; },
};

/**
 * Interrupted swaps, first and unmissable.
 *
 * A swap left open still has money in it, and the record on disk holds the only key that can get it
 * back. This is the highest-stakes thing this panel ever has to say.
 */
function recoveryCard(snap) {
  const open = (snap.taker.swaps.active || []).filter((s) => describeSwap(s).kind !== 'progress' || snap.taker.state === 'idle');
  const unfinished = snap.taker.unfinished;
  if (!unfinished || snap.taker.state === 'resuming') {
    if (snap.taker.state === 'resuming') {
      return c.card({ title: 'Finishing an earlier swap', tone: 'warn' },
        el('p.muted', { text: 'A swap left open by an earlier run is being driven to completion. This needs your node reachable, and can take up to a day if it ends in a refund.' }));
    }
    return null;
  }
  return c.card({ title: 'Needs attention', tone: 'bad' },
    el('p', { text: `${unfinished} swap${unfinished === 1 ? ' is' : 's are'} still open and nothing is driving ${unfinished === 1 ? 'it' : 'them'} right now.` }),
    el('p.small.muted', { text: 'The records for these swaps hold the only keys that can recover the funds committed to them. Do not delete this app\'s data while any are open.' }),
    el('div.actions', {},
      c.button({
        label: 'Resume now', variant: 'primary', busyLabel: 'Resuming',
        onClick: async () => { await api.resumeSwaps(); toast('Resuming', 'ok'); },
      })));
}

function formCard(snap) {
  if (!snap.setup.configured) {
    return c.card({ title: 'Swap with a provider' },
      c.note('Load your Pubky identity first. Swapping needs one, even as a taker.', { tone: 'idle' }));
  }

  let direction = 'reverse';
  const directionPicker = c.segmented({
    value: direction,
    onChange: (v) => { direction = v; quote = null; refreshQuoteBox(); },
    options: [
      {
        value: 'reverse',
        title: 'Receive on-chain',
        body: 'Pay from your Lightning balance and get sats on-chain. Your payment is held until the on-chain side lands, so nothing of yours is locked on-chain.',
      },
      {
        value: 'submarine',
        title: 'Send on-chain',
        body: 'Lock sats on-chain and get Lightning balance. If it goes wrong you get them back, but only after the timeout, which is about a day.',
      },
    ],
  });

  const providerInput = el('input', {
    attrs: { type: 'text', placeholder: 'their pubky', autocomplete: 'off', spellcheck: 'false' },
    class: 'mono',
  });
  const amount = c.numberField({ label: 'Amount', value: 50000, min: 1, max: 1e12, unit: 'sat' });
  const quoteBox = el('div', { style: { 'margin-top': 'var(--s-4)' } });

  function input() {
    return { provider: providerInput.value.trim(), direction, amount: amount.read() };
  }

  function refreshQuoteBox() {
    fill(quoteBox, quote ? quoteCard(quote, snap) : quoteError ? quoteErrorNote(quoteError) : null);
  }

  const check = c.button({
    label: 'Check this provider', busyLabel: 'Checking',
    onClick: async () => {
      const i = input();
      if (!i.provider) return toast('Paste the provider\'s pubky', 'bad');
      if (!i.amount) return toast('Enter an amount', 'bad');
      quote = null; quoteError = null;
      fill(quoteBox, c.skeleton({ height: 160 }),
        el('p.small.faint', { style: { 'margin-top': 'var(--s-2)' } },
          'Messages travel over Pubky relays, so this can take up to a minute even when the provider is perfectly healthy.'));
      try {
        const res = await api.quote(i);
        if (res.ok) { quote = { ...res.quote, input: i }; quoteError = null; }
        else { quote = null; quoteError = { message: res.error, detail: res.detail }; }
      } catch (e) {
        quote = null;
        quoteError = { message: e.message, detail: e.remedy };
      }
      refreshQuoteBox();
    },
  });

  form = { input, refreshQuoteBox };

  return c.card({ title: 'Swap with a provider' },
    el('p.muted', { text: 'This moves your own funds through your own node. Ask for a price first: a quote costs nothing and moves nothing.' }),
    c.field({ label: 'Which way', control: el('div', {}, directionPicker) }),
    c.field({ label: 'Provider pubky', control: providerInput, hint: 'They share this from their own Earn tab.' }),
    amount,
    el('div.actions', {}, check),
    quoteBox);
}

function quoteErrorNote(err) {
  return c.note(err.message, {
    tone: 'bad',
    title: 'No quote',
    // The engine's refusals are specific and better than anything this app would write.
    quoted: err.detail || null,
  });
}

function quoteCard(q, snap) {
  const receiving = q.input.direction === 'reverse';
  const rows = [
    ['You pay', fmt.sats(receiving ? q.total_sat : q.total_sat)],
    ['You receive', fmt.sats(q.amount_sat)],
    ['Their fee', `${fmt.sats(q.fee_sat)} (${((q.fee_sat / q.amount_sat) * 100).toFixed(2)}%)`],
    ['Confirmations', `${q.confirmations}, about ${fmt.duration(q.confirmations * 600)}`],
    ['Refund timeout', `${q.timeout_blocks} blocks (${fmt.blocksToTime(q.timeout_blocks)})`],
  ];
  if (q.service_fee_sat != null) {
    rows.splice(3, 0, ['Service fee', fmt.sats(q.service_fee_sat)]);
    rows.splice(4, 0, ['Miner fee', fmt.sats(q.onchain_fee_sat)]);
  }

  return el('div', { attrs: { 'aria-live': 'polite' } },
    c.card({ title: 'Quote', actions: [c.badge('live provider', 'ok', { dot: true })] },
      c.detail(rows),
      q.service_fee_sat == null
        ? el('p.small.faint', { style: { 'margin-top': 'var(--s-3)' } },
            'Their fee includes the miner fee they expect to pay on your behalf.')
        : null,
      el('div.actions', {},
        c.button({
          label: 'Review and confirm', variant: 'primary',
          onClick: () => confirmSwap(q, snap),
        }))));
}

/**
 * The confirmation, written per direction.
 *
 * Not one screen with a variable in it: what is at stake genuinely differs. A reverse swap holds a
 * Lightning payment and locks nothing on-chain; a submarine swap locks the operator's own coins for
 * up to a day and depends on a key that exists in exactly one place. The button carries the amount,
 * so the last thing read before committing is the number.
 */
function confirmSwap(q, snap) {
  const receiving = q.input.direction === 'reverse';
  const steps = receiving
    ? [
      `You pay a Lightning invoice for ${fmt.sats(q.total_sat)}. It is a hold invoice: the money leaves your channels but is not settled yet.`,
      `The provider locks ${fmt.sats(q.amount_sat)} in an on-chain swap address.`,
      `You wait ${q.confirmations} confirmation${q.confirmations === 1 ? '' : 's'}, about ${fmt.duration(q.confirmations * 600)}.`,
      'Your node claims it, and the Lightning payment settles.',
    ]
    : [
      `Your node issues a Lightning invoice for ${fmt.sats(q.amount_sat)}.`,
      `You lock ${fmt.sats(q.total_sat)} on-chain in a swap address.`,
      `You wait ${q.confirmations} confirmation${q.confirmations === 1 ? '' : 's'}, about ${fmt.duration(q.confirmations * 600)}.`,
      'The provider pays your invoice and takes the on-chain coins.',
    ];

  const stake = receiving
    ? [
      `Your ${fmt.sats(q.total_sat)} is held over Lightning for as long as this takes, typically twenty to forty minutes. Nothing of yours is locked on-chain.`,
      'If the provider disappears after you pay, the hold invoice is cancelled and your payment comes back.',
    ]
    : [
      `Your ${fmt.sats(q.total_sat)} sits in an on-chain address that only two keys can move: the provider's, once they pay your invoice, and yours, after ${q.timeout_blocks} blocks -- about ${fmt.blocksToTime(q.timeout_blocks).replace('~', '')}.`,
      'If anything goes wrong you get your coins back, but you wait out those blocks. There is no way to speed that up.',
      'Your refund key is written to this app\'s data directory before any coins move, and it exists nowhere else. Deleting that directory while this swap is open would make the coins unspendable by anyone.',
    ];

  const m = c.modal({
    title: receiving ? `Receive ${fmt.sats(q.amount_sat)} on-chain` : `Send ${fmt.sats(q.amount_sat)} on-chain`,
    body: el('div', {},
      el('h3', { text: 'What happens', style: { 'font-size': 'var(--t-sm)', margin: 'var(--s-3) 0 var(--s-2)' } }),
      el('ol.muted', { style: { margin: '0 0 var(--s-4)', 'padding-left': '20px' } },
        ...steps.map((s) => el('li', { text: s, style: { 'margin-bottom': '4px' } }))),
      el('h3', { text: 'What is at stake', style: { 'font-size': 'var(--t-sm)', margin: '0 0 var(--s-2)' } }),
      ...stake.map((s) => el('p.small.muted', { text: s })),
      c.detail([
        ['With', fmt.shortKey(q.input.provider, 8)],
        ['Total', fmt.sats(q.total_sat)],
        ['Payout to', 'your LND wallet'],
      ])),
    actions: [
      c.button({ label: 'Back', onClick: () => m.close() }),
      c.button({
        // The verb and the number, on the button itself.
        label: receiving ? `Pay ${fmt.sats(q.total_sat)}` : `Lock ${fmt.sats(q.total_sat)} on-chain`,
        variant: 'primary',
        busyLabel: 'Starting',
        onClick: async () => {
          try {
            await api.swap(q.input);
            m.close();
            toast('Swap started', 'ok');
            announce('Swap started.');
          } catch (e) {
            toast(e.message, 'bad');
          }
        },
      }),
    ],
  });
}

/** The in-flight view, driven by the record on disk rather than by scraping prose. */
function liveCard(snap) {
  const t = snap.taker;
  if (t.state === 'idle' && !t.runs.length) return null;

  const active = (t.swaps.active || [])[0];
  const running = t.state === 'swapping' || t.state === 'resuming';

  if (!running && t.runs.length) {
    const last = t.runs[0];
    if (!active) return outcomeCard(last);
  }
  if (!running && !active) return null;

  const current = t.current || {};
  return c.card({
    title: 'This swap',
    actions: [c.badge(running ? 'in flight' : 'open', running ? 'info' : 'warn', { dot: true, pulse: running })],
  },
    active ? el('div', { style: { 'margin-bottom': 'var(--s-3)' } }, track(active)) : null,
    active ? el('p.small.muted', { text: exposureLine(active, { role: 'client' }) }) : null,
    active ? stepList(active) : el('p.muted', { text: 'Negotiating with the provider. This can take up to ninety seconds.' }),
    el('div.actions', {}, cancelButton(snap, active)));
}

/**
 * Cancel, in the only two honest forms it has.
 *
 * Before a record exists, nothing has been sent and nothing signed: cancelling really does cancel.
 * After one exists, stopping the process does not undo the swap -- it only stops watching it -- and
 * the old panel's single "Cancel" button did the second while claiming to do the first, then
 * reported the result as a failure.
 */
function cancelButton(snap, active) {
  const committed = Boolean(snap.taker.current && snap.taker.current.funds_committed) || Boolean(active);
  if (!committed) {
    return c.button({ label: 'Cancel', onClick: async () => { await api.cancelSwap(false); toast('Cancelled. Nothing moved.'); } });
  }
  return c.button({
    label: 'Stop watching', variant: 'danger',
    onClick: () => {
      const m = c.modal({
        title: 'Stop watching this swap?',
        body: el('div', {},
          el('p', { text: 'This swap already exists on disk, so stopping the process does not undo it. The swap stays open; it just stops being driven.' }),
          el('p.small.muted', { text: 'The record holds the only key that can recover your funds, and this app resumes it automatically the next time it runs. Until then nothing is broadcasting a refund on your behalf.' })),
        actions: [
          c.button({ label: 'Keep watching', onClick: () => m.close() }),
          c.button({
            label: 'Stop watching', variant: 'danger',
            onClick: async () => { m.close(); await api.cancelSwap(true); toast('Stopped. The swap is still open.', 'bad'); },
          }),
        ],
      });
    },
  });
}

const OUTCOMES = {
  succeeded: ['ok', 'Swap complete', 'The funds arrived.'],
  refunded: ['idle', 'Refunded', 'The swap unwound and your funds came back.'],
  failed: ['bad', 'Swap failed', null],
  interrupted: ['bad', 'Still open', 'Nothing is driving this swap right now.'],
  cancelled: ['idle', 'Cancelled', 'Nothing moved.'],
  nothing_happened: ['warn', 'Nothing happened', 'No funds moved. This is a configuration problem in the app, not something you did.'],
  unknown: ['warn', 'Outcome unclear', 'The swap engine exited without saying what happened, and no record was written. Nothing observed says the swap completed.'],
};

function outcomeCard(run) {
  const [tone, title, body] = OUTCOMES[run.outcome] || ['idle', fmt.titleCase(run.outcome || 'finished'), null];
  return c.card({ title: 'Last swap', actions: [c.badge(title, tone)] },
    c.detail([
      ['Direction', run.direction === 'submarine' ? 'Send on-chain' : 'Receive on-chain'],
      ['Amount', fmt.sats(run.amount_sat)],
      ['With', run.provider ? fmt.shortKey(run.provider, 8) : null],
      ['Finished', run.finished_at_unix ? fmt.relTime(run.finished_at_unix) : null],
    ]),
    body ? el('p.small.muted', { style: { 'margin-top': 'var(--s-3)' }, text: body }) : null,
    run.detail ? c.note('The engine said:', { tone, quoted: run.detail }) : null);
}
