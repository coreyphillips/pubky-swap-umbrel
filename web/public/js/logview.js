// The daemon's output, as something to read. Layer 2.
//
// Appends rather than rewrites. The old panel set `pre.textContent` to the whole buffer every three
// seconds, which threw away your text selection and your scroll position every time you tried to
// read a line. Lines here arrive with a sequence number, so a new batch is appended and everything
// already on screen stays exactly where it was.
//
// Level tinting comes from the structured level the server parses off each line, not from a regex
// hunting for the word "error" in the message -- which is how a line that merely mentions an error
// ends up painted like one.

import { el, clear } from './dom.js';
import { copy } from './clipboard.js';
import { toast } from './toast.js';

const FOLLOW_SLOP_PX = 24;

export function createLogView({ title = 'Log' } = {}) {
  let seq = 0;
  let follow = true;
  let filter = '';

  const body = el('div.log-body', { attrs: { role: 'log', 'aria-label': title } });
  const filterInput = el('input', {
    attrs: { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter the log' },
  });
  const followToggle = el('button.btn', {
    text: 'Following', dataset: { size: 'sm' }, attrs: { type: 'button', 'aria-pressed': 'true' },
  });
  const jump = el('button.btn.hidden', {
    text: 'Jump to latest', dataset: { size: 'sm' }, attrs: { type: 'button' },
  });

  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim().toLowerCase();
    applyFilter();
  });

  followToggle.addEventListener('click', () => setFollow(!follow));
  jump.addEventListener('click', () => { setFollow(true); body.scrollTop = body.scrollHeight; });

  // Scrolling up disengages follow silently: nothing is more annoying than a pane that yanks you
  // back to the bottom while you are reading something that scrolled past.
  body.addEventListener('scroll', () => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < FOLLOW_SLOP_PX;
    if (!atBottom && follow) setFollow(false);
    if (atBottom && !follow) setFollow(true);
  });

  function setFollow(next) {
    follow = next;
    followToggle.setAttribute('aria-pressed', String(next));
    followToggle.textContent = next ? 'Following' : 'Paused';
    jump.classList.toggle('hidden', next);
  }

  function applyFilter() {
    for (const line of body.children) {
      const match = !filter || line.dataset.search.includes(filter);
      line.classList.toggle('filtered', !match);
    }
  }

  function lineNode(line) {
    const node = el('div.log-line', {
      dataset: { level: line.level, search: `${line.target} ${line.message}`.toLowerCase() },
    },
      el('span.log-target', { text: line.target ? `${line.target}  ` : '' }),
      el('span', { text: line.message }));
    return node;
  }

  function append(lines) {
    const fresh = lines.filter((l) => l.seq > seq);
    if (!fresh.length) return;
    seq = fresh[fresh.length - 1].seq;
    for (const line of fresh) body.appendChild(lineNode(line));
    // Keep the DOM bounded; the server's own buffer is the archive.
    while (body.children.length > 1000) body.removeChild(body.firstChild);
    applyFilter();
    if (follow) body.scrollTop = body.scrollHeight;
  }

  function reset(lines) {
    clear(body);
    seq = 0;
    append(lines);
  }

  const node = el('div', {},
    el('div.logbar', {},
      filterInput,
      followToggle,
      el('button.btn', {
        text: 'Copy', dataset: { size: 'sm' }, attrs: { type: 'button' },
        on: {
          click: async () => {
            const text = [...body.children].map((c) => c.textContent).join('\n');
            const ok = await copy(text);
            toast(ok ? 'Log copied' : 'Could not copy', ok ? 'ok' : 'bad');
          },
        },
      }),
      jump),
    body);

  return { node, append, reset, get seq() { return seq; } };
}
