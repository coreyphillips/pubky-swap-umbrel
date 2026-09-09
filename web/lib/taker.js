'use strict';

// Swapping your own funds through someone else's provider.
//
// The client has no status API, so this module gets its facts from two places: the JSON records the
// client writes under its data directory, and the process's own output as a fallback. The records
// are authoritative. `swap-client` writes one *before* it sends the swap request, deliberately,
// because the branch key is generated at that moment and a record written afterwards would leave a
// window where the only key that can recover the funds existed solely in memory.
//
// That ordering is also what makes an honest cancel possible: the existence of a record for this
// run is the exact moment after which stopping the process no longer undoes anything.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const paths = require('./paths');
const settings = require('./settings');
const secrets = require('./secrets');
const engine = require('./engine');
const swapview = require('./swapview');
const { killProc } = require('./proc');

const BIN = process.env.SWAP_CLIENT_BIN || '/usr/local/bin/swap-client';

// The client's negotiation window is a hard 30s, three times over, plus identity load and a
// rendezvous dial. The old 40s straight-to-SIGKILL was both too short and too blunt.
const QUOTE_TERM_MS = 45000;
const QUOTE_KILL_MS = 15000;

// Each spawn is a whole tokio runtime, a pkarr resolution and an iroh dial. Unbounded quote checks
// are a trivial way to flatten a Raspberry Pi.
const MAX_CONCURRENT_QUOTES = 2;
const PER_PROVIDER_COOLDOWN_MS = 10000;

const QUOTE_LINE = /^QUOTE\s+(.*)$/m;

class Taker {
  constructor({ logs, notices }) {
    this.logs = logs;
    this.notices = notices;
    this.child = null;
    this.run = null;
    this.state = 'idle';
    this.quotesInFlight = 0;
    this.lastQuoteAt = new Map();
    this.runs = [];
    this.loadRuns();
  }

  // --- reading the client's own records --------------------------------------------------------

