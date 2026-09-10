'use strict';

// Just enough DOM to build and inspect the component kit under `node --test`.
//
// The one behaviour it is careful about is the one that mattered: `appendChild` *moves* a node,
// detaching it from any previous parent. A stub that quietly lets a node sit in two places at once
// cannot reproduce the bug this exists to catch, where a control was appended into a wrapper, then
// appended somewhere else, and the now-empty wrapper was swapped in for it.

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.filter(Boolean).forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
  get value() { return [...this.set].join(' '); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.dataset = {};
    this.classList = new ClassList();
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    this.parentNode = null;
    this._text = null;
    this.id = '';
    this.value = '';
    this.disabled = false;
  }

  get className() { return this.classList.value; }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }

  appendChild(node) {
    if (node instanceof Frag) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      return node;
    }
    // A node lives in exactly one place. This is the semantic the bug turned on.
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  replaceChild(next, prev) {
    const i = this.childNodes.indexOf(prev);
    if (i < 0) return prev;
    if (next.parentNode) next.parentNode.removeChild(next);
    this.childNodes[i] = next;
    next.parentNode = this;
    prev.parentNode = null;
    return prev;
  }

  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}

  get textContent() {
    return this._text !== null ? this._text : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }

  /** Depth-first, supporting the handful of selector shapes the components use. */
  querySelector(sel) {
    for (const node of this.walk()) {
      if (sel.startsWith('#') && node.id === sel.slice(1)) return node;
      if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) return node;
      if (!sel.startsWith('#') && !sel.startsWith('.') && node.tagName === sel.toUpperCase()) return node;
    }
    return null;
  }
  querySelectorAll() { return []; }

  *walk() {
    for (const child of this.childNodes) {
      if (!(child instanceof El)) continue;
      yield child;
      yield* child.walk();
    }
  }
}

class Text extends El {
  constructor(t) { super('#text'); this._text = String(t); }
}
class Frag extends El {
  constructor() { super('#fragment'); }
}

/** Install the globals the component modules reach for. Returns a teardown. */
function installDom() {
  const doc = new El('document');
  doc.createElement = (t) => new El(t);
  doc.createElementNS = (_ns, t) => new El(t);
  doc.createTextNode = (t) => new Text(t);
  doc.createDocumentFragment = () => new Frag();
  doc.body = new El('body');
  doc.addEventListener = () => {};
  doc.activeElement = null;
  const byId = new Map();
  doc.getElementById = (id) => {
    if (!byId.has(id)) byId.set(id, new El('div'));
    return byId.get(id);
  };

  const previous = {
    Node: globalThis.Node,
    document: globalThis.document,
    window: globalThis.window,
  };
  globalThis.Node = El;
  globalThis.document = doc;
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), isSecureContext: false };
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null }, configurable: true });

  return () => Object.assign(globalThis, previous);
}

module.exports = { installDom, El };
