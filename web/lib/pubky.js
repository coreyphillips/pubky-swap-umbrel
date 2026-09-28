'use strict';

const { httpError } = require('./http');

// Match the native engine's accepted prefixes before choosing any journal or guard key.
function canonicalProvider(value) {
  let key = String(value || '').trim().replace(/\/+$/, '');
  if (key.length !== 52) key = key.replace(/^(?:pubky:\/\/|pubky:|pubky|pk:)/, '');
  if (!/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(key)) {
    throw httpError(400, 'INVALID', 'That does not look like a provider pubky.');
  }
  return key;
}

module.exports = { canonicalProvider };
