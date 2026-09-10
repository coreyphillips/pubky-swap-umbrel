// Talking to the control server. Layer 1.

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'INTERNAL', remedy = null, offline = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.remedy = remedy;
    // Distinguishes "the server is gone" from "the server said no", which the connection state
    // needs: a 400 on a bad form value must not count towards being disconnected.
    this.offline = offline;
  }
}

async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
  const init = { method, signal, headers: {} };
  if (raw) {
    init.headers['Content-Type'] = 'application/octet-stream';
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError('Could not reach the control server.', { offline: true });
  }

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    const err = (payload && payload.error) || {};
    throw new ApiError(err.message || `The server answered ${res.status}.`, {
      status: res.status, code: err.code || 'INTERNAL', remedy: err.remedy || null,
    });
  }
  return payload;
}

export const api = {
  bootstrap: (signal) => request('/api/bootstrap', { signal }),
  state: (signal) => request('/api/state', { signal }),
  logs: (since, signal) => request(`/api/logs?since=${since || 0}`, { signal }),
  diagnostics: (signal) => request('/api/diagnostics', { signal }),
  runDiagnostics: () => request('/api/diagnostics/run', { method: 'POST', body: {} }),

  saveSettings: (patch) => request('/api/settings', { method: 'POST', body: patch }),

  setPhrase: (phrase) => request('/api/identity/phrase', { method: 'POST', body: { phrase } }),
  setPassphrase: (passphrase) => request('/api/identity/passphrase', { method: 'POST', body: { passphrase } }),
  uploadRecoveryFile: (bytes) => request('/api/identity/file', { method: 'POST', body: bytes, raw: true }),
  probeIdentity: () => request('/api/identity/probe', { method: 'POST', body: {} }),
  clearIdentity: () => request('/api/identity/clear', { method: 'POST', body: {} }),

  startProvider: () => request('/api/provider/start', { method: 'POST', body: {} }),
  stopProvider: () => request('/api/provider/stop', { method: 'POST', body: {} }),
  restartProvider: () => request('/api/provider/restart', { method: 'POST', body: {} }),

  quote: (input) => request('/api/taker/quote', { method: 'POST', body: input }),
  swap: (input) => request('/api/taker/swap', { method: 'POST', body: input }),
  cancelSwap: (force) => request('/api/taker/cancel', { method: 'POST', body: { force: !!force } }),
  resumeSwaps: () => request('/api/taker/resume', { method: 'POST', body: {} }),

  ackNotice: (code) => request('/api/notices/ack', { method: 'POST', body: { code } }),
};
