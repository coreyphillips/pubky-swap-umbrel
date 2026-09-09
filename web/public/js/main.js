// The shell: header, tab router, live wiring. Layer 4.

import { el, fill, clear } from './dom.js';
import * as fmt from './format.js';
import * as c from './components.js';
import { createStore } from './store.js';
import { createLive } from './live.js';
import { toast, announce } from './toast.js';

import overview from './tabs/overview.js';
import earn from './tabs/earn.js';
import swap from './tabs/swap.js';
import activity from './tabs/activity.js';
import settings from './tabs/settings.js';
import setup from './tabs/setup.js';

const TABS = [overview, earn, swap, activity, settings, setup];
const store = createStore(null);

const panels = document.getElementById('panels');
const tabbar = document.getElementById('tabbar');
const underline = document.getElementById('tabUnderline');
const banner = document.getElementById('banner');

const mounted = new Map();
let activeId = null;
let keyboardNav = false;
let lastAnnouncedState = '';

// --- tabs ----------------------------------------------------------------------------------------

const buttons = new Map();
for (const tab of TABS) {
  if (tab.hidden) continue;
  const btn = el('button.tab', {
    attrs: { type: 'button', role: 'tab', id: `tab-${tab.id}`, 'aria-controls': `panel-${tab.id}`, 'aria-selected': 'false', tabindex: '-1' },
  }, el('span', { text: tab.label }), el('span.tab-count.hidden'));
  btn.addEventListener('click', () => { keyboardNav = false; location.hash = `#/${tab.id}`; });
  buttons.set(tab.id, btn);
  tabbar.appendChild(btn);
}

tabbar.addEventListener('keydown', (ev) => {
  const order = [...buttons.keys()];
  const i = order.indexOf(activeId);
  let next = null;
  if (ev.key === 'ArrowRight') next = order[(i + 1) % order.length];
  if (ev.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length];
  if (ev.key === 'Home') next = order[0];
  if (ev.key === 'End') next = order[order.length - 1];
  if (!next) return;
  ev.preventDefault();
  keyboardNav = true;
  location.hash = `#/${next}`;
  buttons.get(next).focus();
});

function panelFor(tab) {
  if (mounted.has(tab.id)) return mounted.get(tab.id);
  const panel = el('div', {
    attrs: { id: `panel-${tab.id}`, role: 'tabpanel', tabindex: '-1', 'aria-labelledby': `tab-${tab.id}` },
  });
  panels.appendChild(panel);
  tab.mount(panel, { store });
  mounted.set(tab.id, panel);
  return panel;
}

function show(id) {
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  if (activeId === tab.id) return;

  const previous = TABS.find((t) => t.id === activeId);
  if (previous && previous.deactivate) previous.deactivate();

  activeId = tab.id;
  for (const [tabId, btn] of buttons) {
    const selected = tabId === tab.id;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
  }
  for (const [tabId, panel] of mounted) panel.classList.toggle('hidden', tabId !== tab.id);

  const panel = panelFor(tab);
  panel.classList.remove('hidden');
  panel.classList.add('panel-enter');
  if (tab.enter) tab.enter();
  const snap = store.get();
  if (snap) tab.render(panel, snap);
  moveUnderline();
  // Only yank focus when the switch came from the keyboard; a mouse user has not asked to move.
  if (keyboardNav) panel.focus({ preventScroll: true });
}

function moveUnderline() {
  const btn = buttons.get(activeId);
  if (!btn) { underline.style.setProperty('transform', 'scaleX(0)'); return; }
  underline.style.setProperty('transform', `translateX(${btn.offsetLeft}px) scaleX(${btn.offsetWidth})`);
}
window.addEventListener('resize', moveUnderline);

