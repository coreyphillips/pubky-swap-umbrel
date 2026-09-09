'use strict';

// A TOML emitter for the small, closed set of values this app writes.
//
// Why a config file at all, when every setting also has a flag: upstream resolves
// `$PUBKY_SWAP_CONFIG` ahead of the environment and the flags, so writing one file and pointing
// the daemon at it means `--doctor` and `--show-config` see *exactly* what the running daemon
// sees. Guided diagnostics is only trustworthy if that is true.
//
// It also sidesteps a real footgun in the environment layer. Upstream merges env vars through
// figment with `.split("__")`, and figment parses each value, so
// `PUBKY_SWAP_DIRECTIONS="submarine,reverse"` does not deserialize into a list -- it would need
// the bracket form. In TOML it is `["submarine", "reverse"]` and there is nothing to get wrong.
//
// This is an emitter, not a parser, and it handles exactly four value shapes. Anything else
// throws, because every value it is given is one of our own paths or enum values -- a rejection
// here is a bug in the caller, not bad user input.

/** Characters TOML would need escaping for, or that would break the line structure. */
const CONTROL = /[\x00-\x1f\x7f]/;

function emitString(value) {
  if (CONTROL.test(value)) {
    throw new Error('refusing to write a TOML string containing a control character');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function emitValue(key, value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`refusing to write a non-finite number for ${key}`);
    if (!Number.isInteger(value)) throw new Error(`refusing to write a fractional number for ${key}`);
    return String(value);
  }
  if (typeof value === 'string') return emitString(value);
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) {
      throw new Error(`refusing to write a non-string array for ${key}`);
    }
    return `[${value.map(emitString).join(', ')}]`;
  }
  throw new Error(`refusing to write an unsupported TOML value for ${key}`);
}

/**
 * Render a flat object as TOML. Keys whose value is `undefined` or `null` are omitted entirely,
 * which is what lets a caller express "leave this to the daemon's own default" -- upstream layers
 * its defaults under the file, so an absent key is not the same as a key set to zero.
 */
function emit(obj, header) {
  const lines = [];
  if (header) for (const line of String(header).split('\n')) lines.push(`# ${line}`.trimEnd());
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid TOML key: ${key}`);
    lines.push(`${key} = ${emitValue(key, value)}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { emit };
