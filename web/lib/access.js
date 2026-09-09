'use strict';

// Source-restricting the API to Umbrel's app_proxy.
//
// Ported from the same author's beignet-umbrel manager, for the same reason and with the same
// safeguards; this is the plain-http version of it.
//
// app_proxy fronts the browser with Umbrel's single sign-on, but this container also sits on
// Umbrel's shared app network, where every other installed app can reach port 3000 by name or IP
// and skip the proxy entirely. On an app that can move funds, that gap matters: without this guard,
// putting app_proxy in front only stops a person, not a co-installed or compromised app.
//
// It judges on the real TCP peer, never on X-Forwarded-For, which anyone can set. app_proxy is
// resolved through Docker DNS and re-resolved periodically because its address changes across
// restarts.
//
// Two safeguards against ever locking an operator out of their own panel: it fails open until
// app_proxy has resolved at least once, so a DNS hiccup degrades to the previous behaviour rather
// than bricking the dashboard, and PUBKY_SWAP_TRUST_ALL=1 turns it off outright.

const dns = require('dns').promises;

const APP_ID = process.env.APP_ID || 'pubky-swap';
// Never the bare "app_proxy": that alias is shared by every app on the network, so it would be
// ambiguous. The candidates cover both container-name schemes umbrelOS has used.
const PROXY_HOSTS = process.env.APP_PROXY_HOST
  ? [process.env.APP_PROXY_HOST]
  : [`app_proxy_${APP_ID}`, `${APP_ID}_app_proxy_1`, `${APP_ID}-app_proxy-1`];
const REFRESH_MS = 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

function normalizeIp(ip) {
  if (!ip) return ip;
  // Strip an IPv4-mapped IPv6 prefix (::ffff:10.21.0.5 -> 10.21.0.5).
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isEnabled() {
  const v = String(process.env.PUBKY_SWAP_TRUST_ALL || '').toLowerCase();
  return !(v === '1' || v === 'true');
}

function createAccessGuard({ log = () => {} } = {}) {
  if (!isEnabled()) {
    log('Access control is off (PUBKY_SWAP_TRUST_ALL is set); the API accepts any source.');
    return () => true;
  }

  let allowed = new Set();
  let everResolved = false;
  let warnedFailOpen = false;

  async function refresh() {
    const next = new Set();
    for (const host of PROXY_HOSTS) {
      try {
        for (const r of await dns.lookup(host, { all: true })) next.add(normalizeIp(r.address));
      } catch { /* this name is not resolvable here; try the others */ }
    }
    if (next.size) {
      allowed = next;
      if (!everResolved) log(`Restricting the API to app_proxy (${[...next].join(', ')}) and loopback.`);
      everResolved = true;
    }
  }

  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  if (timer.unref) timer.unref();

  /** True if this request may proceed. */
  return function allow(req) {
    const ip = normalizeIp(req.socket && req.socket.remoteAddress);
    if (LOOPBACK.has(ip) || allowed.has(ip)) return true;
    if (!everResolved) {
      if (!warnedFailOpen) {
        log('app_proxy has not resolved yet; allowing every source until it does.');
        warnedFailOpen = true;
      }
      refresh();
      return true;
    }
    // Re-resolve in case the proxy's address just changed: this request is judged on the current
    // set, the next one on the refreshed set.
    refresh();
    return false;
  };
}

module.exports = { createAccessGuard, normalizeIp };
