// The shared vocabulary of the panel. Layer 2.

import { el, frag, fill, clear, text } from './dom.js';
import { copy } from './clipboard.js';
import { toast } from './toast.js';
import * as fmt from './format.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

export function card({ title, meta, actions, tone, id } = {}, ...children) {
  const head = (title || meta || actions)
    ? el('div.card-head', {},
        title ? el('h3', { text: title }) : el('span'),
        el('div.row', {}, meta ? el('span.head-meta', { text: meta }) : null, ...(actions || [])))
    : null;
  return el('section.card', { dataset: { tone }, attrs: id ? { id } : {} }, head, ...children);
}

export function stat({ label, value, unit, sub, hero, id }) {
  return el('div.stat', {},
    el('div.stat-label', { text: label }),
    el('div.stat-value' + (hero ? '.hero' : ''), { attrs: id ? { id } : {} },
      el('span.num', { text: value }),
      unit ? el('span.stat-unit', { text: unit }) : null),
    sub ? el('div.stat-sub', { text: sub }) : null);
}

export function badge(label, tone = 'idle', { dot = false, pulse = false } = {}) {
  return el('span.badge', { dataset: { tone } },
    dot ? el('span.dot' + (pulse && !REDUCED.matches ? '.pulse' : '')) : null,
    el('span', { text: label }));
}

export function button({ label, variant, size, onClick, busyLabel, disabled, title }) {
  const node = el('button.btn', {
    text: label, title,
    dataset: { variant, size },
    attrs: { type: 'button', disabled: disabled || undefined },
  });
  node.addEventListener('click', async (ev) => {
    if (!onClick) return;
    node.setAttribute('aria-busy', 'true');
    if (busyLabel) node.textContent = busyLabel;
    try { await onClick(ev); }
    finally {
      node.removeAttribute('aria-busy');
      node.textContent = label;
    }
  });
  return node;
}

/**
 * A labelled control.
 *
 * The label is wired to the control here rather than left to each caller, and a control that cannot
 * be associated is a thrown error rather than a silent accessibility hole -- which is what the old
 * markup had, with every label a bare element next to its input.
 */
let fieldSeq = 0;
export function field({ label, hint, note, control, labelFor, id }) {
  // `labelFor` exists because a control is sometimes wrapped: a number field with a unit puts its
  // input inside a positioned box. The label has to point at the focusable input, not the wrapper,
  // and the wrapper is what gets laid out.
  const target = labelFor || control;
  const controlId = id || target.id || `f${++fieldSeq}`;
  target.id = controlId;
  const hintId = hint ? `${controlId}-hint` : null;
  if (hintId) target.setAttribute('aria-describedby', hintId);
  return el('div.field', {},
    el('label.field-label', { text: label, attrs: { for: controlId } }),
    control,
    hint ? el('div.field-hint', { text: hint, attrs: { id: hintId } }) : null,
    note ? el('div.field-note', { text: note }) : null);
}

/**
 * A number input that holds a string.
 *
 * The old panel read every numeric field with `Number(input.value)`, so clearing a field sent 0,
 * which then failed the server's range check and came back as a flat "invalid confirmations" with
 * no indication of which field or why. Here an empty field means "leave this as it is": `read()`
 * returns undefined and the caller omits the key entirely.
 *
 * `type="text"` with a numeric inputmode rather than `type="number"`: a number input silently
 * discards anything it cannot parse, so a stray character makes the value you typed vanish, and it
 * responds to the scroll wheel, on a field that sets a fee.
 */
