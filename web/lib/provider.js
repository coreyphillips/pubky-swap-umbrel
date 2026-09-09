'use strict';

// Supervising the swap-provider daemon.
//
// The state this module reports is derived from two independent things: whether our child process
// is alive, and what the daemon's own status API says about itself. Keeping them separate is the
// point. The previous version cached facts scraped out of log lines -- "connected to LND",
// "execution-capable" -- and only cleared them on start, so after a Stop the panel went on
// reporting a connected node indefinitely. There is no cache here to go stale: when the API is
// unreachable those fields are null, and null renders as a dash, which is true.

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const paths = require('./paths');
const settings = require('./settings');
const secrets = require('./secrets');
const engine = require('./engine');
const { writeAtomic, readTrimmed } = require('./atomic');
const { killProc, backoffMs, createQueue } = require('./proc');

const BIN = process.env.SWAP_PROVIDER_BIN || '/usr/local/bin/swap-provider';
const STATUS_HOST = process.env.STATUS_HOST || '127.0.0.1';
const STATUS_PORT = parseInt(process.env.STATUS_PORT || '9788', 10);
// Generous by default: the daemon has swap drivers to unwind, and docker-compose already allows a
// minute. Overridable so the tests do not have to wait it out.
const STOP_GRACE_MS = parseInt(process.env.PROVIDER_STOP_GRACE_MS || '20000', 10);
const STOP_HARD_MS = parseInt(process.env.PROVIDER_STOP_HARD_MS || '5000', 10);
// Generous: the API binds before any backend is probed, so the only slow part is decrypting a
// recovery file. Past this with the child alive and the API silent, something is genuinely wrong.
const STARTING_GRACE_MS = 30000;

/**
 * Exits that restarting cannot fix.
 *
 * Matched on distinctive noun phrases from upstream, but never trusted alone -- the raw text is
 * always kept and shown, so a reworded upstream message degrades to "ended unexpectedly, here is
 * what it said" rather than to a confidently wrong story.
 */
const FATAL_PATTERNS = [
  { kind: 'refusal', re: /in-flight swap\(s\) are persisted under the data directory/i },
  { kind: 'network-mismatch', re: /network mismatch: provider configured for/i },
  { kind: 'mainnet-safety', re: /unsafe mainnet config:/i },
  { kind: 'timelocks', re: /unusable timelock configuration|timelock parameters are unsatisfiable/i },
  { kind: 'identity', re: /no Pubky identity configured|use exactly one/i },
  { kind: 'config', re: /^error: |assembling the configuration/im },
];

class Provider {
  constructor({ logs, statusClient, redactor, notices, spawnFn = spawn }) {
    this.logs = logs;
    this.spawn = spawnFn;
    this.status = statusClient;
    this.redactor = redactor;
    this.notices = notices;

    this.child = null;
    this.generation = 0;
    this.desired = 'stopped';
    this.state = 'stopped';
    this.startedAt = 0;
    this.restartCount = 0;
    this.restartTimer = null;
    this.restartAt = 0;
    this.lastExit = null;
    this.fatal = null;
    this.stopping = false;
    this.statusPort = STATUS_PORT;
    this.enqueue = createQueue();
  }

  // --- lifecycle -------------------------------------------------------------------------------

  start() { return this.enqueue(() => this.startInner()); }
  stop() { this.desired = 'stopped'; return this.enqueue(() => this.stopInner()); }
  restart() { return this.enqueue(async () => { await this.stopInner(); await this.startInner(); }); }

