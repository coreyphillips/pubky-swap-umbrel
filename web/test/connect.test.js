'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom } = require('./dom-stub');

const teardown = installDom();
test.after(teardown);
let connect;
let overview;
test.before(async () => {
  connect = await import('../public/js/connect.js');
  overview = (await import('../public/js/tabs/overview.js')).default;
});

const pubky = 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1y';
function snapshot() {
  return {
    setup: { configured: true },
    settings: { role: 'provider' },
    env: { network: 'mainnet' },
    provider: {
      state: 'running', running: true, pubky, network: 'bitcoin', capable: true,
      statusApi: { reachable: true },
    },
  };
}

test('the Bitkit connection contains only the public provider identity and explicit network', () => {
  const snap = snapshot();
  snap.provider.statusApi.token = 'never-share-this';
  snap.settings.recoveryPhrase = 'never-share-this-either';
  const { uri } = connect.connectionDetails(snap);
  assert.equal(uri, `pubkyswap://connect?pubky=${pubky}&network=bitcoin`);
  const url = new URL(uri);
  assert.equal(url.protocol, 'pubkyswap:');
  assert.equal(url.hostname, 'connect');
  assert.deepEqual([...url.searchParams.keys()], ['pubky', 'network']);
  assert.equal(url.searchParams.get('pubky'), pubky);
  assert.equal(uri.includes('never-share'), false);
});

test('every supported network is explicit and mainnet is normalized', () => {
  for (const network of ['bitcoin', 'testnet', 'signet', 'regtest']) {
    const snap = snapshot();
    snap.env.network = network;
    snap.provider.network = network;
    assert.equal(new URL(connect.connectionDetails(snap).uri).searchParams.get('network'), network);
  }
  assert.match(connect.connectionDetails(snapshot()).uri, /network=bitcoin$/);
});

test('invalid pubkys cannot inject another destination or URI parameter', () => {
  for (const invalid of [undefined, '', 'a'.repeat(51), 'a'.repeat(53), '0'.repeat(52),
    pubky.toUpperCase(), `${pubky}&network=testnet`, `pubky://${pubky}`, ` ${pubky}`, '<script>']) {
    assert.equal(connect.connectionUri(invalid, 'bitcoin'), null);
  }
  for (const network of [undefined, '', 'unknown', 'mainnet', 'bitcoin&token=secret']) {
    assert.equal(connect.connectionUri(pubky, network), null);
  }
});

test('unready, stale, taker-only and mismatched providers do not expose a connection', () => {
  const changes = [
    (s) => { s.setup.configured = false; },
    (s) => { s.settings.role = 'taker'; },
    (s) => { s.provider.state = 'starting'; },
    (s) => { s.provider.state = 'stopped'; },
    (s) => { s.provider.statusApi.reachable = false; },
    (s) => { s.provider.pubky = null; },
    (s) => { s.provider.network = 'testnet'; },
    (s) => { s.env.network = 'unrecognized'; s.provider.network = 'unrecognized'; },
  ];
  for (const change of changes) {
    const snap = snapshot();
    change(snap);
    const result = connect.connectionDetails(snap);
    assert.equal(result.uri, undefined);
    assert.ok(result.reason);
  }
});

test('the displayed QR and same-device action use the same URI, and disappear when stopped', () => {
  const root = document.createElement('div');
  const snap = snapshot();
  overview.mount(root);
  overview.render(root, snap);
  const card = root.querySelector('#ovConnect');
  assert.ok(card.querySelector('svg'));
  assert.equal(card.querySelector('a').getAttribute('href'), connect.connectionDetails(snap).uri);
  assert.ok(card.textContent.includes(pubky));
  assert.ok(card.textContent.includes('Copy connection link'));
  snap.provider.state = 'stopped';
  snap.provider.running = false;
  overview.render(root, snap);
  assert.equal(card.querySelector('svg'), null, 'an old QR must not survive a live status update');
  assert.equal(card.querySelector('a').getAttribute('href'), '#/settings');
});

test('the QR keeps a four-module quiet zone and explicit black and white colors', () => {
  const svg = connect.connectionQr(connect.connectionUri(pubky, 'bitcoin'));
  const edge = Number(svg.getAttribute('viewBox').split(' ')[3]);
  assert.equal(svg.querySelector('rect').getAttribute('fill'), '#ffffff');
  const path = svg.querySelector('path');
  assert.equal(path.getAttribute('fill'), '#000000');
  const cells = [...path.getAttribute('d').matchAll(/M(\d+),(\d+)h1v1h-1z/g)];
  assert.ok(cells.length > 100);
  for (const [, col, row] of cells) {
    assert.ok(Number(col) >= 4 && Number(col) < edge - 4);
    assert.ok(Number(row) >= 4 && Number(row) < edge - 4);
  }
});
