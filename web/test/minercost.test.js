'use strict';

// The miner cost a provider is shown for a swap.
//
// It used to be only the estimate the swap was priced at, labelled as such. Set beside the fee of
// the claim transaction on an explorer, that read as a wrong number, when the two are fees of
// different transactions. Once the engine has measured what the provider's funding paid, both
// figures are shown, so the estimate is never mistaken for the cost.

const test = require('node:test');
const assert = require('node:assert');
const { installDom } = require('./dom-stub');

const teardown = installDom();
test.after(teardown);

let sv;
test.before(async () => {
  sv = await import('../public/js/swapview.js');
});

test('an unmeasured swap shows what it was priced at, and says so', () => {
  assert.equal(
    sv.minerCostLine({ onchain_fee_sat: 1395, funding_fee_sat: null }),
    '1,395 sat (priced at quote time, not measured)',
  );
  assert.equal(
    sv.minerCostLine({ onchain_fee_sat: 1395 }),
    '1,395 sat (priced at quote time, not measured)',
    'an engine too old to measure leaves the field out entirely',
  );
});

test('a measured swap shows what was charged beside what its funding paid', () => {
  assert.equal(
    sv.minerCostLine({ onchain_fee_sat: 1395, funding_fee_sat: 775 }),
    '1,395 sat charged, 775 sat paid to fund it',
  );
});