function routeFromHash() {
  const id = (location.hash.replace(/^#\/?/, '') || '').trim();
  const snap = store.get();
  // A node with no identity has exactly one useful screen.
  if (snap && !snap.setup.configured && id !== 'setup') { location.hash = '#/setup'; return; }
  show(id || 'overview');
}
window.addEventListener('hashchange', routeFromHash);

// --- header --------------------------------------------------------------------------------------

const STATE_LABELS = {
  stopped: ['Stopped', 'idle'],
  starting: ['Starting', 'info'],
  running: ['Live', 'ok'],
  unreachable: ['Not answering', 'warn'],
  restarting: ['Restarting', 'warn'],
  refusing: ['Held back', 'bad'],
  failed: ['Refused to start', 'bad'],
  stopping: ['Stopping', 'idle'],
};

function renderHeader(snap) {
  const stateHost = document.getElementById('appbarState');
  const chipHost = document.getElementById('identityChip');
  const p = snap.provider;

  let label;
  let tone;
  if (!snap.setup.configured) [label, tone] = ['Needs setup', 'idle'];
  else if (snap.settings.role === 'taker' && p.state === 'stopped') [label, tone] = ['Taker only', 'idle'];
  else if (p.state === 'running' && p.capable === false) [label, tone] = ['Quoting only', 'warn'];
  else [label, tone] = STATE_LABELS[p.state] || ['Unknown', 'idle'];

  fill(stateHost,
    c.badge(label, tone, { dot: true, pulse: tone === 'ok' }),
    el('span.small.faint', { text: snap.env.network === 'bitcoin' ? '' : snap.env.network }));
  // Only announce when the word changes, so a screen reader is not told the state every few seconds.
  if (label !== lastAnnouncedState) {
    if (lastAnnouncedState) announce(`Provider: ${label}`);
    lastAnnouncedState = label;
  }

  if (p.pubky) {
    fill(chipHost, el('span.idchip', {},
      el('span.idchip-val', { text: fmt.shortKey(p.pubky, 8), title: p.pubky }),
      c.iconButton('copy', 'Copy your pubky', async () => {
        const { copy } = await import('./clipboard.js');
        toast(await copy(p.pubky) ? 'Copied' : 'Could not copy', 'ok');
      })));
  } else {
    clear(chipHost);
  }

  const attention = (snap.notices || []).length;
  const active = ((snap.swaps && snap.swaps.active) || []).length + ((snap.taker && snap.taker.swaps.active) || []).length;
  const count = buttons.get('activity').querySelector('.tab-count');
  if (active || attention) {
    count.textContent = String(active || attention);
    count.dataset.tone = attention ? 'bad' : '';
    count.classList.remove('hidden');
  } else {
    count.classList.add('hidden');
  }
}

function renderBanner(snap, connection) {
  if (connection === 'disconnected') {
    fill(banner, c.note('Lost contact with the control server. Everything below is the last thing it said.', {
      tone: 'bad', title: 'Disconnected',
    }));
    document.body.setAttribute('aria-busy', 'true');
    return;
  }
  document.body.removeAttribute('aria-busy');

  const p = snap.provider;
  if (p.state === 'refusing') {
    fill(banner, c.note(
      'The provider refused to start because swaps from an earlier run are still in flight and your node is not reachable. This is deliberate, not a crash: starting without a working node would abandon swaps that may hold committed funds.',
      { tone: 'bad', title: 'The provider is holding back on purpose', quoted: p.fatal && p.fatal.message }));
    return;
  }
  clear(banner);
}

// --- live ----------------------------------------------------------------------------------------

const live = createLive({
  store,
  onConnection: (connection, lastUpdate) => {
    const node = document.getElementById('freshness');
    node.dataset.conn = connection;
    node.textContent = connection === 'disconnected'
      ? 'disconnected'
      : lastUpdate ? `updated ${fmt.relTime(Math.floor(lastUpdate / 1000))}` : 'connecting';
    const snap = store.get();
    if (snap) renderBanner(snap, connection);
  },
  onLog: (lines) => {
    if (settings.onLog) settings.onLog(lines);
  },
});

store.subscribe((snap) => {
  if (!snap) return;
  renderHeader(snap);
  renderBanner(snap, live.connection);
  if (!activeId) routeFromHash();
  // A node that loses its identity should not be left sitting on a tab that cannot work.
  if (!snap.setup.configured && activeId !== 'setup') { location.hash = '#/setup'; return; }
  const tab = TABS.find((t) => t.id === activeId);
  const panel = mounted.get(activeId);
  if (tab && panel) tab.render(panel, snap);
});

// Keep the "updated Ns ago" honest between pushes.
setInterval(() => {
  const node = document.getElementById('freshness');
  if (live.connection !== 'disconnected' && live.lastUpdate) {
    node.textContent = `updated ${fmt.relTime(Math.floor(live.lastUpdate / 1000))}`;
  }
}, 5000);

live.start().catch((e) => {
  fill(banner, c.note(e.message, { tone: 'bad', title: 'Could not load the control panel' }));
});
