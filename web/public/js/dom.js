// Building DOM. Layer 0: imports nothing.
//
// There is deliberately no `html` option and no innerHTML anywhere in this module. Every value that
// reaches the document does so as a text node. That absence is the fix for a real bug: the old
// panel interpolated fields parsed out of a *remote provider's* output straight into innerHTML, in
// a page that can move funds and had no authentication in front of it.

/**
 * el('div.card#id', props, ...children)
 *
 * props: { class, text, title, attrs:{}, dataset:{}, on:{click}, style:{}, aria:{} }
 * Children may be nodes, strings, numbers, arrays, or null (skipped).
 */
export function el(spec, props = {}, ...children) {
  const [tagAndClasses, id] = String(spec).split('#');
  const [tag, ...classes] = tagAndClasses.split('.');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (props) {
    if (props.class) node.className = [node.className, props.class].filter(Boolean).join(' ');
    if (props.text != null) node.textContent = String(props.text);
    if (props.title) node.title = props.title;
    for (const [k, v] of Object.entries(props.attrs || {})) {
      if (v == null || v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const [k, v] of Object.entries(props.aria || {})) {
      if (v == null) continue;
      node.setAttribute(`aria-${k}`, String(v));
    }
    for (const [k, v] of Object.entries(props.dataset || {})) {
      if (v == null) continue;
      node.dataset[k] = String(v);
    }
    // Through CSSOM, which the CSP permits; literal style attributes in HTML it does not.
    for (const [k, v] of Object.entries(props.style || {})) {
      if (v == null) continue;
      node.style.setProperty(k, String(v));
    }
    for (const [k, v] of Object.entries(props.on || {})) node.addEventListener(k, v);
  }

  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace a node's children in one go. */
export function fill(node, ...children) {
  return append(clear(node), children);
}

export function on(node, type, handler, opts) {
  node.addEventListener(type, handler, opts);
  return () => node.removeEventListener(type, handler, opts);
}

/** An em-dash for absence, so a missing value never renders as "null" or as a confident zero. */
export function text(value) {
  return value == null || value === '' ? '—' : String(value);
}
