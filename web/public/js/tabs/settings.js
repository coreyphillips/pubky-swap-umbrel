// Settings. Layer 3.
//
// One question: is my identity loaded, and is the machine underneath healthy?
//
// Identity, backends and danger live here. Rates live on Earn, next to the earnings they produce.

import { el, fill } from '../dom.js';
import * as fmt from '../format.js';
import * as c from '../components.js';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { createLogView } from '../logview.js';

let logView = null;
let advancedOpen = false;

export default {
  id: 'settings',
  label: 'Settings',

  mount(root) {
    logView = createLogView({ title: 'Provider log' });
    fill(root, el('div.stack', {},
      el('div', { attrs: { id: 'stIdentity' } }),
      el('div', { attrs: { id: 'stDiag' } }),
      el('div', { attrs: { id: 'stAdvanced' } }),
      el('div', { attrs: { id: 'stLog' } }),
      el('div', { attrs: { id: 'stDanger' } })));
    fill(root.querySelector('#stLog'), c.card({ title: 'Provider log' }, logView.node));
  },

  render(root, snap) {
    fill(root.querySelector('#stIdentity'), identityCard(snap));
    fill(root.querySelector('#stDiag'), diagnosticsCard(snap));
    fill(root.querySelector('#stAdvanced'), advancedCard(snap));
    fill(root.querySelector('#stDanger'), dangerCard(snap));
  },

  onLog(lines) { if (logView) logView.append(lines); },
};

function identityCard(snap) {
  const kind = snap.setup.identity;
  const pubky = snap.provider.pubky;

  if (kind === 'none') {
    return c.card({ title: 'Identity', tone: 'warn' },
      c.note('No Pubky identity is loaded. Nothing can run without one, as a provider or as a taker.', { tone: 'warn' }),
      el('div.actions', {}, c.button({ label: 'Load an identity', variant: 'primary', onClick: () => location.hash = '#/setup' })));
  }

  return c.card({ title: 'Identity' },
    c.detail([
      ['Your pubky', pubky ? c.copyText(pubky) : el('span.muted', { text: 'shown once the provider is running' })],
      ['Loaded from', kind === 'file' ? 'a recovery file' : 'a recovery phrase'],
      ['Passphrase', snap.setup.hasPassphrase ? 'set' : 'not set'],
      ['Role', { earn: 'earning only', taker: 'swapping your own funds only', both: 'both' }[snap.setup.role]],
    ]),
    el('p.small.muted', { style: { 'margin-top': 'var(--s-3)' } },
      'Replacing your identity gives you a different pubky. Anyone holding the old one will not reach you.'),
    el('div.actions', {},
      c.button({ label: 'Replace identity', onClick: () => { location.hash = '#/setup'; } }),
      roleButton(snap)));
}

function roleButton(snap) {
  const role = snap.setup.role;
  if (role === 'taker') {
    return c.button({
      label: 'Also earn fees',
      onClick: async () => { await api.saveSettings({ role: 'both' }); await api.startProvider(); toast('Provider starting', 'ok'); },
    });
  }
  return c.button({
    label: 'Stop earning, swap only',
    onClick: async () => { await api.saveSettings({ role: 'taker' }); await api.stopProvider(); toast('Provider stopping'); },
  });
}

/**
 * Diagnostics.
 *
 * The remedies render exactly as the engine wrote them. For an unreachable LND it scans the machine
 * and prints the address, certificate and macaroon paths it found -- prose worth more than anything
 * this app would compose, and worth nothing at all if it is reflowed.
 */
function diagnosticsCard(snap) {
  const h = snap.health || {};
  const actions = [c.button({
    label: 'Check now', busyLabel: 'Checking',
    onClick: async () => { await api.runDiagnostics(); toast('Checked', 'ok'); },
  })];

  if (h.state === 'checking') {
    return c.card({ title: 'Diagnostics', actions },
      c.note(h.detail || 'The first health check has not finished yet.', { tone: 'info' }));
  }
  if (!h.checks || !h.checks.length) {
    return c.card({ title: 'Diagnostics', actions },
      c.note(h.error || 'No health report yet. Run a check, or start the provider.', { tone: 'idle' }));
  }

  return c.card({
    title: 'Diagnostics',
    meta: h.checked_at_unix
      ? `checked ${fmt.relTime(h.checked_at_unix)}${h.source === 'doctor' ? ', before starting' : ''}`
      : null,
    actions,
  },
    c.checkList(h.checks, { showPassing: true }),
    h.stale ? c.note('This report may be out of date; the panel may have lost contact with the provider.', { tone: 'warn' }) : null);
}

