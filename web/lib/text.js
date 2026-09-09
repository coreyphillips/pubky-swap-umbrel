'use strict';

// Small string predicates shared by the config writer and the secret store.

/**
 * True if `value` contains a C0 control character or DEL.
 *
 * Written as a scan rather than a regex character class so the range does not have to appear
 * literally in the source of a file that is itself often edited through a shell.
 */
function hasControlChar(value) {
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * tracing colours its output by default, so every line the daemons emit arrives wrapped in escape
 * sequences. Strip them once, at ingest, rather than making every reader cope.
 */
const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(value) {
  return String(value).replace(ANSI, '');
}

module.exports = { hasControlChar, stripAnsi };
