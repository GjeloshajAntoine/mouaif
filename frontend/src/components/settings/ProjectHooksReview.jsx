// mouaif web — review a project's hooks (docs/features/hooks.md)
//
// Project hooks (`hooks` in .mouaif.json) stay off until the user trusts
// their content hash (src/projectHooks.js). This lists every hook verbatim —
// command, script, URL or module source — plus the project files a command
// runs, and offers "Trust and turn on" (for exactly the hash shown) or
// "Turn off". Used by Settings → Hooks and by the banner in a project's chats.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { EVENT_LABELS, matchSummary } from './hookText.js';

export function handlerText(hook) {
  const handler = hook.handler || {};
  if (handler.kind === 'http') return 'POST ' + handler.url + (handler.send ? '\nsends: ' + handler.send.join(', ') : '') + (handler.secret ? '\nsigned with a secret' : '');
  if (handler.kind === 'module') return handler.source || '';
  return handler.command ? handler.command : '# ' + handler.shell + '\n' + (handler.script || '');
}

export function useProjectHooks(projectDir, refresh = 0) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!projectDir) { setState(null); return undefined; }
    let stopped = false;
    fetchJson('/api/hooks/project?projectDir=' + encodeURIComponent(projectDir))
      .then((r) => { if (!stopped) setState(r.status === 200 ? r.body : null); }, () => { if (!stopped) setState(null); });
    return () => { stopped = true; };
  }, [projectDir, refresh]);
  return [state, setState];
}

export function trustLabel(st) {
  if (!st || !st.hash) return '';
  if (st.trusted) return 'On · trusted';
  return st.changed ? 'Off · changed since you trusted it' : 'Off · not reviewed';
}

export function ProjectHooksReview({ projectDir, state, onState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!state) return null;
  if (!state.hash) return h('p', { class: 'hint hint--compact' }, 'This project defines no hooks. A project adds them under "hooks" in its .mouaif.json; they stay off until reviewed here.');

  const send = async (method, url, body) => {
    setBusy(true); setError('');
    try {
      const r = await fetchJson(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status !== 200) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
      onState(r.body);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return h('div', { class: 'project-hooks' },
    h('div', { class: 'project-hooks__status', 'data-trusted': state.trusted ? '1' : '0' }, trustLabel(state)),
    !state.trusted ? h('p', { class: 'hint hint--compact' },
      'These run on this computer with your permissions in every chat of this project. Read each one before turning them on. Any later change to this list or to a script it runs turns them off again.') : null,
    h('ul', { class: 'hook-list project-hooks__list' }, state.hooks.map((hook) => h('li', { key: hook.id, class: 'hook-card' + (hook.enabled ? '' : ' hook-card--off') },
      h('div', { class: 'hook-card__title' }, hook.name || hook.id),
      h('div', { class: 'hook-card__meta' },
        h('span', { class: 'hook-chip' }, EVENT_LABELS[hook.event] || hook.event),
        h('span', null, matchSummary(hook)),
        hook.handler.kind === 'http' ? h('span', { class: 'hook-chip hook-chip--warn' }, 'sends data to a URL') : null,
        hook.createdBy === 'model' ? h('span', { class: 'hook-chip' }, 'added by the model') : null,
        hook.enabled ? null : h('span', { class: 'hook-chip hook-chip--warn' }, 'switched off in the file')),
      hook.note ? h('div', { class: 'hook-card__note' }, hook.note) : null,
      h('pre', { class: 'hooks-panel__code' }, handlerText(hook))))),
    state.errors && state.errors.length ? h('div', { class: 'project-hooks__errors', role: 'alert' },
      state.errors.map((e) => h('div', { key: e.index }, 'Entry ' + (e.index + 1) + ' is ignored: ' + e.error))) : null,
    state.files && state.files.length ? h('div', { class: 'project-hooks__files' },
      h('div', { class: 'webhook-panel__label' }, 'Project files these hooks run'),
      state.files.map((f) => h('details', { key: f.path, class: 'project-hooks__file' },
        h('summary', null, f.path + (f.missing ? ' (missing)' : ' · ' + f.bytes + ' bytes')),
        f.missing ? null : h('pre', { class: 'hooks-panel__code' }, f.text + (f.truncated ? '\n… (first 8 KB shown)' : ''))))) : null,
    error ? h('p', { class: 'status', 'data-state': 'error', role: 'alert' }, error) : null,
    h('div', { class: 'settings-hooks__actions settings-hooks__actions--flush' },
      state.trusted
        ? h('button', { type: 'button', class: 'btn', disabled: busy,
          onClick: () => send('DELETE', '/api/hooks/project/trust?projectDir=' + encodeURIComponent(projectDir)) }, 'Turn off')
        : h('button', { type: 'button', class: 'btn btn--primary', disabled: busy || !state.hooks.length,
          onClick: () => send('POST', '/api/hooks/project/trust', { projectDir, hash: state.hash }) }, 'Trust and turn on')));
}