  /** Every swap this node took, projected so no key material can reach a browser. */
  swaps() {
    let files = [];
    try { files = fs.readdirSync(paths.clientSwaps).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const file of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(paths.clientSwaps, file), 'utf8'));
        const view = swapview.project(rec);
        if (view && view.role === 'client') out.push(view);
      } catch { /* a half-written record will parse next time; upstream renames into place */ }
    }
    return out.sort((a, b) => b.updated_at_unix - a.updated_at_unix);
  }

  unfinished() { return this.swaps().filter((s) => !swapview.isTerminal(s)); }

  /** The set of record ids present right now, so a run can tell which record is its own. */
  swapIds() { return new Set(this.swaps().map((s) => s.swap_id)); }

  // --- run history -----------------------------------------------------------------------------

  loadRuns() {
    try {
      this.runs = fs.readFileSync(paths.clientRuns, 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .slice(-100);
    } catch { this.runs = []; }
  }

  recordRun(run) {
    this.runs.push(run);
    if (this.runs.length > 100) this.runs = this.runs.slice(-100);
    try {
      fs.mkdirSync(paths.clientDir, { recursive: true });
      // One writeSync of a single short line, which is atomic on any sane filesystem.
      fs.writeFileSync(paths.clientRuns, JSON.stringify(run) + '\n', { flag: 'a', mode: 0o600 });
    } catch { /* history is a convenience; never fail a swap over it */ }
  }

  // --- quoting ---------------------------------------------------------------------------------

  /**
   * Ask a provider for a price. Moves no funds.
   *
   * Runs in a throwaway data directory, which is not tidiness. The client resumes any unfinished
   * swap it finds *before* it handles `--quote-only`, so a quote check on a node with an open swap
   * would drive that swap -- for hours, if it is waiting on confirmations -- and the old 40-second
   * SIGKILL would land in the middle of it, potentially while a refund was being broadcast. An
   * empty directory has nothing to resume, so the quote returns in seconds and the real swap path
   * keeps the resume behaviour, where it belongs.
   */
  async quote({ provider, direction, amount }) {
    if (this.quotesInFlight >= MAX_CONCURRENT_QUOTES) {
      throw httpError(429, 'RATE_LIMITED', 'Too many quote checks at once. Try again in a moment.');
    }
    const last = this.lastQuoteAt.get(provider) || 0;
    if (Date.now() - last < PER_PROVIDER_COOLDOWN_MS) {
      throw httpError(429, 'RATE_LIMITED', 'You just asked this provider. Give it a few seconds.');
    }
    this.lastQuoteAt.set(provider, Date.now());
    this.quotesInFlight++;

    fs.mkdirSync(paths.quoteDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(paths.quoteDir, 'q-'));
    try {
      const cfg = settings.load();
      const configFile = engine.writeConfig(
        path.join(dir, 'config.toml'),
        engine.clientConfig(cfg, { dataDir: dir, provider, direction, amount }),
      );
      const { stdout, code } = await runClient(['--quote-only'], configFile, QUOTE_TERM_MS);
      const parsed = parseQuoteLine(stdout);
      if (parsed) return parsed;
      throw httpError(200, 'NO_QUOTE', quoteFailureMessage(stdout, code), refusalFrom(stdout));
    } finally {
      this.quotesInFlight--;
      // Sweep before removing: --quote-only returns before any record is written, but if that ever
      // changes upstream, a record left in a directory we delete is a destroyed refund key.
      this.rescueFrom(path.join(dir, 'swaps'), 'a quote check');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  // --- swapping --------------------------------------------------------------------------------

  async startSwap({ provider, direction, amount }) {
    if (this.state !== 'idle') throw httpError(409, 'BUSY', 'One swap at a time. Finish or stop the current one first.');
    if (!secrets.isConfigured()) throw httpError(400, 'NOT_CONFIGURED', 'Load your Pubky identity first.');

    const cfg = settings.load();
    fs.mkdirSync(paths.clientSwaps, { recursive: true });
    const before = this.swapIds();
    const configFile = engine.writeConfig(
      paths.clientConfig,
      engine.clientConfig(cfg, { dataDir: paths.clientDir, provider, direction, amount }),
    );

    const run = {
      run_id: crypto.randomUUID(),
      kind: 'swap',
      started_at_unix: Math.floor(Date.now() / 1000),
      direction, amount_sat: amount, provider,
      swap_ids: [], funds_committed: false, outcome: null, detail: null, exit_code: null,
    };
    this.run = run;
    this.state = 'swapping';
    this.logs.note(`Starting a ${direction} swap of ${amount} sat with ${provider}.`);

    const child = spawn(BIN, [], { env: engine.childEnv(configFile), stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stdout = '';
    const capture = (d) => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); };
    child.stdout.on('data', (d) => { capture(d); this.logs.push(d, 'out'); });
    child.stderr.on('data', (d) => { capture(d); this.logs.push(d, 'err'); });

    // Watch for the record appearing. From that moment the swap exists whether or not this process
    // does, and cancelling stops being a safe thing to offer.
    const watch = setInterval(() => {
      if (run.funds_committed) return;
      const fresh = [...this.swapIds()].filter((id) => !before.has(id));
      if (fresh.length) { run.swap_ids = fresh; run.funds_committed = true; }
    }, 1000);

    child.on('error', (e) => {
      if (this.child !== child) return;
      this.logs.note(`Could not run the swap engine: ${e.message}`, 'ERROR');
      this.finishRun(run, { outcome: 'failed', detail: `Could not run the swap engine: ${e.message}`, exit_code: null });
      clearInterval(watch);
    });

    child.on('exit', (code) => {
      clearInterval(watch);
      if (this.child !== child) return;
      this.child = null;
      const { outcome, detail } = this.determineOutcome(run, before, stdout, code);
      this.finishRun(run, { outcome, detail, exit_code: code });
    });

    return { run_id: run.run_id };
  }

  /**
   * What actually happened.
   *
   * Never the exit code alone. `swap-client` has two paths that warn and return Ok having moved
   * nothing at all, so exit 0 means "the process did not crash", not "the swap happened" -- the old
   * panel reported those as a success. The record on disk is what knows.
   */
  determineOutcome(run, before, stdout, code) {
    const fresh = this.swaps().filter((s) => run.swap_ids.includes(s.swap_id) || !before.has(s.swap_id));
    run.swap_ids = fresh.map((s) => s.swap_id);
    const mine = fresh.find((s) => s.peer === run.provider) || fresh[0];

    if (mine) {
      if (mine.state === 'claimed') return { outcome: 'succeeded', detail: null };
      if (mine.state === 'refunded' || mine.state === 'expired') {
        return { outcome: 'refunded', detail: `The swap unwound and your funds came back (${mine.state}).` };
      }
      if (mine.state === 'failed') return { outcome: 'failed', detail: mine.state_detail };
      // A record that never reached a terminal state means money may still be committed and
      // something has to keep driving it.
      return {
        outcome: 'interrupted',
        detail: `The swap is still open at "${mine.state}". Nothing is driving it right now.`,
      };
    }

    // Both no-op paths carry this phrase, and neither writes a record.
    if (/execution config is missing/i.test(stdout)) {
      return { outcome: 'nothing_happened', detail: lastMatch(stdout, /.*execution config is missing.*/i) };
    }
    if (code !== 0) return { outcome: 'failed', detail: refusalFrom(stdout) || lastErrorLine(stdout) };
    // Deliberately not "succeeded". Nothing observed says it was.
    return { outcome: 'unknown', detail: lastErrorLine(stdout) };
  }

  finishRun(run, patch) {
    Object.assign(run, patch, { finished_at_unix: Math.floor(Date.now() / 1000) });
    this.recordRun(run);
    this.state = 'idle';
    this.logs.note(`Swap finished: ${run.outcome}${run.detail ? ` (${run.detail})` : ''}.`,
      run.outcome === 'succeeded' ? 'INFO' : 'WARN');
    if (run.outcome === 'interrupted' && this.notices) {
      this.notices.raise({
        level: 'error',
        code: 'SWAP_INTERRUPTED',
        message: 'A swap was left open and nothing is driving it. Its record holds the only key ' +
          'that can recover the funds committed to it.',
        remedy: 'Use "Resume" on the Swap tab, and do not delete this app\'s data directory.',
      });
    }
  }

  /**
   * Stop the running swap.
   *
   * Before any record exists this genuinely cancels: nothing was sent, nothing was signed. After
   * one exists it does not, and saying otherwise would be a lie -- the swap continues, it just
   * stops being watched. So that case is refused unless the caller insists.
   */
  async cancel({ force = false } = {}) {
    const run = this.run;
    if (!this.child || !run) return { stopped: false };
    if (run.funds_committed && !force) {
      throw httpError(409, 'COMMITTED',
        'This swap already has a record on disk, so stopping the process does not undo it. ' +
        'The swap stays open and this app will resume it.');
    }
    const child = this.child;
    await killProc(child, 5000, 5000);
    if (!run.funds_committed) {
      this.finishRun(run, { outcome: 'cancelled', detail: 'Cancelled before anything moved.', exit_code: null });
    }
    return { stopped: true, committed: Boolean(run.funds_committed) };
  }

  /**
   * Drive any swap a previous run left open, then exit.
   *
   * This is the recovery path, and it needs no provider and no amount. A swap left in flight still
   * has money in it, and neither leg needs the counterparty to be reachable.
   */
  async resume() {
    if (this.state !== 'idle') throw httpError(409, 'BUSY', 'Something is already running.');
    if (!secrets.isConfigured()) throw httpError(400, 'NOT_CONFIGURED', 'Load your Pubky identity first.');
    const cfg = settings.load();
    fs.mkdirSync(paths.clientSwaps, { recursive: true });
    const configFile = engine.writeConfig(
      paths.clientConfig,
      engine.clientConfig(cfg, { dataDir: paths.clientDir }),
    );
    this.state = 'resuming';
    this.logs.note('Finishing swaps left open by an earlier run.');
    const run = {
      run_id: crypto.randomUUID(), kind: 'resume',
      started_at_unix: Math.floor(Date.now() / 1000),
      swap_ids: this.unfinished().map((s) => s.swap_id), funds_committed: true,
    };
    this.run = run;

    const child = spawn(BIN, ['--resume-only'], { env: engine.childEnv(configFile), stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (d) => this.logs.push(d, 'out'));
    child.stderr.on('data', (d) => this.logs.push(d, 'err'));
    child.on('error', (e) => {
      if (this.child !== child) return;
      this.child = null;
      this.finishRun(run, { outcome: 'failed', detail: e.message, exit_code: null });
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      const stillOpen = this.unfinished().length;
      this.finishRun(run, {
        outcome: stillOpen ? 'interrupted' : 'succeeded',
        detail: stillOpen ? `${stillOpen} swap(s) are still open.` : 'Everything that was open has finished.',
        exit_code: code,
      });
    });
    return { run_id: run.run_id };
  }

  /**
   * Check that the loaded identity actually works, without going near a swap.
   *
   * `--resume-only` against an empty directory derives the key, signs in to the homeserver, prints
   * the pubky and exits in a few seconds. It needs no provider and no amount, and it has nothing to
   * resume, so it moves nothing.
   *
   * The pubky it returns is the point. A wrong passphrase does not fail -- it silently derives a
   * different, perfectly valid identity -- so showing the operator which pubky they just loaded and
   * asking them to recognise it is the only place that mistake is catchable.
   */
  async probeIdentity() {
    if (!secrets.isConfigured()) throw httpError(400, 'NOT_CONFIGURED', 'Load a recovery phrase or file first.');
    fs.mkdirSync(paths.quoteDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(paths.quoteDir, 'id-'));
    try {
      const configFile = engine.writeConfig(
        path.join(dir, 'config.toml'),
        engine.clientConfig(settings.load(), { dataDir: dir }),
      );
      const { stdout, code } = await runClient(['--resume-only'], configFile, QUOTE_TERM_MS);
      const m = /Client pubky:\s*(\S+)/.exec(stdout);
      if (m) return { pubky: m[1] };
      throw httpError(400, 'IDENTITY_FAILED', identityFailureMessage(stdout, code), refusalFrom(stdout));
    } finally {
      this.rescueFrom(path.join(dir, 'swaps'), 'an identity check');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Move records out of a directory that is about to be deleted, or that should never have been
   * written to in the first place. Copy rather than move, so a failure leaves the original alone.
   */
  rescueFrom(dir, describe) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return 0; }
    if (!files.length) return 0;
    fs.mkdirSync(paths.clientSwaps, { recursive: true, mode: 0o700 });
    let moved = 0;
    for (const file of files) {
      const target = path.join(paths.clientSwaps, file);
      if (fs.existsSync(target)) continue;
      try { fs.copyFileSync(path.join(dir, file), target); fs.chmodSync(target, 0o600); moved++; } catch {}
    }
    if (moved && this.notices) {
      this.notices.raise({
        level: 'error',
        code: 'RECORDS_RESCUED',
        message: `${moved} swap record(s) were found outside this app's data volume, left by ${describe}. ` +
          'They have been copied somewhere permanent. Each holds the only key that can recover the ' +
          'funds in its swap.',
        remedy: 'Check the Swap tab: if any of them are still open, resume them.',
      });
    }
    return moved;
  }

  /** Called once at boot, before anything else can start a new swap. */
  rescueStranded() {
    return this.rescueFrom(paths.strandedClientSwaps, 'an earlier version of this app') +
      sweepQuoteDirs(this);
  }

  view() {
    const all = this.swaps();
    const active = all.filter((s) => !swapview.isTerminal(s));
    return {
      state: this.state,
      current: this.run && this.state !== 'idle'
        ? { run_id: this.run.run_id, kind: this.run.kind, direction: this.run.direction || null,
            amount_sat: this.run.amount_sat || null, provider: this.run.provider || null,
            started_at_unix: this.run.started_at_unix, funds_committed: Boolean(this.run.funds_committed) }
        : null,
      unfinished: active.length,
      swaps: { active, recent: all.filter(swapview.isTerminal).slice(0, 50) },
      runs: this.runs.slice(-20).reverse(),
    };
  }
}

function sweepQuoteDirs(taker) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(paths.quoteDir)) {
      const dir = path.join(paths.quoteDir, entry);
      total += taker.rescueFrom(path.join(dir, 'swaps'), 'an interrupted quote check');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  } catch { /* no quote directory yet */ }
  return total;
}

/** Run the client to completion, bounded. Used only for quotes, which must not run long. */
function runClient(args, configFile, termMs) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(BIN, args, { env: engine.childEnv(configFile), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(httpError(500, 'CLIENT_MISSING', `Could not run the swap engine: ${e.message}`)); }
    let stdout = '';
    const capture = (d) => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const term = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, termMs);
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, termMs + QUOTE_KILL_MS);
    child.on('error', (e) => {
      clearTimeout(term); clearTimeout(hard);
      reject(httpError(500, 'CLIENT_MISSING', `Could not run the swap engine: ${e.message}`));
    });
    child.on('exit', (code) => { clearTimeout(term); clearTimeout(hard); resolve({ stdout, code }); });
  });
}

