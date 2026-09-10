'use strict';

// Who may change anything.
//
// This app sits on Umbrel's shared network, so every other app on the node can reach this port.
// app_proxy is what fronts the browser with Umbrel's own authentication; anything arriving from
// elsewhere has bypassed it. Restricting changes to the proxy and to loopback is what keeps
// another app on the box from driving a daemon that moves money.
//
// An earlier version of this guard accepted 10/8, 192.168/16 and 172.16/12 wholesale, on the
// reasoning that the proxy lives on a private bridge. Every other app on an Umbrel lives on that
// same bridge. Putting two of these containers on one network and having the second POST
// `{"action":"clear"}` at the first returned HTTP 200, and the first app's Pubky identity was
// gone. Any app on the box could also have stopped the provider mid-swap.
//
// Two addresses are legitimate, and a peer container can forge neither, because packets from a
// peer carry the peer's own address:
//
//  - The bridge **gateway**. Current umbrelOS proxies from the host, so that is where the
//    connection enters the container from. Read from the routing table, so there is no window
//    before it is known.
//  - **`app_proxy`**, on older umbrelOS where that sidecar still exists. Resolved by Docker DNS,
//    and re-resolved because its address changes across restarts.
//
// Reads are deliberately left open. The status view holds no secret, and gating it would mean
// that if the allow list were ever wrong you would meet a blank page instead of the message
// telling you what to fix.

const fs = require('fs');
const dns = require('dns');

const REFRESH_MS = 60000;

function createAccessGuard({ log = () => {} } = {}) {
  const allowed = new Set();
  let warned = new Set();

  for (const extra of String(process.env.CONTROL_PLANE_ALLOW || '').split(',')) {
    if (extra.trim()) allowed.add(extra.trim());
  }
  addGatewayAddresses(allowed);
  refreshAppProxy(allowed, log);
  const timer = setInterval(() => refreshAppProxy(allowed, log), REFRESH_MS);
  if (timer.unref) timer.unref();

  log(allowed.size
    ? `Changes accepted from loopback and ${[...allowed].join(', ')}.`
    : 'Changes accepted from loopback only.');

  /** True if this request may change something. Reads never come here. */
  return function allowChange(req) {
    const addr = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    if (addr === '127.0.0.1' || addr === '::1') return true;
    if (allowed.has(addr)) return true;
    // Said out loud, once per address. A guard that refuses the only way in and explains nothing
    // is how an operator ends up locked out of their own swaps with no idea why.
    if (!warned.has(addr)) {
      warned.add(addr);
      if (warned.size > 50) warned = new Set([addr]);
      log(`Refused a change from ${addr}. If that is how you reach this app, set ` +
        `CONTROL_PLANE_ALLOW=${addr} on the container.`);
    }
    return false;
  };
}

function addGatewayAddresses(allowed) {
  try {
    // `Destination 00000000` is the default route; `Gateway` is little-endian hex.
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)) {
      const f = line.split(/\s+/);
      if (f[1] !== '00000000' || !f[2] || f[2] === '00000000') continue;
      const n = parseInt(f[2], 16);
      allowed.add([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff].join('.'));
    }
  } catch {
    // Not Linux, or no procfs: a developer running this outside a container, who reaches it on
    // loopback anyway.
  }
}

function refreshAppProxy(allowed, log) {
  // `all: true` because the container can be on more than one network, and the connection uses
  // whichever one it uses.
  dns.lookup('app_proxy', { all: true }, (err, addrs) => {
    if (err) return; // Not that generation of umbrelOS, or not up yet. The gateway covers it.
    for (const a of addrs || []) {
      if (a.address && !allowed.has(a.address)) {
        allowed.add(a.address);
        log(`Changes also accepted from app_proxy at ${a.address}.`);
      }
    }
  });
}

module.exports = { createAccessGuard };
