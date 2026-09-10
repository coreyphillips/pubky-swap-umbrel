// Guided setup. Layer 3.
//
// The old panel dropped a new operator into a form with a recovery-phrase textarea and, the moment
// they saved, started advertising swaps to the network on their behalf. Two things follow from
// that, and both are fixed here: the role is asked before anything else, so someone who only wants
// to swap their own funds never runs a provider; and the node is checked before they commit, using
// the engine's own doctor, so "you are live" is a statement rather than a hope.

import { el, fill } from '../dom.js';
import * as fmt from '../format.js';
import * as c from '../components.js';
import { api } from '../api.js';
import { toast } from '../toast.js';

const STEPS = ['Risk', 'Role', 'Identity', 'Your node', 'Done'];

let step = 0;
let role = 'both';
let probed = null;

// The last root and snapshot seen, so a step can re-render itself without waiting for the next
// store tick. Setup is the one place in the panel that has local state the server knows nothing
// about, so it is the one place that needs this.
let host = null;
let snapshot = null;
// The node check is kicked off once when the step is first shown, not on every re-render: `draw()`
// runs on every store update, and a diagnostics run spawns a process.
let diagnosticsRequested = false;

export default {
  id: 'setup',
  label: 'Setup',
  hidden: true,

  mount(root) {
    fill(root, el('div.setup', { attrs: { id: 'setupBody' } }));
  },

  render(root, snap) {
    host = root;
    snapshot = snap;
    draw();
  },

  enter() { step = 0; probed = null; diagnosticsRequested = false; },
};

function advance(next) {
  step = next;
  draw();
}

function draw() {
  if (!host || !snapshot) return;
  const body = host.querySelector('#setupBody');
  if (!body) return;
  fill(body,
    el('div.setup-steps', {}, ...STEPS.map((label, i) =>
      el('span.setup-pip', {
        text: label,
        dataset: { state: i === step ? 'current' : i < step ? 'done' : 'todo' },
      }))),
    renderStep(snapshot));
}

function renderStep(snap) {
  if (step === 0) return riskStep(advance);
  if (step === 1) return roleStep(advance);
  if (step === 2) return identityStep(advance, snap);
  if (step === 3) return nodeStep(advance, snap);
  return doneStep(advance, snap);
}

/** Said once, properly, so the rest of the panel does not have to nag. */
function riskStep(advance) {
  const agree = el('input', { attrs: { type: 'checkbox' } });
  const next = c.button({
    label: 'Continue', variant: 'primary', disabled: true,
    onClick: () => advance(1),
  });
  agree.addEventListener('change', () => { next.disabled = !agree.checked; });

  return c.card({ title: 'Before you start' },
    el('p', { text: 'Pubky Swap moves real bitcoin between your Lightning channels and the chain, using your own node. There is no company in the middle and no support desk.' }),
    el('p.muted', { text: 'Three things worth knowing:' }),
    el('ul.muted', { style: { 'padding-left': '20px' } },
      el('li', { text: 'Not audited. It is tested end to end against real Lightning nodes, but no third party has reviewed it for security. A bug in an atomic swap can lose money.' }),
      el('li', { text: 'A swap can tie up funds for about a day. When something goes wrong mid-swap, the way out is a timelock. You wait for it. There is no way to speed it up.' }),
      el('li', { text: 'Some keys exist only here. If you delete this app\'s data while a swap is unfinished, the coins in that swap become unspendable by anyone.' })),
    el('p', { text: 'Start with an amount you would not mind losing.' }),
    el('label.check', {}, agree, el('span', { text: 'I understand.' })),
    el('div.actions', {}, next));
}

function roleStep(advance) {
  const picker = c.segmented({
    value: role,
    onChange: (v) => { role = v; },
    options: [
      {
        value: 'earn',
        title: 'Earn fees',
        body: 'Advertise swaps at your rate. Other people\'s swaps run against your LND and your on-chain balance, and you keep the fee. Runs continuously.',
      },
      {
        value: 'taker',
        title: 'Move my own funds',
        body: 'Swap your own sats between Lightning and on-chain through someone else\'s provider. Nothing runs in the background.',
      },
      { value: 'both', title: 'Both', body: 'Advertise swaps, and swap your own funds when you want to.' },
    ],
  });
  return c.card({ title: 'What do you want to use this for?' },
    picker,
    el('p.small.faint', { style: { 'margin-top': 'var(--s-3)' }, text: 'You can change this later in Settings.' }),
    el('div.actions', {},
      c.button({ label: 'Back', onClick: () => advance(0) }),
      c.button({ label: 'Continue', variant: 'primary', onClick: () => advance(2) })));
}

