'use strict';

// Server-sent events, so the panel learns about a change when it happens rather than up to three
// seconds later.
//
// The deeper reason is load, not latency. This server polls the daemon's status API on a cadence;
// with browser polling, every open tab would multiply that, and /swaps and /earnings each walk the
// whole swap store. One stream fans out to every tab, and -- because the server knows when nobody
// is connected -- the upstream cadence can drop to idle when the dashboard is closed. Polling
// cannot express that.

const MAX_CLIENTS = 8;
const HEARTBEAT_MS = 15000;

class Sse {
  constructor({ onCount = null } = {}) {
    this.clients = new Set();
    this.onCount = onCount;
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  subscribe(req, res, initial) {
    if (this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.values().next().value;
      if (oldest) this.drop(oldest, 'too many dashboards are open');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Umbrel puts a proxy in front of this app. Without it, a buffering proxy would hold every
      // event until the response ended, which for a stream is never.
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    req.socket.setNoDelay(true);
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    if (this.onCount) this.onCount(this.clients.size);

    if (initial) this.sendTo(res, 'snapshot', initial);

    const close = () => this.drop(res);
    req.on('close', close);
    req.on('error', close);
    res.on('error', close);
  }

  drop(res, reason) {
    if (!this.clients.has(res)) return;
    this.clients.delete(res);
    try { if (reason) this.sendTo(res, 'bye', { reason }); res.end(); } catch {}
    if (this.onCount) this.onCount(this.clients.size);
  }

  sendTo(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { this.drop(res); }
  }

  broadcast(event, data) {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...this.clients]) {
      try { res.write(frame); } catch { this.drop(res); }
    }
  }

  ping() {
    for (const res of [...this.clients]) {
      try { res.write(': ping\n\n'); } catch { this.drop(res); }
    }
  }

  get count() { return this.clients.size; }

  closeAll() {
    clearInterval(this.heartbeat);
    for (const res of [...this.clients]) this.drop(res, 'the control panel is shutting down');
  }
}

module.exports = { Sse, MAX_CLIENTS };
