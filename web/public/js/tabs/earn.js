// Earn. Layer 3.
//
// One question: how much have I made, and what am I charging?
//
// The rate editor lives here rather than in Settings because it is the maker's economic control and
// belongs next to the outcome it produces. Settings holds identity, backends and danger.

import { el, fill } from '../dom.js';
import * as fmt from '../format.js';
import * as c from '../components.js';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { describeProvider, providerControls } from '../providerstate.js';

let fields = null;
let dirty = false;

export default {
  id: 'earn',
  label: 'Earn',

  mount(root) {
    fill(root, el('div.stack', {},
      el('div', { attrs: { id: 'earnState' } }),
      el('div', { attrs: { id: 'earnEarnings' } }),
      el('div', { attrs: { id: 'earnRates' } }),
      el('div', { attrs: { id: 'earnOffer' } })));
  },

  render(root, snap) {
    fill(root.querySelector('#earnState'), providerCard(snap));
    fill(root.querySelector('#earnEarnings'), earningsCard(snap));
    // Never rebuild the form while it holds unsaved edits.
    if (!dirty) fill(root.querySelector('#earnRates'), ratesCard(snap));
    fill(root.querySelector('#earnOffer'), offerCard(snap));
  },

  deactivate() { dirty = false; fields = null; },
};

/**
 * The provider's state, told honestly.
 *
 * "Running" is not one state. A provider that is up but cannot execute quotes happily and rejects
 * every swap; a provider that refused to start because it would abandon funded swaps looks exactly
 * like a crash loop and is the opposite of one. Each gets its own words and its own next step.
 */
function providerCard(snap) {
  const p = snap.provider;
  const role = snap.settings.role;

  if (role === 'taker') {
    return c.card({ title: 'Provider' },
      c.note('This node is set up to swap its own funds only, so it is not advertising anything.', {
        tone: 'idle',
        actions: [c.button({
          label: 'Start earning too', variant: 'primary',
          onClick: async () => {
            await api.saveSettings({ role: 'both' });
            await api.startProvider();
            toast('Provider starting', 'ok');
          },
        })],
      }));
  }

  const { label, tone, body } = describeProvider(snap);

  return c.card({ title: 'Provider', actions: [c.badge(label, tone, { dot: true, pulse: tone === 'ok' })] },
    el('p.muted', { text: body }),
    p.fatal ? c.note('The engine said:', { tone: 'bad', quoted: p.fatal.message }) : null,
    p.restartInSecs != null ? el('p.small.muted', { text: `Next attempt in ${p.restartInSecs}s.` }) : null,
    el('div.actions', {}, ...providerControls(snap)));
}

function earningsCard(snap) {
  const e = snap.earnings;
  if (!e) return c.card({ title: 'Earnings' }, c.skeleton({ height: 80 }));

  return c.card({ title: 'Earnings' },
    el('div.grid.c3', {},
      c.stat({ label: 'Fees earned', value: fmt.sats(e.service_fee_sat, { unit: false }), unit: 'sat', hero: true }),
      c.stat({ label: 'Volume swapped', value: fmt.satsCompact(e.volume_sat) }),
      c.stat({ label: 'Completed', value: String(e.completed) })),
    el('div.card-foot', {},
      el('div.small.muted', {
        text: `${e.completed} completed  ·  ${e.refunded_or_expired} refunded or expired  ·  ${e.failed} failed. Refunded and expired swaps earned nothing and still cost a miner fee.`,
      }),
      // Upstream is careful to call this figure "expected" rather than measured, and that care is
      // worth carrying through rather than quietly presenting an estimate as a result.
      el('div.small.faint', { style: { 'margin-top': 'var(--s-2)' } },
        `These swaps were priced to cost about ${fmt.sats(e.expected_onchain_cost_sat)} on chain. What they actually cost is only knowable from the transactions themselves, so this is the estimate the quotes were built on, not a measurement.`)));
}

