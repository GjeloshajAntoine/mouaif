// mouaif web — the "App context" bar (docs/features/extensions.md)
//
// While extension views have given the model context in this chat
// (src/app-context.js), a bar above the composer says so: which views, and
// whether their context goes with the next prompt or was already sent. The
// panel shows each entry exactly as the model receives it, with Clear and
// Clear all. Reloaded when a view changes its context, after each prompt,
// and every 20 s while visible, as long as an extension view is active or
// context is showing.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { APP_CONTEXT_CHANGED } from './extensionEvents.js';
import { PuzzleIcon, useExtensionSurfaces } from './ExtensionDocks.jsx';
import './extension-ui.css';

const POLL_MS = 20000;

export function AppContextBar({ projectDir, chatId }) {
  const [entries, setEntries] = useState([]);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const surfaces = useExtensionSurfaces(projectDir, '');
  const shouldPoll = useRef(false);
  shouldPoll.current = surfaces.length > 0 || entries.length > 0;
  const base = '/api/extensions/context?projectDir=' + encodeURIComponent(projectDir || '') + '&chatId=' + encodeURIComponent(chatId || '');
  useEffect(() => {
    if (!projectDir || !chatId) { setEntries([]); return undefined; }
    let stopped = false;
    fetchJson(base).then((r) => { if (!stopped && r.status === 200) setEntries(r.body.entries || []); }, () => {});
    return () => { stopped = true; };
  }, [base, tick]);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const timer = setInterval(() => { if (shouldPoll.current && document.visibilityState !== 'hidden') bump(); }, POLL_MS);
    window.addEventListener(APP_CONTEXT_CHANGED, bump);
    return () => { clearInterval(timer); window.removeEventListener(APP_CONTEXT_CHANGED, bump); };
  }, []);
  useEffect(() => { setOpen(false); }, [projectDir, chatId]);
  if (!entries.length) return null;
  const pending = entries.filter((e) => !e.sent).length;
  const clear = async (key) => {
    await fetchJson(base + (key ? '&key=' + encodeURIComponent(key) : ''), { method: 'DELETE' }).catch(() => {});
    setTick((n) => n + 1);
  };
  const panel = open ? h('div', { class: 'webhook-panel', role: 'group', 'aria-label': 'App context' },
    h('div', { class: 'webhook-panel__section' },
      h('div', { class: 'webhook-panel__label' }, 'What extension views give the model'),
      h('div', { class: 'webhook-panel__hint' }, 'New or changed context goes with your next prompt, labelled as data from the view. Clearing it stops it from being sent again; the model keeps what it already received.'),
      entries.map((e) => h('div', { key: e.key, class: 'app-context__entry' },
        h('div', { class: 'app-context__head' },
          h('strong', null, e.title),
          h('span', { class: 'hook-chip' + (e.sent ? '' : ' hook-chip--warn') }, e.sent ? 'sent' : 'next prompt')),
        h('pre', { class: 'hooks-panel__code' }, [e.text, e.json ? 'data: ' + e.json : ''].filter(Boolean).join('\n')),
        h('div', { class: 'webhook-panel__row' },
          h('button', { class: 'run-dock__btn', type: 'button', onClick: () => clear(e.key) }, 'Clear')))),
      h('div', { class: 'webhook-panel__row' },
        h('button', { class: 'run-dock__btn run-dock__btn--danger', type: 'button', onClick: () => clear('') }, 'Clear all')))) : null;
  return h(Fragment, null, panel,
    h('div', { class: 'run-dock webhook-dock app-context-bar', role: 'group', 'aria-label': 'App context' },
      h('span', { class: 'webhook-dock__icon' }, h(PuzzleIcon, { size: 16 })),
      h('div', { class: 'run-dock__text' },
        h('div', { class: 'run-dock__goal' }, h('strong', null, 'App context'), ' · ', entries.map((e) => e.title).join(', ')),
        h('div', { class: 'run-dock__meta' }, pending ? pending + ' going with your next prompt' : 'sent; nothing new for the next prompt')),
      h('button', { class: 'run-dock__btn', type: 'button', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen((v) => !v) }, open ? 'Close' : 'View')));
}
