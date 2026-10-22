'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-access-'));
process.env.DATA_DIR = dir;
const policy = require('../lib/access-policy');
const paths = require('../lib/paths');
const settings = require('../lib/settings');
const engine = require('../lib/engine');
const key = 'y'.repeat(52);
const empty = { mode: 'open', allowed: [], blocked: [] };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('upgrade is public by default, but a later missing or corrupt file stays denied', () => {
  policy.initialize();
  assert.deepEqual(policy.load(), empty);
  fs.unlinkSync(paths.accessPolicy);
  settings.invalidate();
  policy.initialize();
  assert.throws(() => policy.load(), { code: 'ACCESS_POLICY_UNAVAILABLE' });
  fs.writeFileSync(paths.accessPolicy, '{broken');
  policy.initialize();
  assert.throws(() => policy.load(), { code: 'ACCESS_POLICY_UNAVAILABLE' });
  assert.equal(fs.readFileSync(paths.accessPolicy, 'utf8'), '{broken');
});

test('invalid patches cannot erase or relax the current policy', async () => {
  const privatePolicy = { mode: 'approved_only', allowed: [], blocked: [] };
  await policy.save(privatePolicy, async () => {});
  for (const invalid of [{}, { ...empty, mode: 'typo' }, { ...empty, blocked: 'bad' },
    { ...empty, allowed: [null] }, { ...empty, allowed: ['<script>'] },
    { ...empty, blocked: Array(257).fill(key) }, { ...empty, typo: true }]) {
    assert.throws(() => policy.save(invalid, async () => {}));
    assert.deepEqual(policy.load(), privatePolicy);
  }
  await assert.rejects(policy.save(empty, async () => { throw new Error('invalid Ed25519 key'); }));
  assert.deepEqual(policy.load(), privatePolicy);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.access-policy-')), []);
});

test('validated changes atomically replace the policy with private permissions', async () => {
  await policy.save(empty, async () => {});
  const saved = await policy.save({ mode: 'approved_only', allowed: [`pubky://${key}`, key], blocked: [key] },
    async (candidate) => {
      assert.deepEqual(policy.load(), empty, 'old policy stays active throughout validation');
      assert.deepEqual(JSON.parse(fs.readFileSync(candidate, 'utf8')).allowed, [key]);
    });
  assert.deepEqual(saved, { mode: 'approved_only', allowed: [key], blocked: [key] });
  settings.invalidate();
  policy.initialize();
  assert.deepEqual(policy.load(), saved, 'restart preserves policy');
  assert.equal(fs.statSync(paths.accessPolicy).mode & 0o777, 0o600);
  assert.equal(engine.providerConfig(settings.load()).access_policy_file, paths.accessPolicy);
  assert.equal(engine.clientConfig(settings.load(), { dataDir: paths.clientDir }).access_policy_file, undefined);
  assert.equal(settings.load().allowed, undefined, 'lists are not in public settings');
});

test('the native validator is required before a policy becomes active', async () => {
  const before = policy.load();
  const original = process.env.SWAP_PROVIDER_BIN;
  process.env.SWAP_PROVIDER_BIN = path.join(dir, 'missing-engine');
  try {
    await assert.rejects(policy.save(empty), { code: 'INVALID' });
    assert.deepEqual(policy.load(), before);
  } finally {
    if (original === undefined) delete process.env.SWAP_PROVIDER_BIN;
    else process.env.SWAP_PROVIDER_BIN = original;
  }
});


test('access list reads require admin access, even with forged forwarding headers', () => {
  const { createAccessGuard, requiresAdminAccess } = require('../lib/access');
  for (const method of ['GET', 'HEAD', 'POST']) {
    assert.equal(requiresAdminAccess(method, '/api/access-policy'), true);
  }
  assert.equal(requiresAdminAccess('GET', '/api/state'), false);
  assert.equal(requiresAdminAccess('POST', '/api/settings'), true);
  const allow = createAccessGuard();
  assert.equal(allow({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(allow({ socket: { remoteAddress: '203.0.113.44' },
    headers: { 'x-forwarded-for': '127.0.0.1' } }), false);
});
