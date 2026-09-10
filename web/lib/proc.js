'use strict';

// Child-process primitives shared by the provider supervisor and the taker.

/**
 * Terminate a child and resolve once it is actually gone.
 *
 * The previous version of this app sent SIGTERM and immediately set its handle to null. Two things
 * followed from that: a hung daemon became an orphan nothing held a reference to, and -- because a
 * restart spawned the replacement before the old process had died -- the *old* child's exit handler
 * ran afterwards and cleared the handle belonging to the *new* one. The panel then reported a
 * stopped provider while one was still running, and could no longer stop it.
 *
 * This always settles: SIGTERM, escalate to SIGKILL after the grace period, and give up waiting a
 * few seconds after that so a caller can never be blocked forever by an unkillable process.
 */
function killProc(child, graceMs = 10000, hardMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(kill); clearTimeout(giveUp); resolve(); } };
    child.once('exit', finish);
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, graceMs);
    const giveUp = setTimeout(finish, graceMs + hardMs);
    try { child.kill('SIGTERM'); } catch { finish(); }
  });
}

/** Exponential backoff, capped. Restarts never stop entirely: see provider.js. */
function backoffMs(attempt) {
  return Math.min(30000, 1000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 5));
}

/** Serialize async operations so start/stop/restart can never interleave. */
function createQueue() {
  let chain = Promise.resolve();
  return function enqueue(fn) {
    const next = chain.then(fn, fn);
    // Swallow rejections on the chain itself so one failure cannot poison every later operation.
    chain = next.then(() => {}, () => {});
    return next;
  };
}

module.exports = { killProc, backoffMs, createQueue };
