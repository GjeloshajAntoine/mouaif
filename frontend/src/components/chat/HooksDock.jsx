// mouaif web — the chat's own hooks (docs/features/hooks.md)
//
// A bar in the bottom stack, above the composer, shown while the chat has
// hooks of its own (src/chatHooks.js): "Hooks · 2". It opens a panel that
// lists each hook with its event, match and command or script verbatim, who
// added it (you or the model), Pause / Resume, Edit, All chats (make it an
// app hook) and Delete
// (both tap twice), a way to add another hook to this chat, and the latest
// hook runs in this chat. State comes from GET /api/chats/:id/hooks, polled
// while the page is visible and refreshed at once when the model's hook tools
// finish (CHAT_HOOKS_CHANGED). The hook editor is the Settings one, loaded on
// first use so the chat bundle does not carry it.
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { EVENT_LABELS, matchSummary, RunRow } from '../settings/hookText.js';
import { handlerText } from '../settings/ProjectHooksReview.jsx';
import '../settings/hooks.css';
import { CHAT_HOOKS_CHANGED, HOOK_ICON_PATH } from './hookEvents.js';

const POLL_OPEN_MS = 4000;
const POLL_SOME_MS = 10000;
const POLL_NONE_MS = 15000;
const CONFIRM_MS = 4000;
const BLANK = { id: '', name: '', event: 'tool.before', handler: { kind: 'command', command: '' } };

export function HookIcon({ size = 16 }) {
  return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  h('path', { d: HOOK_ICON_PATH }));
}


