'use strict';

const NETWORK = process.env.NETWORK || 'mainnet';
const SWAP_NETWORK = {
  mainnet: 'bitcoin', bitcoin: 'bitcoin', testnet: 'testnet', signet: 'signet', regtest: 'regtest',
}[NETWORK];
if (!SWAP_NETWORK) throw new Error(`Unsupported Bitcoin network: ${NETWORK}`);

const LND_NETWORK_DIR = SWAP_NETWORK === 'bitcoin' ? 'mainnet' : SWAP_NETWORK;

module.exports = { NETWORK, SWAP_NETWORK, LND_NETWORK_DIR };
