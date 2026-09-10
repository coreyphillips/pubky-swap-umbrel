// Formatting. Layer 0: imports nothing.
//
// One unit convention runs through the whole panel: sats, with thousand separators. Everything the
// engine handles is denominated in sats, and mixing units is how someone mis-keys an amount by a
// factor of a hundred million.
//
// Every timestamp this app receives is in *seconds*, because that is what the engine's records and
// its status API use. Every function here takes seconds. Getting that wrong silently renders 1970.

export function sats(n, { unit = true } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US') + (unit ? ' sat' : '');
}

/** For stat tiles, where a nine-digit number would wrap. */
export function satsCompact(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} BTC`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M sat`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k sat`;
  return sats(v);
}

export function btc(satoshis) {
  if (satoshis == null) return '—';
  return `${(Number(satoshis) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} BTC`;
}

export function pct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const v = Number(value);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

/** Truncate a key for display. The full value is always what gets copied. */
export function shortKey(value, n = 6) {
  const s = String(value || '');
  if (!s) return '—';
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
}

/** Seconds since the epoch, as a relative phrase. */
export function relTime(unixSeconds) {
  if (!unixSeconds) return '—';
  const delta = Math.floor(Date.now() / 1000) - Number(unixSeconds);
  if (delta < 0) return 'just now';
  if (delta < 10) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString();
}

export function absTime(unixSeconds) {
  if (!unixSeconds) return '—';
  return new Date(Number(unixSeconds) * 1000).toLocaleString();
}

/** A duration in the largest unit that still reads as a number rather than a measurement. */
export function duration(seconds) {
  const s = Math.abs(Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)} days`;
}

/**
 * Blocks as wall-clock, always hedged.
 *
 * Ten minutes a block is an average, not a promise, so the output is always prefixed. A bare
 * duration here would be a precision the number does not have.
 */
export function blocksToTime(blocks) {
  const n = Number(blocks);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `~${duration(n * 600)}`;
}

/** What a provider earns on one swap, at these rates. */
export function feeOn(amount, baseFee, feePpm) {
  return Number(baseFee || 0) + Math.floor((Number(amount) || 0) * (Number(feePpm) || 0) / 1e6);
}

export function titleCase(s) {
  return String(s || '').replace(/[_.-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// The offer's directions, worded from the taker's side because that is who reads the offer.
//
// Joined with "or", not "and": a taker picks one. "They send on-chain and they receive on-chain"
// reads as a single confused sentence about one swap rather than two things on the menu.
export function directions(list) {
  const phrase = (d) => (d === 'submarine' ? 'they send on-chain' : 'they receive on-chain');
  const words = (list || []).map(phrase);
  if (!words.length) return null;
  return words.join(' or ');
}
