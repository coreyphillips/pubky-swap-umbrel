'use strict';

// Running `swap-provider --doctor` and turning its report into the same shape `/health` serves.
//
// This exists for the one moment the status API cannot cover: before the daemon is running. Guided
// setup needs to tell someone their LND is unreachable *before* they commit to starting a provider,
// and the doctor is the only thing that can answer then. Once the provider is up, `/health` is the
// same report as JSON and this is not used.
//
// The parse is of a fixed-width render, which is worth marking: every result carries `source`, so
// the UI can say where the answer came from, and a rewording upstream degrades to an empty check
// list rather than to a confident lie.

const { spawn } = require('child_process');
const paths = require('./paths');
const settings = require('./settings');
const engine = require('./engine');
const { stripAnsi } = require('./text');

const BIN = process.env.SWAP_PROVIDER_BIN || '/usr/local/bin/swap-provider';
const TIMEOUT_MS = 90000;

//   [ok  ] network                Regtest
//   [FAIL] lightning.lnd          transport error: connection refused
//          -> could not reach LND at https://...
const CHECK = /^\s{2}\[(ok\s*|warn|FAIL)\]\s+(\S+)\s+(.*)$/;
const REMEDY = /^\s{7,}->\s?(.*)$/;

const STATUS = { ok: 'pass', warn: 'warn', FAIL: 'fail' };

function parseReport(text) {
  const checks = [];
  for (const raw of stripAnsi(text).split('\n')) {
    const check = CHECK.exec(raw);
    if (check) {
      checks.push({
        name: check[2],
        status: STATUS[check[1].trim()] || 'warn',
        detail: check[3].trim(),
        remedy: null,
      });
      continue;
    }
    const remedy = REMEDY.exec(raw);
    if (remedy && checks.length) {
      const last = checks[checks.length - 1];
      // Kept as multiple lines on purpose. The LND remedy prints the exact flags and paths it found
      // on this machine, indented, and reflowing that would destroy the part people paste.
      last.remedy = last.remedy ? `${last.remedy}\n${remedy[1]}` : remedy[1];
    }
  }
  return checks;
}

/**
 * Run the doctor against the configuration the provider would actually use.
 *
 * Writing the same TOML the daemon gets is the whole reason the config is a file: the report is
 * only worth trusting if it describes the run that would happen.
 */
function run() {
  return new Promise((resolve) => {
    const cfg = settings.load();
    let configFile;
    try {
      configFile = engine.writeConfig(paths.providerConfig, engine.providerConfig(cfg, ''));
    } catch (e) {
      return resolve(failure(e.message));
    }

    let child;
    try {
      child = spawn(BIN, ['--doctor'], { env: engine.childEnv(configFile), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve(failure(`could not run the swap engine: ${e.message}`));
    }

    let out = '';
    const capture = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-200000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(failure(`could not run the swap engine: ${e.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const checks = parseReport(out);
      resolve({
        source: 'doctor',
        // The doctor exits non-zero when the daemon could not run, which is a better signal than
        // anything we could derive by counting failures ourselves.
        capable: code === 0,
        checks,
        failures: checks.filter((c) => c.status === 'fail').length,
        warnings: checks.filter((c) => c.status === 'warn').length,
        error: checks.length ? null : (out.trim().split('\n').pop() || 'the doctor produced no report'),
        checked_at_unix: nowUnix(),
      });
    });
  });
}

function failure(message) {
  return {
    source: 'doctor', capable: false, checks: [], failures: 0, warnings: 0,
    error: message, checked_at_unix: nowUnix(),
  };
}

function nowUnix() { return Math.floor(Date.now() / 1000); }

module.exports = { run, parseReport };
