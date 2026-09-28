'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// The documented procedure intentionally uses Bash and GNU coreutils on the Umbrel host.
const linuxOnly = { skip: process.platform !== 'linux' };
const document = fs.readFileSync(path.join(__dirname, '../../docs/STORAGE_MIGRATION.md'), 'utf8');
const script = /<<'MIGRATE'\n([\s\S]*?)\nMIGRATE/.exec(document)?.[1];
assert.ok(script, 'The documented migration block must be present.');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrel-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'app data');
  const backup = path.join(root, 'private backup');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *State.Running*) printf "%s\\n" "$MIGRATION_RUNNING" ;;',
    '  *) printf "%s\\n" "$MIGRATION_MOUNT" ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  for (const [name, content] of Object.entries({
    'settings.json': '{"fixture":true}',
    'swap/wallet.sqlite': 'fixture wallet state',
    'client/swaps/saved.json': '{"fixture":"saved swap"}',
    'client/transport/outbox.json': '{"fixture":"delivery state"}',
    'quote/q-interrupted/transport/inbox.json': '{"fixture":"pending delivery"}',
  })) {
    const file = path.join(data, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  return {
    data, backup,
    run(overrides = {}) {
      return spawnSync('bash', ['-s', '--', data, overrides.backup || backup, overrides.network || 'regtest'], {
        input: script, encoding: 'utf8', timeout: 30_000,
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`,
          MIGRATION_RUNNING: overrides.running || 'false', MIGRATION_MOUNT: overrides.mount || data,
        },
      });
    },
  };
}

function snapshot(directory) {
  const result = {};
  function visit(current, prefix) {
    for (const name of fs.readdirSync(current).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(current, name);
      const metadata = fs.lstatSync(file);
      if (metadata.isDirectory()) visit(file, relative);
      else if (metadata.isSymbolicLink()) result[relative] = { link: fs.readlinkSync(file) };
      else result[relative] = { content: fs.readFileSync(file, 'utf8'), mode: metadata.mode & 0o777 };
    }
  }
  visit(directory, '');
  return result;
}

test('documented migration preserves the full backup, working records and file permissions', linuxOnly, (t) => {
  const state = fixture(t);
  const before = snapshot(state.data);
  const result = state.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(state.backup), before);
  assert.equal(fs.statSync(state.backup).mode & 0o777, 0o700);
  const after = {};
  for (const [name, value] of Object.entries(before)) {
    after[/^(swap|client|quote)\//.test(name) ? `networks/regtest/${name}` : name] = value;
  }
  assert.deepEqual(snapshot(state.data), after);
  for (const name of ['swap', 'client', 'quote']) assert.equal(fs.existsSync(path.join(state.data, name)), false);
});

for (const scenario of ['running app', 'wrong data mount', 'occupied network destination', 'existing backup', 'backup inside data', 'unsupported network', 'symlink']) {
  test(`documented migration refuses ${scenario} before moving or overwriting state`, linuxOnly, (t) => {
    const state = fixture(t);
    const options = {};
    if (scenario === 'running app') options.running = 'true';
    if (scenario === 'wrong data mount') options.mount = '/tmp';
    if (scenario === 'occupied network destination') {
      fs.mkdirSync(path.join(state.data, 'networks/regtest'), { recursive: true });
      fs.writeFileSync(path.join(state.data, 'networks/regtest/existing'), 'preserve destination');
    }
    if (scenario === 'existing backup') {
      fs.mkdirSync(state.backup);
      fs.writeFileSync(path.join(state.backup, 'existing'), 'preserve backup');
    }
    if (scenario === 'backup inside data') options.backup = path.join(state.data, 'backup');
    if (scenario === 'unsupported network') options.network = 'unknown';
    if (scenario === 'symlink') fs.symlinkSync('wallet.sqlite', path.join(state.data, 'swap/link'));
    const before = snapshot(state.data);
    const backupBefore = fs.existsSync(state.backup) ? snapshot(state.backup) : null;
    const result = state.run(options);
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshot(state.data), before);
    assert.deepEqual(fs.existsSync(state.backup) ? snapshot(state.backup) : null, backupBefore);
  });
}
