'use strict';

// A sequenced ring buffer of daemon output.
//
// Two things it does that the old string-array did not. It parses each line into
// {level, target, message}, so the log pane can tint by level instead of guessing with a regex over
// prose -- guessing is how a line that merely contains the word "error" ends up red. And it stamps
// every line with a monotonic sequence number, so a client can ask for "everything after 1841"
// and the pane can append rather than re-rendering the whole block every few seconds, which is what
// destroys text selection and scroll position while you are reading.

const { hasControlChar, stripAnsi } = require('./text');

// 2026-09-09T20:48:50.150800Z  INFO swap_provider: Provider pubky: ...
const LINE = /^(\S+)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+)\s*:\s*([\s\S]*)$/;

const DEFAULT_CAPACITY = 1000;

class LogBuffer {
  constructor({ capacity = DEFAULT_CAPACITY, redactor = null, onLines = null } = {}) {
    this.capacity = capacity;
    this.redactor = redactor;
    this.onLines = onLines;
    this.lines = [];
    this.seq = 0;
    this.partial = '';
  }

  /**
   * Ingest a chunk of stdout or stderr.
   *
   * Chunks are not line-aligned, so a trailing fragment is held back until its newline arrives --
   * otherwise a long line arrives split in two and the level parse fails on the second half.
   */
  push(chunk, stream = 'out') {
    const text = this.partial + stripAnsi(chunk);
    const parts = text.split('\n');
    this.partial = parts.pop();
    const added = [];
    for (const raw of parts) {
      if (!raw.trim()) continue;
      added.push(this.record(raw, stream));
    }
    if (added.length && this.onLines) this.onLines(added);
    return added;
  }

  /**
   * Add a line of this app's own, so operator-facing notes sit in the same stream as the daemon's.
   *
   * Built as a record directly rather than formatted into a tracing-shaped string and re-parsed:
   * round-tripping would make the app's own notes depend on its own log regex, which is exactly
   * the fragility this module exists to remove.
   */
  note(message, level = 'INFO') {
    const line = this.add({ level, target: 'pubky-swap-app', message: String(message), stream: 'app' });
    if (this.onLines) this.onLines([line]);
    return line;
  }

  record(raw, stream) {
    const text = this.redactor ? this.redactor.apply(raw) : raw;
    const m = LINE.exec(text);
    return this.add(m
      ? { level: m[2], target: m[3], message: m[4], stream }
      : { level: stream === 'err' ? 'ERROR' : 'INFO', target: '', message: text, stream });
  }

  add({ level, target, message, stream }) {
    const line = { seq: ++this.seq, at: Date.now(), stream, level, target, message };
    if (hasControlChar(line.message)) line.message = line.message.replace(/[^\P{C}]/gu, ' ');
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    return line;
  }

  /** Lines newer than `sinceSeq`, newest last, at most `limit`. */
  since(sinceSeq = 0, limit = 200) {
    const out = this.lines.filter((l) => l.seq > sinceSeq);
    return out.length > limit ? out.slice(-limit) : out;
  }

  /** The most recent `n` lines, for a first paint. */
  tail(n = 200) {
    return this.lines.slice(-n);
  }

  /** The raw text of the last `n` lines, for exit classification. */
  tailText(n = 40) {
    return this.lines.slice(-n).map((l) => l.message).join('\n');
  }

  clear() { this.lines = []; this.partial = ''; }
}

module.exports = { LogBuffer };
