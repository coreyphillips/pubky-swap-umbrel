// Public connection details shared with Bitkit. Never include control API credentials or URLs.

import qrcode from './vendor/qrcode-generator.js';

const NETWORKS = new Set(['bitcoin', 'testnet', 'signet', 'regtest']);
const PUBKY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

export function connectionUri(pubky, network) {
  if (typeof pubky !== 'string' || !PUBKY.test(pubky) || !NETWORKS.has(network)) return null;
  return `pubkyswap://connect?${new URLSearchParams({ pubky, network })}`;
}

function networkName(value) {
  return value === 'mainnet' ? 'bitcoin' : value;
}

export function connectionDetails(snap) {
  const p = snap.provider || {};
  if (snap.settings?.role === 'taker') {
    return { reason: 'This node is set up to swap only. Enable a provider in Settings to connect Bitkit.' };
  }
  if (!snap.setup?.configured) {
    return { reason: 'Finish setting up your Pubky identity to connect Bitkit.' };
  }
  if (p.state !== 'running' || !p.statusApi?.reachable) {
    return { reason: p.running
      ? 'Your provider is getting ready. The connection code appears when it is answering.'
      : 'Start your provider to show its connection code.' };
  }
  // Use the running daemon's network. Never silently turn an unknown chain into mainnet.
  const network = networkName(p.network);
  if (network !== networkName(snap.env?.network)) {
    return { reason: 'The provider network does not match this node. Check Settings before connecting Bitkit.' };
  }
  const uri = connectionUri(p.pubky, network);
  if (!uri) return { reason: 'Waiting for a valid provider identity and network.' };
  return { uri, pubky: p.pubky, network, available: p.capable === true };
}

let cachedUri;
let cachedQr;

/** Locally generated vector QR with a four-module quiet zone and no markup interpolation. */
export function connectionQr(uri) {
  if (uri !== cachedUri) {
    const qr = qrcode(0, 'M');
    qr.addData(uri, 'Byte');
    qr.make();
    cachedQr = qr;
    cachedUri = uri;
  }
  const qr = cachedQr;
  const size = qr.getModuleCount();
  const edge = size + 8;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${edge} ${edge}`);
  svg.setAttribute('width', edge * 5);
  svg.setAttribute('height', edge * 5);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Scan with Bitkit to connect to this Pubky Swap provider');
  svg.setAttribute('class', 'connect-qr');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', edge);
  background.setAttribute('height', edge);
  background.setAttribute('fill', '#ffffff');
  svg.appendChild(background);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  let data = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) data += `M${col + 4},${row + 4}h1v1h-1z`;
    }
  }
  path.setAttribute('d', data);
  path.setAttribute('fill', '#000000');
  svg.appendChild(path);
  return svg;
}