export function HooksDock({ projectDir, chatId }) {
  const [list, setList] = useState([]);
  const [runs, setRuns] = useState([]);
  const [hooksOn, setHooksOn] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [armed, setArmed] = useState('');
  const [editing, setEditing] = useState(null); // { id, hook, isNew }
  const [Editor, setEditor] = useState(null);
  const [refresh, setRefresh] = useState(0);

  const base = '/api/chats/' + encodeURIComponent(chatId) + '/hooks';
  const apply = useCallback((body) => {
    setList((body && Array.isArray(body.hooks)) ? body.hooks : []);
    setRuns((body && Array.isArray(body.runs)) ? body.runs : []);
    setHooksOn(!body || body.hooksOn !== false);
  }, []);

  useEffect(() => {
    setList([]); setRuns([]); setOpen(false); setError(''); setArmed(''); setEditing(null);
  }, [projectDir, chatId]);

  useEffect(() => {
    if (!projectDir || !chatId) return undefined;
    let stopped = false;
    let timer = null;
    let has = false;
    const load = async () => {
      try {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          const r = await fetchJson(base + '?projectDir=' + encodeURIComponent(projectDir));
          if (!stopped && r.status === 200) { apply(r.body); has = !!(r.body.hooks && r.body.hooks.length); }
        }
      } catch { /* offline: keep the last state */ }
      if (!stopped) timer = setTimeout(load, open ? POLL_OPEN_MS : has ? POLL_SOME_MS : POLL_NONE_MS);
    };
    load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [projectDir, chatId, open, refresh, base, apply]);

  // The model's hook_create / hook_delete just finished: reload now.
  useEffect(() => {
    const onChange = () => setRefresh((n) => n + 1);
    window.addEventListener(CHAT_HOOKS_CHANGED, onChange);
    return () => window.removeEventListener(CHAT_HOOKS_CHANGED, onChange);
  }, []);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(''), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // The Settings hook editor, loaded the first time it is needed.
  useEffect(() => {
    if (!editing || Editor) return;
    import('../SettingsHooks.jsx').then((m) => setEditor(() => m.HookEditor), () => setError('Could not load the hook editor'));
  }, [editing, Editor]);

  if (!list.length) return null;

  const call = async (method, path, payload) => {
    const url = base + path + (method === 'DELETE' ? '?projectDir=' + encodeURIComponent(projectDir) : '');
    const r = method === 'DELETE'
      ? await fetchJson(url, { method })
      : await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, ...payload }) });
    if (r.status !== 200) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
    return r.body;
  };
  const act = async (method, path, payload) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await call(method, path, payload); setRefresh((n) => n + 1); }
    catch (e) { setError(e.message || 'Could not update the hook'); }
    setBusy(false); setArmed('');
  };
  const twoTap = (what, action) => () => { if (armed !== what) { setArmed(what); return; } action(); };
  const hookPath = (id) => '/' + encodeURIComponent(id);
  // HookEditor shows the error a save throws.
  const saveEdit = async (hook) => {
    if (editing.isNew) await call('POST', '', { entry: hook });
    else await call('PUT', hookPath(editing.id), { entry: hook });
    setEditing(null);
    setRefresh((n) => n + 1);
  };

  const paused = list.filter((x) => x.status === 'paused').length;
  const names = list.map((x) => x.hook.name || x.hook.id).join(', ');

  const editor = (key, initial, isNew, id) => (Editor
    ? h(Editor, { key, initial, isNew, projectDir, onSave: saveEdit, onCancel: () => setEditing(null),
      onDelete: () => { setEditing(null); act('DELETE', hookPath(id)); } })
    : h('div', { class: 'webhook-panel__hint' }, 'Loading the editor…'));

  const items = h('ul', { class: 'hook-list hooks-panel__list' }, list.map((x) => {
    const hook = x.hook;
    const id = hook.id;
    const isPaused = x.status === 'paused';
    return h('li', { key: id, class: 'hook-card' + (isPaused ? ' hook-card--off' : '') },
      h('div', { class: 'hook-card__main' },
        h('div', { class: 'hook-card__title' }, hook.name || id),
        h('div', { class: 'hook-card__meta' },
          h('span', { class: 'hook-chip' }, EVENT_LABELS[hook.event] || hook.event),
          h('span', null, matchSummary(hook)),
          isPaused ? h('span', { class: 'hook-chip hook-chip--warn' }, 'paused') : null,
          hook.failClosed ? h('span', { class: 'hook-chip hook-chip--warn' }, 'blocks on failure') : null,
          h('span', { class: 'hook-chip' }, x.createdBy === 'model' ? 'added by the model' : 'added by you')),
        hook.note ? h('div', { class: 'hook-card__note' }, hook.note) : null,
        h('pre', { class: 'hooks-panel__code' }, handlerText(hook))),
      editing && !editing.isNew && editing.id === id
        ? editor('edit-' + id, hook, false, id)
        : h('div', { class: 'webhook-panel__row' },
          h('button', { class: 'run-dock__btn' + (isPaused ? ' run-dock__btn--primary' : ''), type: 'button', disabled: busy,
            onClick: () => act('PUT', hookPath(id), { status: isPaused ? 'active' : 'paused' }) }, isPaused ? 'Resume' : 'Pause'),
          h('button', { class: 'run-dock__btn', type: 'button', disabled: busy, onClick: () => setEditing({ id, hook, isNew: false }) }, 'Edit'),
          h('button', { class: 'run-dock__btn' + (armed === 'promote-' + id ? ' run-dock__btn--primary is-armed' : ''), type: 'button', disabled: busy,
            onClick: twoTap('promote-' + id, () => act('POST', hookPath(id) + '/promote', { scope: 'app' })),
            'aria-label': armed === 'promote-' + id ? 'Tap again: this hook will run in every chat' : 'Make this hook app-wide' },
          armed === 'promote-' + id ? 'Tap: all chats' : 'All chats'),
          h('button', { class: 'run-dock__btn' + (armed === 'project-' + id ? ' run-dock__btn--primary is-armed' : ''), type: 'button', disabled: busy,
            onClick: twoTap('project-' + id, () => act('POST', hookPath(id) + '/promote', { scope: 'project' })),
            'aria-label': armed === 'project-' + id ? 'Tap again: this hook will run in every chat of this project' : 'Move this hook to the project' },
          armed === 'project-' + id ? 'Tap: project' : 'Project'),
          h('button', { class: 'run-dock__btn run-dock__btn--danger' + (armed === 'delete-' + id ? ' is-armed' : ''), type: 'button', disabled: busy,
            onClick: twoTap('delete-' + id, () => act('DELETE', hookPath(id))),
            'aria-label': armed === 'delete-' + id ? 'Tap again to delete the hook' : 'Delete the hook' },
          armed === 'delete-' + id ? 'Tap to delete' : 'Delete')));
  }));

  const panel = open ? h('div', { class: 'webhook-panel hooks-panel', role: 'group', 'aria-label': 'This chat’s hooks' },
    h('div', { class: 'webhook-panel__section' },
      h('div', { class: 'webhook-panel__label' }, 'Hooks in this chat'),
      h('div', { class: 'webhook-panel__hint' }, 'They run after the app’s hooks (Settings → Hooks), only in this chat.'),
      !hooksOn ? h('div', { class: 'webhook-panel__hint webhook-panel__hint--error' }, 'Hooks are paused app-wide in Settings → Hooks; none run.') : null,
      items,
      editing && editing.isNew
        ? h('div', { class: 'hook-card hook-card--new' }, h('div', { class: 'hook-card__title' }, 'New hook for this chat'), editor('new', BLANK, true, ''))
        : h('div', { class: 'webhook-panel__row' },
          h('button', { class: 'run-dock__btn', type: 'button', disabled: busy, onClick: () => setEditing({ id: '', hook: BLANK, isNew: true }) }, 'New hook for this chat')),
      error ? h('div', { class: 'webhook-panel__hint webhook-panel__hint--error', role: 'alert' }, error) : null),
    h('div', { class: 'webhook-panel__section' },
      h('div', { class: 'webhook-panel__label' }, 'Recent runs in this chat'),
      runs.length ? h('ul', { class: 'hook-runs hooks-panel__runs' }, runs.map((run) => h(RunRow, { key: run.id, run })))
        : h('div', { class: 'webhook-panel__hint' }, 'No hook has run in this chat yet.'))) : null;

  return h(Fragment, null, panel,
    h('div', { class: 'run-dock webhook-dock hooks-dock' + (paused === list.length ? ' webhook-dock--paused' : ''), role: 'group', 'aria-label': 'Hooks' },
      h('span', { class: 'webhook-dock__icon' }, h(HookIcon, { size: 16 })),
      h('div', { class: 'run-dock__text' },
        h('div', { class: 'run-dock__goal' }, h('strong', null, 'Hooks'), ' · ', list.length + ' in this chat' + (paused ? ' · ' + paused + ' paused' : '')),
        h('div', { class: 'run-dock__meta', title: names }, names)),
      h('button', { class: 'run-dock__btn', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        onClick: () => { setOpen((v) => !v); setRefresh((n) => n + 1); }, 'aria-label': 'Show this chat’s hooks' }, open ? 'Close' : 'Show')));
}