function ratesCard(snap) {
  const s = snap.settings;
  const o = snap.offer;

  const base = c.numberField({ label: 'Flat fee', value: s.baseFee, min: 0, max: 1e9, unit: 'sat', onInput: onEdit });
  // Labelled for what it is rather than for its unit: "Percentage" over a box containing 2500 and
  // a hint reading 0.25% reads as a contradiction.
  const ppm = c.numberField({
    label: 'Proportional fee', value: s.feePpm, min: 0, max: 1e7, unit: 'ppm', onInput: onEdit,
    hint: `${(s.feePpm / 10000).toFixed(2)}% of the swap amount`,
  });
  const min = c.numberField({ label: 'Smallest swap', value: s.minAmount, min: 1, max: 1e12, unit: 'sat', onInput: onEdit });
  const max = c.numberField({ label: 'Largest swap', value: s.maxAmount, min: 1, max: 1e12, unit: 'sat', onInput: onEdit });

  const directions = el('select', {}, ...[
    ['submarine,reverse', 'Both directions'],
    ['submarine', 'They send on-chain only'],
    ['reverse', 'They receive on-chain only'],
  ].map(([value, label]) => el('option', { text: label, attrs: { value, selected: value === s.directions || undefined } })));
  directions.addEventListener('change', onEdit);

  fields = { base, ppm, min, max, directions };

  const example = el('div.small.muted');
  const updateExample = () => {
    const b = base.read() ?? s.baseFee;
    const p = ppm.read() ?? s.feePpm;
    const rows = [100000, 500000, 1000000]
      .map((amount) => `${fmt.sats(amount)} swap: you earn ${fmt.sats(fmt.feeOn(amount, b, p))}`)
      .join('  ·  ');
    example.textContent = rows;
  };
  base.input.addEventListener('input', updateExample);
  ppm.input.addEventListener('input', updateExample);
  updateExample();

  const status = el('div.small.muted');
  const save = c.button({
    label: 'Save rates', variant: 'primary', busyLabel: 'Saving',
    onClick: async () => {
      for (const f of [base, ppm, min, max]) if (!f.validate()) { toast('Check the highlighted field', 'bad'); return; }
      const patch = {
        // Absent keys mean "leave this alone", which is what a cleared field should do.
        baseFee: base.read(), feePpm: ppm.read(), minAmount: min.read(), maxAmount: max.read(),
        directions: directions.value,
      };
      try {
        await api.saveSettings(patch);
        dirty = false;
        toast('Rates saved', 'ok');
        status.textContent = '';
      } catch (e) {
        toast(e.message, 'bad');
        status.textContent = e.message;
      }
    },
  });

  const applyNow = c.button({
    label: 'Save and restart now', busyLabel: 'Restarting',
    onClick: async () => {
      for (const f of [base, ppm, min, max]) if (!f.validate()) { toast('Check the highlighted field', 'bad'); return; }
      await api.saveSettings({
        baseFee: base.read(), feePpm: ppm.read(), minAmount: min.read(), maxAmount: max.read(),
        directions: directions.value, restart: true,
      });
      dirty = false;
      toast('Saved and restarting', 'ok');
    },
  });

  function onEdit() { dirty = true; status.textContent = 'Not advertised yet.'; }

  const drift = driftNote(snap);

  return c.card({ title: 'Your rates' },
    drift,
    el('div.grid.c2', {}, base, ppm, min, max),
    c.field({ label: 'Directions', control: directions }),
    example,
    // Saving does not restart. The daemon has no reload signal, so a rate change only reaches the
    // wire on a restart; showing "saved" while advertising something else would be a lie.
    el('p.small.faint', { style: { 'margin-top': 'var(--s-3)' } },
      'Saved rates take effect the next time the provider restarts. Nothing in flight is affected: swaps already agreed keep the price they were quoted at.'),
    el('div.actions', {}, save, applyNow, status),
    o && o.min_is_fee_driven
      ? c.note(`You are advertising a minimum of ${fmt.sats(o.effective_min_amount_sat)}, not ${fmt.sats(o.min_amount_sat)}. The engine will not advertise a swap smaller than ten times its own on-chain cost, and that floor moves with miner fees.`, { tone: 'warn' })
      : null);
}

/** Say plainly when what is saved is not what is being offered. */
function driftNote(snap) {
  const o = snap.offer;
  const s = snap.settings;
  if (!o) return null;
  const differs = o.base_fee_sat !== s.baseFee || o.fee_ppm !== s.feePpm ||
    o.min_amount_sat !== s.minAmount || o.max_amount_sat !== s.maxAmount;
  if (!differs) return null;
  return c.note(
    `Advertising ${fmt.sats(o.base_fee_sat)} + ${(o.fee_ppm / 10000).toFixed(2)}%, but ${fmt.sats(s.baseFee)} + ${(s.feePpm / 10000).toFixed(2)}% is saved. Restart the provider to advertise the saved rates.`,
    {
      tone: 'warn',
      actions: [c.button({ label: 'Restart now', busyLabel: 'Restarting', onClick: () => api.restartProvider() })],
    });
}

/** The offer as a counterparty sees it, in the same shape the Swap tab shows a quote. */
function offerCard(snap) {
  const o = snap.offer;
  const p = snap.provider;
  if (!o) return null;

  return c.card({ title: 'Your offer, as others see it' },
    p.pubky
      ? el('div', { style: { 'margin-bottom': 'var(--s-4)' } },
          el('div.field-label', { text: 'Your pubky' }),
          el('p.small.muted', { text: 'Share this with anyone who wants to swap with you. It is not a secret.' }),
          c.copyText(p.pubky))
      : null,
    c.detail([
      ['Directions', fmt.directions(o.directions)],
      ['Amount', `${fmt.sats(o.effective_min_amount_sat)} to ${fmt.sats(o.max_amount_sat)}`],
      ['Fee', `${fmt.sats(o.base_fee_sat)} + ${(o.fee_ppm / 10000).toFixed(2)}%, plus ${fmt.sats(o.onchain_fee_sat)} miner fee`],
      ['On 500,000 sat', `they pay ${fmt.sats(fmt.feeOn(500000, o.base_fee_sat, o.fee_ppm) + o.onchain_fee_sat)} in total fees`],
      ['Confirmations', String(o.required_confirmations)],
      ['Refund timeout', `${o.htlc_timeout_blocks} blocks (${fmt.blocksToTime(o.htlc_timeout_blocks)})`],
      ['Lightning node', o.lightning_node_id ? fmt.shortKey(o.lightning_node_id, 8) : null],
    ]));
}