export function numberField({ label, hint, value, min, max, unit, id, onInput }) {
  const input = el('input', {
    attrs: {
      type: 'text', inputmode: 'numeric', autocomplete: 'off',
      placeholder: value == null ? '' : String(value),
    },
  });
  // The property, not just the attribute: the attribute is only the default value, and `read()`
  // has to be right before anyone has typed anything.
  input.value = value == null ? '' : String(value);
  // Built once and handed to `field` already wrapped. The previous spelling built the wrapper,
  // then let `field` append the bare input, which moved it out of the wrapper, and then swapped
  // the now-empty wrapper in for it -- so every field with a unit rendered its label and its unit
  // and no input at all, and there was nothing to type into.
  const wrap = unit
    ? el('div.input-suffix', {}, input, el('span', { text: unit }))
    : input;
  const node = field({ label, hint, control: wrap, labelFor: input, id });

  const error = el('div.field-error');
  node.appendChild(error);

  const validate = () => {
    const raw = input.value.trim();
    if (!raw) { input.removeAttribute('aria-invalid'); error.textContent = ''; return true; }
    const n = Number(raw);
    const bad = !Number.isFinite(n) || (min != null && n < min) || (max != null && n > max);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    error.textContent = bad
      ? `Enter a whole number${min != null ? ` of at least ${fmt.sats(min, { unit: false })}` : ''}${max != null ? `, at most ${fmt.sats(max, { unit: false })}` : ''}.`
      : '';
    return !bad;
  };
  input.addEventListener('blur', validate);
  input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); if (onInput) onInput(); });

  node.read = () => {
    const raw = input.value.trim();
    if (!raw) return undefined;
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) ? n : undefined;
  };
  node.validate = validate;
  node.input = input;
  return node;
}

export function segmented({ options, value, onChange, inline = false }) {
  const node = el('div.segmented' + (inline ? '.inline' : ''), { attrs: { role: 'group' } });
  for (const opt of options) {
    const btn = el('button.seg', {
      attrs: { type: 'button', 'aria-pressed': String(opt.value === value) },
      dataset: { value: opt.value },
    },
      el('span.seg-title', { text: opt.title }),
      opt.body ? el('span', { text: opt.body }) : null);
    btn.addEventListener('click', () => {
      for (const other of node.children) other.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-pressed', 'true');
      if (onChange) onChange(opt.value);
    });
    node.appendChild(btn);
  }
  node.value = () => {
    const active = [...node.children].find((c) => c.getAttribute('aria-pressed') === 'true');
    return active ? active.dataset.value : null;
  };
  return node;
}

export function detail(rows) {
  const dl = el('dl.detail');
  for (const [label, value] of rows) {
    if (value == null) continue;
    dl.appendChild(el('dt', { text: label }));
    dl.appendChild(el('dd', {}, value instanceof Node ? value : el('span', { text: text(value) })));
  }
  return dl;
}

/** A value with a copy affordance. The full value is copied, however little of it is shown. */
export function copyText(value, { label, mono = true, short = false } = {}) {
  if (!value) return el('span', { text: '—' });
  const shown = short ? fmt.shortKey(value, 8) : value;
  return el('span.row', { style: { gap: '4px' } },
    el('span' + (mono ? '.mono' : ''), { text: shown, title: value }),
    iconButton('copy', label || 'Copy', async () => {
      const ok = await copy(value);
      toast(ok ? 'Copied' : 'Could not copy', ok ? 'ok' : 'bad');
    }));
}

/**
 * A button that copies, and says what it copies.
 *
 * `copyText` shows the value with a small copy icon beside it, which reads fine under a label in a
 * detail list and reads as a stray random string anywhere else. Where there is no label to sit
 * under, use this.
 */
export function copyButton(value, label, { variant, size } = {}) {
  return button({
    label,
    variant,
    size,
    onClick: async () => {
      const ok = await copy(value);
      toast(ok ? 'Copied' : 'Could not copy', ok ? 'ok' : 'bad');
    },
  });
}

const ICONS = {
  copy: 'M4 4h6v2H6v7H4V4zm4 3h6v8H8V7z',
  qr: 'M2 2h5v5H2V2zm2 2v1h1V4H4zm5-2h5v5H9V2zm2 2v1h1V4h-1zM2 9h5v5H2V9zm2 2v1h1v-1H4zm5-2h2v2H9V9zm3 0h2v2h-2V9zm-3 3h2v2H9v-2zm3 0h2v2h-2v-2z',
  x: 'M4 4l8 8M12 4l-8 8',
};

