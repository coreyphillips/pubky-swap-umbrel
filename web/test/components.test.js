'use strict';

// The component kit, checked against a DOM that moves nodes the way a real one does.

const test = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

const teardown = installDom();
test.after(teardown);

/** The component modules are ESM served to the browser; load them once, after the DOM exists. */
let c;
test.before(async () => { c = await import('../public/js/components.js'); });

test('a number field with a unit still has an input in it', () => {
  // The bug this locks: the wrapper was built around the input, `field` then appended the bare
  // input somewhere else -- which moves it -- and the now-empty wrapper was swapped in for it. The
  // field rendered its label and its unit and nothing to type into, which was every rate field on
  // the Earn tab and most of Advanced.
  const node = c.numberField({ label: 'Flat fee', value: 1000, min: 0, max: 1e9, unit: 'sat' });

  const input = node.querySelector('INPUT');
  assert.ok(input, 'the field must contain an input');
  assert.equal(input.value, '1000', 'and it must show the configured value');
  assert.equal(node.read(), 1000, 'and read() must return it before anything is typed');
  assert.ok(node.textContent.includes('sat'), 'the unit is still rendered');
});

test('a number field without a unit behaves the same way', () => {
  const node = c.numberField({ label: 'Confirmations', value: 2, min: 1, max: 12 });
  assert.ok(node.querySelector('INPUT'));
  assert.equal(node.read(), 2);
});

test('a label points at its control, wrapped or not', () => {
  for (const opts of [{ label: 'A', value: 1, unit: 'sat' }, { label: 'B', value: 1 }]) {
    const node = c.numberField(opts);
    const label = node.childNodes[0];
    const input = node.querySelector('INPUT');
    assert.equal(label.getAttribute('for'), input.id, `${opts.label}: the label must name the input`);
    assert.ok(input.id, 'the input must have an id to be named');
  }
});

test('an empty field reads as absent, not as zero', () => {
  // A cleared field means "leave this alone". Sending 0 is how the old panel turned a blank box
  // into a range error the user could not place.
  const node = c.numberField({ label: 'Flat fee', value: 1000, min: 0, unit: 'sat' });
  node.input.value = '';
  assert.equal(node.read(), undefined);
});