/**
 * Parse the client's one machine-readable line.
 *
 * `direction` is printed with Rust's Debug formatter, so it arrives capitalised while every other
 * spelling in the system is lowercase. Fold it here rather than making every reader remember.
 */
function parseQuoteLine(text) {
  const m = QUOTE_LINE.exec(String(text));
  if (!m) return null;
  const out = {};
  for (const pair of m[1].trim().split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  if (!out.total_sat) return null;
  return {
    provider: out.provider || '',
    direction: String(out.direction || '').toLowerCase(),
    amount_sat: Number(out.amount_sat || 0),
    fee_sat: Number(out.fee_sat || 0),
    service_fee_sat: out.service_fee_sat == null ? null : Number(out.service_fee_sat),
    onchain_fee_sat: out.onchain_fee_sat == null ? null : Number(out.onchain_fee_sat),
    fee_rate_sat_vb: out.fee_rate_sat_vb == null ? null : Number(out.fee_rate_sat_vb),
    total_sat: Number(out.total_sat || 0),
    timeout_blocks: Number(out.timeout_blocks || 0),
    confirmations: Number(out.confirmations || 0),
    valid_until_unix: out.valid_until_unix == null ? null : Number(out.valid_until_unix),
    quote_id: out.quote_id || null,
  };
}

/**
 * The engine's own refusal, if it gave one.
 *
 * These strings are worth surfacing untouched -- "provider asks us to act at 0 confirmation(s); we
 * require at least 2" says more, and more precisely, than anything this app would write.
 */
function refusalFrom(text) {
  const m = String(text).match(/(?:refusing[^\n]*|provider rejected:[^\n]*|Error:\s*[^\n]*)/gi);
  return m ? m[m.length - 1].trim() : null;
}

function lastErrorLine(text) {
  const lines = String(text).split('\n').filter((l) => /ERROR|Error:|warn/i.test(l));
  return lines.length ? lines[lines.length - 1].trim().slice(0, 400) : null;
}

function lastMatch(text, re) {
  const m = String(text).match(re);
  return m ? m[0].trim() : null;
}

function identityFailureMessage(stdout, code) {
  // A Pubky identity has to already exist on a homeserver: the engine signs in, and nothing in
  // this stack can sign up. So the overwhelmingly likely cause of a 404 here is a phrase that was
  // generated but never registered, and saying "check your network" would send someone looking in
  // the wrong place entirely.
  if (/sign in/i.test(stdout) && /404|Not Found/i.test(stdout)) {
    return 'That identity has no homeserver account yet. A Pubky identity has to be created in a ' +
      'Pubky app first; this app can sign in with one but cannot create one.';
  }
  const refusal = refusalFrom(stdout);
  if (refusal) return refusal;
  if (/sign in/i.test(stdout)) {
    return 'That identity could not sign in to its homeserver. Check that the phrase and ' +
      'passphrase are the ones you used to create it, and that this node has internet access.';
  }
  if (code === null) return 'Checking the identity took too long and was stopped.';
  return 'That identity could not be loaded.';
}

function quoteFailureMessage(stdout, code) {
  if (/timed out waiting for provider response/i.test(stdout)) {
    return 'No reply from that provider. They may be offline, or the message may not have arrived yet.';
  }
  if (refusalFrom(stdout)) return refusalFrom(stdout);
  if (code === null) return 'The quote check took too long and was stopped.';
  return 'That pubky did not answer as a provider for this direction and amount.';
}

function httpError(status, code, message, remedy = null) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.remedy = remedy;
  return err;
}

module.exports = { Taker, parseQuoteLine, httpError };