export function iconButton(icon, label, onClick) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[icon] || ICONS.copy);
  p.setAttribute('fill', icon === 'x' ? 'none' : 'currentColor');
  if (icon === 'x') { p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6'); p.setAttribute('stroke-linecap', 'round'); }
  svg.appendChild(p);
  const btn = el('button.icon-btn', { attrs: { type: 'button', title: label, 'aria-label': label } }, svg);
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

export function meter({ value, max, legendLeft, legendRight }) {
  const pctValue = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return el('div', {},
    el('div.meter', { dataset: { pressure: pctValue > 80 ? 'high' : 'normal' } },
      el('div.meter-fill', { style: { width: `${pctValue}%` } })),
    el('div.meter-legend', {},
      el('span', { text: legendLeft }),
      el('span', { text: legendRight })));
}

/** A note, optionally quoting the engine's own words underneath. */
export function note(message, { tone = 'idle', title, quoted, actions } = {}) {
  return el('div.note', { dataset: { tone } },
    title ? el('div.note-title', { text: title }) : null,
    el('div', { text: message }),
    quoted ? el('div.quoted', { text: quoted }) : null,
    actions && actions.length ? el('div.actions', {}, ...actions) : null);
}

export function empty({ title, body, action }) {
  return el('div.empty', {},
    el('div.empty-title', { text: title }),
    body ? el('div.empty-body', { text: body }) : null,
    action || null);
}

export function skeleton({ height = 44, width = '100%' } = {}) {
  return el('div.skeleton', { style: { height: `${height}px`, width } });
}

export function skeletonRows(n, height = 44) {
  return frag(...Array.from({ length: n }, () => skeleton({ height })));
}

/**
 * A modal. Focus moves in on open and back to whatever opened it on close.
 *
 * Used instead of confirm() everywhere, so a confirmation can name the consequence and the amount
 * rather than asking "are you sure?" -- and so the button itself can carry the number.
 */
export function modal({ title, body, actions = [], onClose }) {
  const opener = document.activeElement;
  const box = el('div.modal', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } },
    el('h2', { text: title, attrs: { tabindex: '-1' } }),
    body,
    el('div.actions', {}, ...actions));
  const backdrop = el('div.modal-backdrop', {}, box);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && opener.focus) opener.focus();
    if (onClose) onClose();
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    const focusable = box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.getElementById('modalRoot').appendChild(backdrop);
  box.querySelector('h2').focus();

  return { close, box };
}

/**
 * Count a number up to its new value.
 *
 * Only ever on a handful of headline figures, and it sets the value immediately under reduced
 * motion. The node carries the final value in aria-label so a screen reader is told the number once
 * rather than forty times.
 */
export function countUp(node, to, format = fmt.sats) {
  const target = Number(to) || 0;
  const from = Number(node.dataset.value || 0);
  node.dataset.value = String(target);
  node.setAttribute('aria-label', format(target));
  if (REDUCED.matches || from === target) { node.textContent = format(target); return; }
  const start = performance.now();
  const dur = 900;
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = format(Math.round(from + (target - from) * eased));
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * A health check list, rendering the engine's own remedy verbatim.
 *
 * The remedies are the most useful text in this whole app -- for an unreachable LND, upstream scans
 * the machine and prints the exact address, certificate and macaroon paths it found. Reflowing or
 * rewording that would destroy the part someone pastes.
 */
export function checkList(checks, { showPassing = false } = {}) {
  const marks = { pass: 'ok', warn: '!', fail: 'x' };
  const ordered = [...checks].sort((a, b) => rank(a.status) - rank(b.status));
  const shown = showPassing ? ordered : ordered.filter((c) => c.status !== 'pass');
  const list = el('div.checks');
  for (const check of shown) {
    list.appendChild(el('div.checkrow', {},
      el('span.checkmark', { text: marks[check.status] || '?', dataset: { status: check.status } }),
      el('div', {},
        el('div.checkname', { text: check.name }),
        el('div.checkdetail', { text: check.detail }),
        check.remedy ? el('div.quoted', { text: check.remedy }) : null)));
  }
  const passing = ordered.length - shown.length;
  if (passing > 0) {
    list.appendChild(el('div.small.faint', { text: `${passing} other check${passing === 1 ? '' : 's'} passing.` }));
  }
  return list;
}

function rank(status) { return status === 'fail' ? 0 : status === 'warn' ? 1 : 2; }

export { fill, clear, el, frag };