/**
 * Identity, with the two kinds kept mutually exclusive by construction.
 *
 * The recognition prompt after loading is not decoration. A wrong passphrase does not fail: it
 * derives a different, perfectly valid identity, with a different pubky and no funds behind it.
 * Showing the pubky and asking whether it is the expected one is the only place that is catchable.
 */
function identityStep(advance, snap) {
  let mode = 'phrase';
  const phrase = el('textarea', { attrs: { placeholder: 'word one word two word three ...', spellcheck: 'false', autocomplete: 'off' } });
  const fileInput = el('input', { attrs: { type: 'file', accept: '.pkarr' } });
  const passphrase = el('input', { attrs: { type: 'password', placeholder: 'leave blank unless you set one', autocomplete: 'off' } });
  const wordCount = el('div.field-hint');
  const result = el('div', { style: { 'margin-top': 'var(--s-3)' } });

  phrase.addEventListener('input', () => {
    const words = phrase.value.trim().split(/\s+/).filter(Boolean);
    wordCount.textContent = words.length
      ? `${words.length} word${words.length === 1 ? '' : 's'}${[12, 24].includes(words.length) ? '' : ', but a Pubky phrase is 12 or 24'}`
      : '';
  });

  const phrasePane = el('div', {}, c.field({ label: 'Recovery phrase', control: phrase }), wordCount);
  const filePane = el('div.hidden', {}, c.field({ label: 'Recovery file', control: fileInput, hint: 'The .pkarr file from any other Pubky app.' }));

  const picker = c.segmented({
    inline: true,
    value: 'phrase',
    onChange: (v) => {
      mode = v;
      phrasePane.classList.toggle('hidden', v !== 'phrase');
      filePane.classList.toggle('hidden', v !== 'file');
    },
    options: [{ value: 'phrase', title: 'Recovery phrase' }, { value: 'file', title: 'Recovery file' }],
  });

  const load = c.button({
    label: 'Load identity', variant: 'primary', busyLabel: 'Loading',
    onClick: async () => {
      try {
        if (mode === 'file') {
          const file = fileInput.files[0];
          if (!file) return toast('Choose a recovery file', 'bad');
          await api.uploadRecoveryFile(await file.arrayBuffer());
        } else {
          if (!phrase.value.trim()) return toast('Enter your recovery phrase', 'bad');
          await api.setPhrase(phrase.value);
        }
        await api.setPassphrase(passphrase.value);
        await api.saveSettings({ role });
        fill(result, c.skeleton({ height: 60 }));
        const { pubky } = await api.probeIdentity();
        probed = pubky;
        phrase.value = '';
        passphrase.value = '';
        fill(result,
          c.note('This is the identity you just loaded.', {
            tone: 'ok',
            title: 'Identity loaded',
            actions: [c.button({ label: 'Continue', variant: 'primary', onClick: () => advance(3) })],
          }),
          el('div', { style: { 'margin-top': 'var(--s-2)' } }, c.copyText(pubky)),
          el('p.small.muted', { style: { 'margin-top': 'var(--s-2)' },
            text: 'If you have used this identity before, check that this is the pubky you expect. A different passphrase produces a different, perfectly valid identity, and this is the only place you would notice.' }));
      } catch (e) {
        fill(result, c.note(e.message, { tone: 'bad', title: 'That did not work', quoted: e.remedy || null }));
      }
    },
  });

  return c.card({ title: 'Your Pubky identity' },
    el('p.muted', { text: 'This is how other people find you. It is the same recovery phrase or .pkarr file you would use in any other Pubky app.' }),
    // Worth saying before someone pastes a freshly generated phrase and gets a 404 they cannot
    // interpret: this app signs in to a Pubky identity, it does not create one.
    el('p.small.faint', { text: 'It has to be an identity that already exists. This app can sign in with one but cannot create one, so generate it in a Pubky app first.' }),
    picker,
    el('div', { style: { 'margin-top': 'var(--s-3)' } }, phrasePane, filePane),
    c.field({ label: 'Passphrase (optional)', control: passphrase, hint: 'Leave blank unless your phrase or file was made with one. A wrong passphrase does not fail; it quietly gives you a different identity.' }),
    el('div.actions', {}, c.button({ label: 'Back', onClick: () => advance(1) }), load),
    result);
}