  async startInner() {
    this.desired = 'running';
    this.clearRestartTimer();
    if (this.child) await this.stopInner({ keepDesired: true });

    const cfg = settings.load();
    if (!secrets.isConfigured()) {
      this.state = 'failed';
      this.fatal = {
        kind: 'identity',
        message: 'No Pubky identity is loaded, so there is nothing to advertise.',
        remedy: 'Load a recovery phrase or a recovery file in Settings.',
      };
      return;
    }

    fs.mkdirSync(paths.providerDir, { recursive: true });
    const token = this.ensureStatusToken();
    this.statusPort = await pickFreePort(this.statusPort);
    const configFile = engine.writeConfig(
      paths.providerConfig,
      engine.providerConfig(cfg, `${STATUS_HOST}:${this.statusPort}`),
    );

    this.status.configure({ host: STATUS_HOST, port: this.statusPort, token });
    this.status.reset();
    this.redactor.refresh([token]);

    const generation = ++this.generation;
    let child;
    try {
      child = this.spawn(BIN, [], { env: engine.childEnv(configFile), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.state = 'failed';
      this.fatal = { kind: 'missing-binary', message: `Could not run the swap engine: ${e.message}`, remedy: null };
      return;
    }

    this.child = child;
    this.startedAt = Date.now();
    this.state = 'starting';
    this.fatal = null;
    this.logs.note('Starting the swap provider.');

    child.stdout.on('data', (d) => this.logs.push(d, 'out'));
    child.stderr.on('data', (d) => this.logs.push(d, 'err'));

    child.on('error', (e) => {
      if (!this.owns(child, generation)) return;
      this.logs.note(`The swap engine could not be started: ${e.message}`, 'ERROR');
      this.child = null;
      this.state = 'failed';
      this.fatal = { kind: 'missing-binary', message: `Could not run the swap engine: ${e.message}`, remedy: null };
      this.status.reset();
    });

    child.on('exit', (code, signal) => {
      // Both guards, because they fail differently. The identity check catches the concrete bug:
      // a restart spawns the replacement, then the *old* process finally dies and its handler runs
      // against a handle that now belongs to the new one. The generation check catches the window
      // during a start where the handle has already been reassigned.
      if (!this.owns(child, generation)) {
        this.logs.note(`An earlier provider process exited (code=${code}).`);
        return;
      }
      this.child = null;
      this.status.reset();
      const reason = this.classifyExit(code, signal);
      this.lastExit = { code, signal, at: Date.now(), reason };
      this.logs.note(`The swap provider exited (code=${code}${signal ? `, signal ${signal}` : ''}).`,
        reason === 'stopped' ? 'INFO' : 'ERROR');
      this.afterExit(reason);
    });

    this.status.start();
  }

  async stopInner({ keepDesired = false } = {}) {
    if (!keepDesired) this.desired = 'stopped';
    this.stopping = true;
    this.clearRestartTimer();
    const child = this.child;
    if (child) {
      this.state = 'stopping';
      await killProc(child, STOP_GRACE_MS, STOP_HARD_MS);
    }
    this.stopping = false;
    if (!keepDesired) {
      this.state = 'stopped';
      this.status.stop();
      this.status.reset();
    }
  }

  owns(child, generation) {
    return this.child === child && this.generation === generation;
  }

  // --- exits -----------------------------------------------------------------------------------

  classifyExit(code, signal) {
    if (this.stopping || (signal && this.desired === 'stopped')) return 'stopped';
    const tail = this.logs.tailText(60);
    const young = Date.now() - this.startedAt < 15000;
    for (const { kind, re } of FATAL_PATTERNS) {
      if (re.test(tail) && (kind === 'refusal' || young)) return kind;
    }
    // The refusal is derivable without matching any string: it exits almost immediately, with
    // unfinished swaps on disk and a backend that cannot execute. Worth checking separately so a
    // reworded upstream message only makes detection slower, never wrong.
    if (code === 1 && young && this.hasUnfinishedSwaps()) return 'refusal';
    return 'crash';
  }

  hasUnfinishedSwaps() {
    try {
      return fs.readdirSync(paths.providerSwaps)
        .filter((f) => f.endsWith('.json'))
        .some((f) => {
          try {
            const rec = JSON.parse(fs.readFileSync(`${paths.providerSwaps}/${f}`, 'utf8'));
            const state = rec && rec.state && rec.state.state;
            return state && !['claimed', 'refunded', 'expired', 'failed'].includes(state);
          } catch { return false; }
        });
    } catch { return false; }
  }

  afterExit(reason) {
    if (this.desired !== 'running' || reason === 'stopped') {
      this.state = 'stopped';
      this.status.stop();
      return;
    }
    if (reason !== 'crash') {
      // Deterministic and permanent until something changes. Looping would burn the log and, for
      // the in-flight refusal, would look exactly like a crash loop while being the opposite of one.
      this.state = reason === 'refusal' ? 'refusing' : 'failed';
      this.fatal = this.fatalFrom(reason);
      this.status.stop();
      if (this.notices) this.notices.raise(noticeFor(reason, this.fatal));
      return;
    }
    if (Date.now() - this.startedAt > 60000) this.restartCount = 0;
    this.restartCount++;
    const delay = backoffMs(this.restartCount);
    this.state = 'restarting';
    this.restartAt = Date.now() + delay;
    this.logs.note(`Restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartCount}).`);
    this.restartTimer = setTimeout(() => this.enqueue(() => this.startInner()), delay);
  }

  fatalFrom(kind) {
    const tail = this.logs.lines.slice(-60).filter((l) => l.level === 'ERROR' || l.level === 'WARN');
    const match = tail.reverse().find((l) => FATAL_PATTERNS.some((p) => p.re.test(l.message)));
    return {
      kind,
      message: match ? match.message : this.logs.tailText(6),
      remedy: null,
    };
  }

  clearRestartTimer() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartAt = 0;
  }

  // --- status token ----------------------------------------------------------------------------

  /**
   * Generate the API token before the daemon starts.
   *
   * Upstream adopts an existing, well-formed token rather than replacing it, so writing ours first
   * removes the window in which the API is up and this app does not yet hold the credential -- and
   * with it the filesystem-watch-and-retry loop that window would otherwise need.
   */
  ensureStatusToken() {
    const existing = readTrimmed(paths.statusToken);
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
    const token = crypto.randomBytes(32).toString('hex');
    writeAtomic(paths.statusToken, token, 0o600);
    return token;
  }

  // --- view ------------------------------------------------------------------------------------

  /**
   * What the panel shows. Supervisor facts first, then whatever the daemon says about itself.
   *
   * `starting` becomes `unreachable` once the grace period passes with the child alive and the API
   * silent. That never triggers a restart: a provider in the middle of a swap that a dashboard
   * cannot read is still driving money, and killing it because a JSON endpoint went quiet is
   * strictly worse than showing an honest amber badge.
   */
  view() {
    let state = this.state;
    if ((state === 'starting' || state === 'running') && this.child) {
      // Answering is what "running" means. Only a child that is alive and *not* answering, past the
      // grace period, is unreachable -- and this order matters: deciding the grace period first
      // would leave a healthy provider reported as unreachable forever, because a start is only
      // ever more than thirty seconds ago.
      if (this.status.reachable) state = 'running';
      else if (Date.now() - this.startedAt > STARTING_GRACE_MS) state = 'unreachable';
      else state = 'starting';
    }

    const status = this.status.value('status') || {};
    const entry = this.status.get('status');
    return {
      state,
      desired: this.desired,
      running: Boolean(this.child),
      startedAtUnix: this.startedAt ? Math.floor(this.startedAt / 1000) : null,
      uptimeSecs: this.child && this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      restartCount: this.restartCount,
      restartInSecs: this.restartAt ? Math.max(0, Math.round((this.restartAt - Date.now()) / 1000)) : null,
      lastExit: this.lastExit
        ? { code: this.lastExit.code, signal: this.lastExit.signal, reason: this.lastExit.reason,
            atUnix: Math.floor(this.lastExit.at / 1000) }
        : null,
      fatal: this.fatal,
      statusApi: {
        reachable: this.status.reachable,
        port: this.statusPort,
        lastError: entry ? entry.error : null,
        lastOkUnix: entry && entry.fetchedAt ? Math.floor(entry.fetchedAt / 1000) : null,
      },
      // From /status. Null rather than remembered, whenever the daemon is not answering.
      pubky: status.pubky || null,
      network: status.network || null,
      engineVersion: status.version || null,
      protocolVersion: status.protocol_version == null ? null : status.protocol_version,
      capable: status.capable == null ? null : status.capable,
      directions: status.directions || null,
      inFlight: status.in_flight == null ? null : status.in_flight,
      committedSat: status.committed_sat == null ? null : status.committed_sat,
    };
  }
}

function noticeFor(kind, fatal) {
  if (kind === 'refusal') {
    return {
      level: 'error',
      code: 'PROVIDER_HELD_BACK',
      message: 'The provider refused to start because swaps from a previous run are still in ' +
        'flight and your node is not reachable. This is deliberate, not a crash: some of those ' +
        'swaps may hold committed funds whose refund depends on being driven.',
      remedy: fatal && fatal.message ? fatal.message : null,
    };
  }
  return {
    level: 'error',
    code: 'PROVIDER_REFUSED',
    message: 'The provider refused to start with the current settings.',
    remedy: fatal && fatal.message ? fatal.message : null,
  };
}

/**
 * Find a free loopback port at or above `preferred`.
 *
 * A bind failure is fatal upstream, so a port already taken would stop the daemon entirely rather
 * than merely costing us a dashboard. Probing turns that into a log line.
 */
function pickFreePort(preferred, attempts = 10) {
  return new Promise((resolve) => {
    let port = preferred;
    const tryPort = () => {
      if (port >= preferred + attempts) return resolve(preferred);
      const probe = net.createServer();
      probe.once('error', () => { port++; tryPort(); });
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, STATUS_HOST);
    };
    tryPort();
  });
}

module.exports = { Provider, STATUS_HOST, STATUS_PORT };
