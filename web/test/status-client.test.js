'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { StatusClient, ENDPOINTS } = require('../lib/status-client');

function clientWithSchedule() {
  const scheduled = [];
  const client = new StatusClient();
  client.configure({ port: 1234, token: 'test-status-token' });
  client.running = true;
  client.schedule = (name, delay) => scheduled.push({ name, delay });
  return { client, scheduled };
}

test('provider reset discards failed polling backoff and refreshes all endpoints', async (t) => {
  const { client, scheduled } = clientWithSchedule();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('old provider unavailable'); });
  for (let count = 0; count < 4; count++) await client.poll('status');
  assert.equal(scheduled.at(-1).delay, 80_000);

  scheduled.length = 0;
  client.reset();
  assert.deepEqual(client.get('status'), {
    value: null, fetchedAt: 0, error: null, inFlight: false, failures: 0,
  });
  assert.deepEqual(scheduled, Object.keys(ENDPOINTS).map((name) => ({ name, delay: 0 })));
});

for (const oldResult of ['success', 'failure']) {
  test(`late ${oldResult} from the previous provider cannot change its replacement`, async (t) => {
    const { client, scheduled } = clientWithSchedule();
    const requests = [];
    t.mock.method(globalThis, 'fetch', () => new Promise((resolve, reject) => {
      requests.push({ resolve, reject });
    }));

    const previousPoll = client.poll('status');
    client.reset();
    const replacementPoll = client.poll('status');
    const replacement = client.get('status');
    scheduled.length = 0;

    if (oldResult === 'success') {
      requests[0].resolve({ ok: true, json: async () => ({ pubky: 'previous-provider' }) });
    } else {
      requests[0].reject(new Error('previous provider stopped'));
    }
    await previousPoll;
    assert.equal(client.get('status'), replacement);
    assert.equal(replacement.inFlight, true);
    assert.equal(client.value('status'), null);
    assert.equal(replacement.error, null);
    assert.equal(replacement.failures, 0);
    assert.deepEqual(scheduled, []);

    requests[1].resolve({ ok: true, json: async () => ({ pubky: 'replacement-provider' }) });
    await replacementPoll;
    assert.deepEqual(client.value('status'), { pubky: 'replacement-provider' });
    assert.equal(client.reachable, true);
    assert.equal(replacement.inFlight, false);
    assert.equal(scheduled.find(({ name }) => name === 'status').delay, 10_000);
  });
}