/**
 * The node check, before committing to anything.
 *
 * With failures the two roles diverge on purpose: a provider that cannot execute quotes harmlessly
 * and rejects every request, so continuing is a real choice. A taker that cannot execute would fund
 * an HTLC it has no way to drive, so it is not.
 */
function nodeStep(advance, snap) {
  const h = snap.health || {};
  const body = el('div');

  const rerun = c.button({
    label: 'Check again', busyLabel: 'Checking',
    onClick: async () => { await api.runDiagnostics(); },
  });

  if (!h.checks || !h.checks.length) {
    fill(body,
      c.note('Checking your node. This can take up to thirty seconds when a backend is slow to answer.', { tone: 'info' }),
      c.skeletonRows(3, 36));
    if (!diagnosticsRequested) {
      diagnosticsRequested = true;
      api.runDiagnostics().catch(() => {});
    }
  } else {
    const failures = h.failures || 0;
    fill(body,
      c.checkList(h.checks, { showPassing: true }),
      failures === 0
        ? c.note('Everything the engine needs is reachable.', { tone: 'ok' })
        : role === 'taker'
          ? c.note('Fix these first. A swap needs your LND and Electrs to finish, and a half-finished swap locks funds for about a day.', { tone: 'bad', title: 'Not ready to swap' })
          : c.note('Your provider will advertise rates and reject every swap request until these are fixed. That is harmless, and you can leave it running while you sort them out.', { tone: 'warn', title: 'You can continue' }));
  }

  const failures = h.failures || 0;
  const canContinue = failures === 0 || role !== 'taker';

  return c.card({ title: 'Your node', actions: [rerun] },
    body,
    el('div.actions', {},
      c.button({ label: 'Back', onClick: () => advance(2) }),
      c.button({
        label: failures ? 'Continue anyway' : 'Continue',
        variant: 'primary',
        disabled: !canContinue,
        onClick: () => advance(4),
      })));
}

function doneStep(advance, snap) {
  const pubky = snap.provider.pubky || probed;
  const taker = role === 'taker';

  const finish = c.button({
    label: taker ? 'Go to Swap' : 'Go to Earn', variant: 'primary',
    onClick: async () => {
      await api.saveSettings({ role, setupComplete: true });
      if (!taker) await api.startProvider();
      location.hash = taker ? '#/swap' : '#/earn';
    },
  });

  if (taker) {
    return c.card({ title: 'Ready' },
      el('p', { text: 'Nothing runs in the background. When you want to swap, open Swap, paste a provider\'s pubky and ask for a quote.' }),
      pubky ? el('div', {}, el('p.small.muted', { text: 'Your pubky, if someone wants to swap with you:' }), c.copyText(pubky)) : null,
      el('div.actions', {}, finish));
  }

  const s = snap.settings;
  return c.card({ title: 'You are ready to earn' },
    pubky
      ? el('div', { style: { 'margin-bottom': 'var(--s-4)' } },
          el('p.small.muted', { text: 'Your pubky. Share it with anyone who wants to swap with you; it is not a secret.' }),
          c.copyText(pubky))
      : null,
    c.detail([
      ['You will advertise', s.directions === 'submarine,reverse' ? 'both directions' : s.directions],
      ['Amounts', `${fmt.sats(s.minAmount)} to ${fmt.sats(s.maxAmount)}`],
      ['Your fee', `${fmt.sats(s.baseFee)} + ${(s.feePpm / 10000).toFixed(2)}%, plus the miner fee at cost`],
      ['Confirmations', String(s.confirmations)],
    ]),
    el('p.small.faint', { style: { 'margin-top': 'var(--s-3)' }, text: 'You can change all of this on the Earn tab.' }),
    el('div.actions', {}, c.button({ label: 'Back', onClick: () => advance(3) }), finish));
}
