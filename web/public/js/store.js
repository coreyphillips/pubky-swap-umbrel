// A snapshot the tabs read and nothing else writes. Layer 1.

export function createStore(initial = null) {
  let state = initial;
  const subscribers = new Set();
  let queued = false;

  function notify() {
    if (queued) return;
    queued = true;
    // Coalesce: several updates can land in one tick and a tab only needs to render the result.
    queueMicrotask(() => {
      queued = false;
      for (const fn of subscribers) {
        try { fn(state); } catch (e) { console.error('subscriber failed', e); }
      }
    });
  }

  return {
    get: () => state,
    set(next) { state = next; notify(); },
    patch(partial) { state = { ...(state || {}), ...partial }; notify(); },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
}
