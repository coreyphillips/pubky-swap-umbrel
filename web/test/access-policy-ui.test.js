'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, El } = require('./dom-stub');
const teardown = installDom();
// Toasts are outside the component under test.
const getById = document.getElementById;
document.getElementById = (id) => id === 'toasts' ? null : getById(id);
const originalListener = El.prototype.addEventListener;
El.prototype.addEventListener = function (name, fn) {
  this.events ||= {};
  this.events[name] = fn;
};
test.after(() => { El.prototype.addEventListener = originalListener; teardown(); });
let accessCard;
let api;
test.before(async () => {
  ({ accessCard } = await import('../public/js/access-policy.js'));
  ({ api } = await import('../public/js/api.js'));
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const button = (card, label) => [...card.walk()].find((node) => node.tagName === 'BUTTON' && node.textContent === label);

test('the editor submits both lists and keeps unsaved input after a failed save', async () => {
  api.accessPolicy = async () => ({ mode: 'approved_only', allowed: [], blocked: [] });
  let submitted;
  api.saveAccessPolicy = async (value) => { submitted = value; throw new Error('Invalid Pubky'); };
  const card = accessCard();
  await settle();
  assert.match(card.textContent, /deny all new quotes and swaps/);
  const lists = [...card.walk()].filter((node) => node.tagName === 'TEXTAREA');
  lists[0].value = 'pubky://first,second\nthird';
  lists[1].value = 'blocked';
  await button(card, 'Save access policy').events.click();
  assert.deepEqual(submitted, { mode: 'approved_only', allowed: ['pubky://first', 'second', 'third'], blocked: ['blocked'] });
  assert.equal(lists[0].value, 'pubky://first,second\nthird');
  assert.match(card.textContent, /Invalid Pubky/);
});

test('a broken policy offers an explicit private replacement, but forbidden reads do not', async () => {
  api.accessPolicy = async () => { throw Object.assign(new Error('Policy unavailable'), { code: 'ACCESS_POLICY_UNAVAILABLE' }); };
  const card = accessCard();
  await settle();
  assert.equal(card.querySelector('select'), null);
  await button(card, 'Replace policy').events.click();
  assert.equal(card.querySelector('select').value, 'approved_only');
  api.accessPolicy = async () => { throw Object.assign(new Error('Admin access required'), { code: 'FORBIDDEN' }); };
  const denied = accessCard();
  await settle();
  assert.equal(button(denied, 'Replace policy'), undefined);
  assert.equal(button(denied, 'Save access policy'), undefined);
});