function advancedCard(snap) {
  const s = snap.settings;
  const toggle = c.button({
    label: advancedOpen ? 'Hide advanced' : 'Show advanced', size: 'sm',
    onClick: () => { advancedOpen = !advancedOpen; },
  });

  if (!advancedOpen) {
    return c.card({ title: 'Advanced', actions: [toggle] },
      el('p.small.muted', { text: 'Confirmations, fee floor, invoice expiry, routing fee cap and quote lifetime.' }));
  }

  const confirmations = c.numberField({
    label: 'Confirmations required', value: s.confirmations, min: 1, max: 12,
    hint: 'How deep a funding must be before the provider acts on it.',
  });
  const feeRate = c.numberField({
    label: 'On-chain fee floor', value: s.onchainFeeRate, min: 1, max: 1000, unit: 'sat/vB',
    hint: 'The lowest rate this node will price claims and refunds at.',
  });
  const invoiceExpiry = c.numberField({
    label: 'Hold invoice expiry', value: s.invoiceExpiry, min: 60, max: 86400, unit: 's',
    hint: 'Raised automatically if it is shorter than the counterparty will accept, which is about five hours.',
  });
  const routingFee = c.numberField({ label: 'Routing fee cap', value: s.maxRoutingFeeMsat, min: 0, max: 1e12, unit: 'msat' });
  const quoteTtl = c.numberField({ label: 'Quote lifetime', value: s.quoteTtl, min: 30, max: 3600, unit: 's' });
  const timeoutBlocks = c.numberField({
    label: 'Refund timeout', value: s.timeoutBlocks, min: 18, max: 1008, unit: 'blocks',
    hint: `${fmt.blocksToTime(s.timeoutBlocks)} at the current setting.`,
  });

  const unsafeNote = el('div');
  const renderUnsafe = () => {
    const conf = confirmations.read() ?? s.confirmations;
    const rate = feeRate.read() ?? s.onchainFeeRate;
    const unsafe = snap.env.network === 'bitcoin' && (conf < 2 || rate < 5);
    // The override appears only once an unsafe value has actually been typed, scoped to why. As a
    // standing checkbox it is an invitation; here it is an answer to a specific objection.
    fill(unsafeNote, unsafe
      ? c.note(
          conf < 2
            ? 'Two confirmations is the mainnet minimum. At one, a swap can be reversed out from under you by a cheap reorg.'
            : 'Five sat/vB is the mainnet floor. Below it a claim may not confirm before its deadline.',
          {
            tone: 'warn',
            title: 'The provider will refuse to start with this',
            actions: [el('label.check', {},
              el('input', { attrs: { type: 'checkbox', checked: s.allowUnsafe || undefined } }),
              el('span', { text: 'Override: I am testing and accept this' }))],
          })
      : null);
  };
  confirmations.input.addEventListener('input', renderUnsafe);
  feeRate.input.addEventListener('input', renderUnsafe);
  renderUnsafe();

  const broadcast = el('label.check', {},
    el('input', { attrs: { type: 'checkbox', checked: s.broadcastOffer || undefined } }),
    el('span', { text: 'Push your offer to people who already follow you, when the provider starts' }));
  const explorer = el('label.check', {},
    el('input', { attrs: { type: 'checkbox', checked: s.explorerLinks || undefined } }),
    el('span', { text: 'Show block-explorer links (off by default: following a txid tells a third party which transactions are yours)' }));

  const fields = { confirmations, feeRate, invoiceExpiry, routingFee, quoteTtl, timeoutBlocks };

  return c.card({ title: 'Advanced', actions: [toggle] },
    el('div.grid.c2', {}, confirmations, feeRate, timeoutBlocks, invoiceExpiry, routingFee, quoteTtl),
    unsafeNote,
    broadcast,
    explorer,
    el('div.actions', {},
      c.button({
        label: 'Save', variant: 'primary', busyLabel: 'Saving',
        onClick: async () => {
          for (const f of Object.values(fields)) if (!f.validate()) return toast('Check the highlighted field', 'bad');
          const unsafeBox = unsafeNote.querySelector('input[type=checkbox]');
          await api.saveSettings({
            confirmations: confirmations.read(),
            onchainFeeRate: feeRate.read(),
            timeoutBlocks: timeoutBlocks.read(),
            invoiceExpiry: invoiceExpiry.read(),
            maxRoutingFeeMsat: routingFee.read(),
            quoteTtl: quoteTtl.read(),
            broadcastOffer: broadcast.querySelector('input').checked,
            explorerLinks: explorer.querySelector('input').checked,
            allowUnsafe: unsafeBox ? unsafeBox.checked : false,
          });
          toast('Saved. Restart the provider to apply.', 'ok');
        },
      })));
}

function dangerCard(snap) {
  const openSwaps = (snap.taker.unfinished || 0) + (((snap.swaps && snap.swaps.active) || []).length);
  return c.card({ title: 'Disconnect', tone: 'bad' },
    el('p', { text: 'Removes your Pubky identity and every setting from this app. Your LND balance is untouched.' }),
    el('p.small.muted', {
      text: 'Swap records are kept. They hold the only keys that can recover funds from a swap that did not finish, so this app never deletes them.',
    }),
    openSwaps
      ? c.note(`${openSwaps} swap${openSwaps === 1 ? ' is' : 's are'} still open. Disconnecting stops the provider, and a swap nothing is driving does not refund itself.`, { tone: 'bad' })
      : null,
    el('div.actions', {}, c.button({
      label: 'Disconnect and clear', variant: 'danger',
      onClick: () => confirmDisconnect(openSwaps),
    })));
}

function confirmDisconnect(openSwaps) {
  const confirmInput = el('input', { attrs: { type: 'text', placeholder: 'DISCONNECT', autocomplete: 'off' } });
  const go = c.button({
    label: 'Disconnect', variant: 'danger', disabled: true,
    onClick: async () => { m.close(); await api.clearIdentity(); toast('Disconnected'); location.hash = '#/setup'; },
  });
  confirmInput.addEventListener('input', () => {
    go.disabled = confirmInput.value.trim().toUpperCase() !== 'DISCONNECT';
  });

  const m = c.modal({
    title: 'Disconnect and clear?',
    body: el('div', {},
      el('p', { text: 'Your identity and settings are removed from this app. Your LND balance is untouched, and your swap records are kept.' }),
      openSwaps
        ? el('p', { text: `${openSwaps} swap${openSwaps === 1 ? ' is' : 's are'} still open. Nothing will drive ${openSwaps === 1 ? 'it' : 'them'} after this.` })
        : null,
      c.field({ label: 'Type DISCONNECT to confirm', control: confirmInput })),
    actions: [c.button({ label: 'Cancel', onClick: () => m.close() }), go],
  });
}
