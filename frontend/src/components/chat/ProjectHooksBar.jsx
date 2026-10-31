// mouaif web — "this project defines hooks / extensions" banner
// (docs/features/hooks.md, docs/features/extensions.md)
//
// A bar in the bottom stack, above the composer, shown in a project's chats
// while the project defines hooks or extensions the user has not trusted (or
// that changed since): they are off until reviewed. "Review" opens the same
// review as Settings, with "Trust and turn on" per item. "Not now" hides the
// bar for what it shows now until the page reloads. Polled slowly: these
// rarely change.
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { ProjectHooksReview, useProjectHooks } from '../settings/ProjectHooksReview.jsx';
import { ExtensionSummary } from '../settings/ExtensionSummary.jsx';
import { HOOK_ICON_PATH } from './hookEvents.js';
import '../settings/hooks.css';

const POLL_MS = 30000;
const dismissed = new Set();

function useProjectExtensions(projectDir, refresh) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!projectDir) { setList([]); return undefined; }
    let stopped = false;
    fetchJson('/api/extensions?projectDir=' + encodeURIComponent(projectDir))
      .then((r) => { if (!stopped) setList(r.status === 200 && Array.isArray(r.body.project) ? r.body.project : []); }, () => {});
    return () => { stopped = true; };
  }, [projectDir, refresh]);
  return list;
}

function ExtensionReview({ ext, projectDir, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trust = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetchJson('/api/extensions/' + encodeURIComponent(ext.id) + '/trust', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, hash: ext.hash })
      });
      if (r.status !== 200) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
      onDone();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  return h('div', { class: 'hook-card project-hooks__ext' },
    h('div', { class: 'hook-card__title' }, 'Extension · ' + ext.name),
    h('div', { class: 'hook-card__meta' }, h('code', null, ext.file),
      h('span', { class: 'hook-chip hook-chip--warn' }, ext.changed ? 'changed since you trusted it' : 'not reviewed')),
    ext.description ? h('div', { class: 'hook-card__note' }, ext.description) : null,
    h(ExtensionSummary, { summary: ext.summary }),
    error ? h('p', { class: 'status', 'data-state': 'error', role: 'alert' }, error) : null,
    h('div', { class: 'settings-hooks__actions settings-hooks__actions--flush' },
      h('button', { type: 'button', class: 'btn btn--primary', disabled: busy, onClick: trust }, 'Trust and turn on')));
}

export function ProjectHooksBar({ projectDir }) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useProjectHooks(projectDir, tick);
  const exts = useProjectExtensions(projectDir, tick);
  const [open, setOpen] = useState(false);
  const [, setHidden] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') setTick((n) => n + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { setOpen(false); }, [projectDir]);

  const hooksPending = !!(state && state.hash && !state.trusted);
  const extPending = exts.filter((x) => !x.trusted && !x.error && x.summary);
  // Everything reviewed: close the panel.
  const nothing = !hooksPending && !extPending.length;
  useEffect(() => { if (nothing) setOpen(false); }, [nothing]);
  if (nothing) return null;
  const key = projectDir + '\n' + (hooksPending ? state.hash : '') + '\n' + extPending.map((x) => x.hash).join(',');
  if (dismissed.has(key) && !open) return null;

  const count = (hooksPending ? state.hooks.length : 0);
  const parts = [];
  if (hooksPending) parts.push(count + (count === 1 ? ' hook' : ' hooks'));
  if (extPending.length) parts.push(extPending.length + (extPending.length === 1 ? ' extension' : ' extensions'));
  const changed = (hooksPending && state.changed) || extPending.some((x) => x.changed);
  const refresh = () => setTick((n) => n + 1);

  const panel = open ? h('div', { class: 'webhook-panel hooks-panel', role: 'group', 'aria-label': 'Project hooks and extensions' },
    hooksPending ? h('div', { class: 'webhook-panel__section' },
      h('div', { class: 'webhook-panel__label' }, 'Hooks this project defines'),
      h(ProjectHooksReview, { projectDir, state, onState: (next) => { setState(next); refresh(); } })) : null,
    extPending.length ? h('div', { class: 'webhook-panel__section' },
      h('div', { class: 'webhook-panel__label' }, 'Extensions this project ships'),
      extPending.map((ext) => h(ExtensionReview, { key: ext.id, ext, projectDir, onDone: refresh }))) : null) : null;

  return h(Fragment, null, panel,
    h('div', { class: 'run-dock webhook-dock webhook-dock--paused project-hooks-bar', role: 'group', 'aria-label': 'Project hooks and extensions' },
      h('span', { class: 'webhook-dock__icon' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
          h('path', { d: HOOK_ICON_PATH }))),
      h('div', { class: 'run-dock__text' },
        h('div', { class: 'run-dock__goal' }, h('strong', null, 'Project ' + (hooksPending ? 'hooks' : 'extensions') + ' off'), ' · ', parts.join(', ')),
        h('div', { class: 'run-dock__meta' }, changed ? 'Something changed since you trusted it. Review before it runs.' : 'This project ships code that runs only after you review it.')),
      h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((v) => !v) }, open ? 'Close' : 'Review'),
      !open ? h('button', { class: 'run-dock__btn', type: 'button',
        onClick: () => { dismissed.add(key); setHidden((n) => n + 1); } }, 'Not now') : null));
}
