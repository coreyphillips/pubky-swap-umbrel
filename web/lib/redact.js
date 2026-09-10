'use strict';

// Strip secrets out of daemon output before it reaches the log buffer.
//
// Redacting at ingest rather than at serve time is the whole point. The log buffer is read by the
// status endpoint, the SSE stream, the log pane and anything added later; a secret that never
// enters the buffer cannot leave through a route someone adds next year.
//
// Exact substrings only. Two heuristics were considered and rejected: matching "eleven or more
// lowercase words" mangles ordinary prose, and blanking 64-hex strings would erase every txid,
// which is most of what the Activity view is for.

const secrets = require('./secrets');

const BEARER = /(authorization:\s*bearer\s+)\S+/gi;
const PLACEHOLDER = '[redacted]';

class Redactor {
  constructor() {
    this.needles = [];
    this.hits = 0;
  }

  /** Re-read the live secrets. Called after every identity change and every daemon start. */
  refresh(extra = []) {
    const all = [...secrets.liveSecrets(), ...extra].filter((s) => typeof s === 'string' && s.length >= 8);
    // Longest first, so a passphrase that happens to be a substring of the phrase still redacts
    // the larger match rather than leaving a fragment behind.
    this.needles = [...new Set(all)].sort((a, b) => b.length - a.length);
  }

  apply(line) {
    let out = String(line);
    for (const needle of this.needles) {
      if (out.includes(needle)) { out = out.split(needle).join(PLACEHOLDER); this.hits++; }
    }
    const bearer = out.replace(BEARER, `$1${PLACEHOLDER}`);
    if (bearer !== out) { this.hits++; out = bearer; }
    return out;
  }
}

module.exports = { Redactor, PLACEHOLDER };
