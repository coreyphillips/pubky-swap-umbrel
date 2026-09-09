// Brief confirmations. Layer 1.
//
// A toast confirms that something you did happened. It never carries information you have to read:
// anything you might need to act on -- a refusal, a quote, a failure -- renders inline, where it
// stays put and can be re-read.

import { el } from './dom.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
const MAX = 3;

export function toast(message, tone = 'idle', { duration = 3600 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;

  while (host.children.length >= MAX) host.removeChild(host.firstChild);

  const node = el('div.toast', {
    text: message,
    dataset: { tone },
    // A failure should interrupt a screen reader; a confirmation should wait its turn.
    attrs: tone === 'bad' ? { role: 'alert' } : {},
  });
  host.appendChild(node);

  const remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
  setTimeout(() => {
    if (REDUCED.matches) return remove();
    node.classList.add('out');
    node.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 400);
  }, duration);
}

/** For the three things worth interrupting a screen reader over. */
export function announce(message) {
  const node = document.getElementById('announcer');
  if (node) node.textContent = message;
}
