import { el, fill } from './dom.js';
import * as c from './components.js';
import { api } from './api.js';
import { toast } from './toast.js';

export function accessCard() {
  const body = el('div', {}, el('p.muted', { text: 'Loading access policy...' }));
  const card = c.card({ title: 'Who can swap with you' }, body);
  const load = async () => {
    try { render(await api.accessPolicy()); }
    catch (error) {
      fill(body, c.note(error.message, { tone: 'bad' }),
        c.button({ label: 'Retry', onClick: load }),
        error.code === 'ACCESS_POLICY_UNAVAILABLE'
          ? c.button({ label: 'Replace policy', onClick: () => render({ mode: 'approved_only', allowed: [], blocked: [] }) })
          : null);
    }
  };
  function render(policy) {
    const mode = el('select', {},
      el('option', { text: 'Open to everyone except blocked Pubkys', attrs: { value: 'open' } }),
      el('option', { text: 'Only approved Pubkys', attrs: { value: 'approved_only' } }));
    mode.value = policy.mode;
    const allowed = el('textarea', { attrs: { rows: 5, spellcheck: 'false', placeholder: 'One Pubky per line' } });
    const blocked = el('textarea', { attrs: { rows: 5, spellcheck: 'false', placeholder: 'One Pubky per line' } });
    allowed.value = policy.allowed.join('\n');
    blocked.value = policy.blocked.join('\n');
    const state = el('p.small.muted');
    const explain = el('p.small.muted');
    const entries = (input) => input.value.split(/[\s,]+/).filter(Boolean);
    const update = () => {
      state.textContent = 'Unsaved changes';
      explain.textContent = mode.value === 'approved_only' && !entries(allowed).length
        ? 'No Pubkys are approved. Saving will deny all new quotes and swaps.'
        : 'Blocked Pubkys always take precedence. The approved list is used only in approved-only mode.';
    };
    mode.addEventListener('change', update);
    allowed.addEventListener('input', update);
    blocked.addEventListener('input', update);
    update();
    state.textContent = '';
    const save = c.button({
      label: 'Save access policy', variant: 'primary', busyLabel: 'Saving',
      onClick: async () => {
        try {
          const saved = await api.saveAccessPolicy({ mode: mode.value, allowed: entries(allowed), blocked: entries(blocked) });
          render(saved);
          toast('Access policy saved. New requests use these rules.', 'ok');
        } catch (error) { state.textContent = error.message; toast(error.message, 'bad'); }
      },
    });
    fill(body,
      c.field({ label: 'Access mode', control: mode }),
      el('div.grid.c2', {},
        c.field({ label: 'Approved Pubkys', control: allowed }),
        c.field({ label: 'Blocked Pubkys', control: blocked })),
      explain,
      el('p.small.muted', { text: 'Enter up to 256 Pubkys per list. Pubky links are accepted. For Bitkit, use the owning Pubky account, not its device key.' }),
      el('p.small.muted', { text: 'Changes apply to new quotes and swaps without a restart. Accepted swaps continue and remain recoverable. Offers remain discoverable.' }),
      el('p.small.muted', { text: 'Someone can create another Pubky to evade a block. Use approved-only access for a private service.' }),
      el('div.actions', {}, save, c.button({ label: 'Reload saved policy', onClick: load }), state));
  }
  load();
  return card;
}
