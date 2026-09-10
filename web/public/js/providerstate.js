// How the provider's state is described, and the controls that change it. Layer 2.
//
// Shared, because it is rendered in two places: on Earn, next to the rates it affects, and in
// Settings, where someone looking for a stop button expects to find one. Two copies of this would
// drift, and the thing they would drift about is whether a daemon that is mid-swap is safe to
// stop.

import { el } from './dom.js';
import * as c from './components.js';
import { api } from './api.js';
import { toast } from './toast.js';

/**
 * "Running" is not one state.
 *
 * A provider that is up but cannot execute quotes happily and rejects every swap. One that refused
 * to start because starting would abandon funded swaps looks exactly like a crash loop and is the
 * opposite of one. Each gets its own words.
 */
export function describeProvider(snap) {
  const p = snap.provider;
  const views = {
    stopped: ['Stopped', 'idle',
      'Not advertising. Swaps already in flight are not being driven while this is off.'],
    starting: ['Starting', 'info', 'Connecting to your node.'],
    running: p.capable
      ? ['Live', 'ok', 'Advertising and serving swaps.']
      : ['Quoting only', 'warn',
        'You are discoverable and you will quote a price, but every swap request is rejected until the checks below pass. Nobody loses money; they just cannot swap with you.'],
    unreachable: ['Not answering', 'warn',
      'The provider is running but its status API is not responding. It has not been restarted: a provider in the middle of a swap is still driving money.'],
    restarting: ['Restarting', 'warn', `Restarting after an unexpected exit (attempt ${p.restartCount}).`],
    refusing: ['Held back', 'bad',
      'The provider refused to start on purpose, because starting would abandon swaps that are still in flight. This is not a crash.'],
    failed: ['Refused to start', 'bad', 'The provider will not start with these settings.'],
    stopping: ['Stopping', 'idle', 'Unwinding cleanly.'],
  };
  const [label, tone, body] = views[p.state] || ['Unknown', 'idle', ''];
  return { label, tone, body, state: p.state };
}

/** Start, or stop and restart. Never both sets at once. */
export function providerControls(snap) {
  const p = snap.provider;
  const down = ['stopped', 'failed', 'refusing'].includes(p.state);
  if (down) {
    return [c.button({
      label: 'Start', variant: 'primary', busyLabel: 'Starting',
      onClick: async () => { await api.startProvider(); toast('Provider starting', 'ok'); },
    })];
  }
  return [
    c.button({
      label: 'Restart', busyLabel: 'Restarting',
      onClick: async () => { await api.restartProvider(); toast('Provider restarting'); },
    }),
    c.button({ label: 'Stop', onClick: () => confirmStop(snap) }),
  ];
}

/**
 * Stopping with money in flight is worth one sentence about what it actually means.
 *
 * Nothing drives a swap while the provider is off, and a refund that comes due is not broadcast,
 * so this is the difference between a pause and an abandonment.
 */
function confirmStop(snap) {
  const inFlight = (snap.provider && snap.provider.inFlight) || 0;
  if (!inFlight) return api.stopProvider().then(() => toast('Provider stopping'));

  const m = c.modal({
    title: 'Stop the provider?',
    body: el('div', {},
      el('p', {
        text: `Nobody will find you and no new swaps will start. ${inFlight} swap${inFlight === 1 ? ' is' : 's are'} still in flight, and while the provider is stopped nothing is driving ${inFlight === 1 ? 'it' : 'them'}: a refund that comes due will not be broadcast until you start it again.`,
      })),
    actions: [
      c.button({ label: 'Cancel', onClick: () => m.close() }),
      c.button({
        label: 'Stop anyway', variant: 'danger',
        onClick: async () => { m.close(); await api.stopProvider(); toast('Provider stopping'); },
      }),
    ],
  });
}
