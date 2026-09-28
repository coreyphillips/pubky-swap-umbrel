'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalProvider } = require('../lib/pubky');

const key = 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1y';

test('provider aliases identify one journal scope', () => {
  for (const prefix of ['', 'pubky://', 'pubky:', 'pubky', 'pk:']) {
    assert.equal(canonicalProvider(` ${prefix}${key}/ `), key);
  }
  const prefixedKey = `pubky${key.slice(5)}`;
  assert.equal(canonicalProvider(prefixedKey), prefixedKey);
});

test('invalid provider keys are rejected before starting a process', () => {
  for (const value of ['', null, key.slice(1), key.toUpperCase(), `${key}?network=regtest`]) {
    assert.throws(() => canonicalProvider(value), { status: 400, code: 'INVALID' });
  }
});
