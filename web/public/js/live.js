// Keeping the page in step with the server. Layer 1.
//
// SSE first, polling as the declared fallback, and one connection state derived from whichever is
// running. Two bugs in the old panel shaped this module:
//
//   Its poll chains stacked. `pollSwap` was started on load, again on Start, again on Cancel, with
//   no clearTimeout and no in-flight guard, so a few clicks had the page hitting the server several
//   times a second. Here there is exactly one timer, created in one place, and re-armed only in the
//   `finally` of the request before it -- so a slow response delays the next request instead of
//   overlapping it, and there is no second call site that could start a parallel chain.
//
//   It swallowed every error with an empty catch, so a server that had died looked like a page
//   that was simply calm. Failures are counted here and surfaced as a state the header renders.

import { api, ApiError } from './api.js';

const POLL_MS = 4000;
const SLOW_AFTER = 2;
const DISCONNECTED_AFTER = 3;

export function createLive({ store, onConnection, onLog }) {
  let source = null;
  let timer = null;
  let controller = null;
  let failures = 0;
  let connection = 'connecting';
  let mode = 'sse';
  let lastUpdate = 0;
  let sseErrors = 0;
  let sseErrorWindow = 0;
  let stopped = false;

  function setConnection(next) {
    if (connection === next) return;
    connection = next;
    if (onConnection) onConnection(connection, lastUpdate);
  }

  function ok(snapshot) {
    failures = 0;
    lastUpdate = Date.now();
    if (snapshot) store.set(snapshot);
    setConnection('live');
    if (onConnection) onConnection(connection, lastUpdate);
  }

  function failed() {
    failures++;
    if (failures >= DISCONNECTED_AFTER) setConnection('disconnected');
    else if (failures >= SLOW_AFTER) setConnection('slow');
    if (onConnection) onConnection(connection, lastUpdate);
  }

  // --- polling fallback ---
  function schedule(delay = POLL_MS) {
    clearTimeout(timer);
    if (stopped) return;
    // Back off while it is down, but never so far that recovery feels slow.
    const penalty = Math.min(2 ** Math.min(failures, 3), 8);
    timer = setTimeout(poll, delay * (failures ? penalty : 1));
  }

  async function poll() {
    if (stopped || document.hidden) return schedule();
    controller?.abort();
    controller = new AbortController();
    try {
      ok(await api.state(controller.signal));
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      failed();
    } finally {
      schedule();
    }
  }

  function startPolling(reason) {
    if (mode === 'poll') return;
    mode = 'poll';
    if (reason) console.info(`live updates: falling back to polling (${reason})`);
    schedule(0);
  }

  // --- SSE ---
  function startSse() {
    if (typeof EventSource === 'undefined') return startPolling('EventSource is unavailable');
    try {
      source = new EventSource('/api/stream');
    } catch {
      return startPolling('the stream could not be opened');
    }

    source.addEventListener('open', () => { sseErrors = 0; ok(null); });
    source.addEventListener('snapshot', (ev) => {
      try { ok(JSON.parse(ev.data)); } catch { /* a truncated frame is not a disconnect */ }
    });
    source.addEventListener('log', (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (onLog) onLog(payload.lines || []);
      } catch { /* ignore */ }
    });
    source.addEventListener('bye', () => { close(); startPolling('the server closed the stream'); });
    source.addEventListener('error', () => {
      failed();
      const now = Date.now();
      if (now - sseErrorWindow > 10000) { sseErrors = 0; sseErrorWindow = now; }
      sseErrors++;
      // Two failures inside ten seconds without an intervening open means this connection is not
      // going to work here -- most likely a proxy buffering the stream. Stop retrying it and poll,
      // which always works.
      if (sseErrors >= 2) { close(); startPolling('the stream kept dropping'); }
    });
  }

  function close() {
    if (source) { try { source.close(); } catch {} source = null; }
  }

  // A hidden tab costs the node nothing: the server drops to its idle cadence once nobody is
  // listening, and coming back refreshes immediately so it feels instant rather than stale.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      close();
    } else if (!stopped) {
      if (mode === 'sse') startSse(); else schedule(0);
      api.state().then(ok).catch(() => failed());
    }
  });

  return {
    async start() {
      try {
        const boot = await api.bootstrap();
        ok(boot);
        if (onLog && boot.log) onLog(boot.log.provider || []);
      } catch (e) {
        failed();
        if (e instanceof ApiError && !e.offline) throw e;
      }
      startSse();
      // A slow heartbeat alongside the stream, so a stream that is open but silent -- a proxy
      // holding frames, say -- still gets noticed rather than reading as a quiet node.
      setInterval(() => {
        if (stopped || document.hidden || mode === 'poll') return;
        if (Date.now() - lastUpdate > 45000) api.state().then(ok).catch(() => failed());
      }, 20000);
    },
    stop() { stopped = true; clearTimeout(timer); close(); },
    get connection() { return connection; },
    get lastUpdate() { return lastUpdate; },
    refresh: () => api.state().then(ok).catch(() => failed()),
  };
}
