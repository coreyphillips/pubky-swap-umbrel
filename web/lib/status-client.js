'use strict';

// A poller for the provider's loopback status API.
//
// Upstream added that API because this app used to decide whether the provider was healthy by
// matching regexes against its stdout, "which works until a message is reworded and then fails
// silently, reporting a healthy daemon or an unhealthy one with equal confidence". Everything the
// panel shows about a running provider comes through here.
//
// Three properties worth stating, because each is a decision:
//
//   One poller, not one per browser tab. The server polls upstream on a fixed cadence and fans the
//   result out over SSE, so ten open dashboards cost the daemon exactly what one does. It also
//   means the cadence can drop when nobody is watching, which matters because /swaps and /earnings
//   each walk the whole swap store -- a readdir plus a read and parse per record, on an SD card.
//
//   A failure is a value, not an exception. Each entry keeps its last good value with an age, so a
//   two-second Electrum hiccup dims the dashboard rather than blanking it.
//
//   Everything resets when the daemon does. A pubky left over from a previous identity is worse
//   than no pubky at all.

const ENDPOINTS = {
  // In-memory reads on the daemon side, so polling them often is free.
  status: { path: '/status', every: 2000, idle: 10000, timeout: 3000 },
  limits: { path: '/limits', every: 3000, idle: 20000, timeout: 3000 },
  // A cached report the daemon recomputes every 15s; polling faster than this buys nothing.
  health: { path: '/health', every: 5000, idle: 15000, timeout: 5000 },
  // These two walk the store. They carry the widest gap between busy and idle for that reason.
  swaps: { path: '/swaps', every: 3000, idle: 20000, timeout: 8000 },
  earnings: { path: '/earnings', every: 30000, idle: 120000, timeout: 8000 },
  offer: { path: '/offer', every: 15000, idle: 60000, timeout: 5000 },
};

class StatusClient {
  constructor({ onChange = null } = {}) {
    this.onChange = onChange;
    this.base = '';
    this.token = '';
    this.entries = new Map();
    this.timers = new Map();
    this.running = false;
    this.watchers = 0;
    for (const name of Object.keys(ENDPOINTS)) {
      this.entries.set(name, { value: null, fetchedAt: 0, error: null, inFlight: false });
    }
  }

  configure({ port, token, host = '127.0.0.1' }) {
    this.base = `http://${host}:${port}`;
    this.token = token;
  }

  /** Forget everything. Called whenever the provider process goes away. */
  reset() {
    for (const entry of this.entries.values()) {
      entry.value = null; entry.fetchedAt = 0; entry.error = null;
    }
    if (this.onChange) this.onChange();
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const name of Object.keys(ENDPOINTS)) this.schedule(name, 0);
  }

  stop() {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** How many browsers are watching, which decides busy vs idle cadence. */
  setWatchers(n) { this.watchers = Math.max(0, n | 0); }

  get(name) { return this.entries.get(name) || null; }

  value(name) {
    const entry = this.entries.get(name);
    return entry ? entry.value : null;
  }

  /** True when the daemon is answering at all. */
  get reachable() {
    const status = this.entries.get('status');
    return Boolean(status && status.value && !status.error);
  }

  /**
   * Busy when a swap is in flight or somebody is looking, idle otherwise.
   *
   * In flight wins over nobody watching: a swap moving is worth following closely even with the
   * dashboard closed, because that is what fills in the history someone reads later.
   */
  cadence(name) {
    const spec = ENDPOINTS[name];
    const status = this.value('status');
    const busy = this.watchers > 0 || (status && status.in_flight > 0);
    return busy ? spec.every : (spec.idle || spec.every);
  }

  schedule(name, delay) {
    if (!this.running) return;
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => this.poll(name), delay));
  }

  /** Fetch one endpoint now, out of band, and reschedule from this moment. */
  refresh(name) { this.schedule(name, 0); }

  async poll(name) {
    const entry = this.entries.get(name);
    const spec = ENDPOINTS[name];
    // One request per endpoint at a time: a slow /swaps on a loaded node must never stack.
    if (!this.running || !this.base || entry.inFlight) return this.schedule(name, this.cadence(name));
    entry.inFlight = true;
    const wasDown = Boolean(entry.error) || entry.fetchedAt === 0;
    let changed = false;
    try {
      const res = await fetch(this.base + spec.path, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(spec.timeout),
      });
      if (!res.ok) throw new Error(`status API answered ${res.status}`);
      const value = await res.json();
      const before = entry.value === null ? null : JSON.stringify(entry.value);
      entry.value = value;
      entry.fetchedAt = Date.now();
      entry.error = null;
      entry.failures = 0;
      changed = before !== JSON.stringify(value);
    } catch (e) {
      entry.failures = (entry.failures || 0) + 1;
      const message = e && e.name === 'TimeoutError' ? 'the status API did not answer in time' : String(e && e.message || e);
      changed = entry.error !== message;
      entry.error = message;
    } finally {
      entry.inFlight = false;
    }

    // The daemon just started answering after a spell of not answering. The slower endpoints are
    // sitting on a backoff earned while it was down, and waiting that out would leave the dashboard
    // without an offer or an earnings figure for a minute or more after everything is fine.
    if (name === 'status' && !entry.error && wasDown) {
      for (const other of Object.keys(ENDPOINTS)) if (other !== 'status') this.refresh(other);
    }
    // Back off on repeated failure, but never past the point where recovery would feel slow.
    const penalty = entry.failures ? Math.min(2 ** Math.min(entry.failures, 4), 8) : 1;
    this.schedule(name, this.cadence(name) * penalty);
    if (changed && this.onChange) this.onChange(name);
  }
}

module.exports = { StatusClient, ENDPOINTS };
