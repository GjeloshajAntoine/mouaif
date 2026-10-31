// mouaif web — Settings → Extensions (docs/features/extensions.md)
//
// One `.mouaif-extension.json` file installs an extension: hooks, a UI and
// optionally the MCP server behind both. Import shows the permission screen
// and leaves the extension off until "Turn on". Each app extension has an
// on/off switch, "Off in this project", Export (the same file back) and
// Delete. The active project's own extensions (.mouaif/extensions/) are
// listed with their review state: they run only once trusted.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { ExtensionSummary } from './settings/ExtensionSummary.jsx';
import './settings/hooks.css';

async function api(method, url, body) {
  const r = await fetchJson(url, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (r.status !== 200) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
  return r.body;
}

function Switch({ id, checked, onChange, label, disabled }) {
  return h('label', { class: 'switch', title: label },
    h('input', { id, type: 'checkbox', role: 'switch', 'aria-checked': String(checked), 'aria-label': label, checked, disabled, onChange: (e) => onChange(e.currentTarget.checked) }),
    h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' })));
}

function AppExtension({ ext, projectDir, onChanged, setStatus }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); setStatus({ text: ok, kind: 'ok' }); onChanged(); }
    catch (e) { setStatus({ text: e.message, kind: 'error' }); }
    setBusy(false);
  };
  return h('li', { class: 'hook-card' + (ext.enabled ? '' : ' hook-card--off') },
    h('div', { class: 'hook-card__row' },
      h('div', { class: 'hook-card__main' },
        h('div', { class: 'hook-card__title' }, ext.name, ext.version ? h('span', { class: 'ext-card__version' }, ' ' + ext.version) : null),
        h('div', { class: 'hook-card__meta' },
          h('code', null, ext.id),
          ext.enabled ? h('span', { class: 'hook-chip' }, 'on') : h('span', { class: 'hook-chip hook-chip--warn' }, 'off'),
          ext.offInProject ? h('span', { class: 'hook-chip hook-chip--warn' }, 'off in this project') : null,
          ext.error ? h('span', { class: 'hook-chip hook-chip--bad' }, 'invalid') : null),
        ext.description ? h('div', { class: 'hook-card__note' }, ext.description) : null,
        ext.error ? h('div', { class: 'hook-run__detail hook-run__detail--error' }, ext.error) : null),
      h(Switch, { id: 'ext-on-' + ext.id, label: (ext.enabled ? 'Turn off ' : 'Turn on ') + ext.name, checked: ext.enabled, disabled: busy || !!ext.error,
        onChange: (on) => run(() => api('PUT', '/api/extensions/' + ext.id, { enabled: on }), on ? ext.name + ' is on' : ext.name + ' is off') })),
    open ? h(ExtensionSummary, { summary: ext.summary }) : null,
    h('div', { class: 'hook-card__actions' },
      h('button', { type: 'button', class: 'btn', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen((v) => !v) }, open ? 'Hide details' : 'Details'),
      projectDir ? h('button', { type: 'button', class: 'btn', disabled: busy,
        onClick: () => run(() => api('PUT', '/api/extensions/' + ext.id, { projectDir, offInProject: !ext.offInProject }),
          ext.offInProject ? 'On again in this project' : 'Off in this project') }, ext.offInProject ? 'On in this project' : 'Off in this project') : null,
      h('a', { class: 'btn', href: '/api/extensions/' + encodeURIComponent(ext.id) + '/export', download: ext.id + '.mouaif-extension.json' }, 'Export'),
      h('button', { type: 'button', class: 'btn btn--danger', disabled: busy,
        onClick: () => { if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return; } run(() => api('DELETE', '/api/extensions/' + ext.id), ext.name + ' deleted'); } },
      armed ? 'Tap again to delete' : 'Delete')));
}

function ProjectExtension({ ext, projectDir, onChanged, setStatus }) {
  const [open, setOpen] = useState(!ext.trusted);
  const [busy, setBusy] = useState(false);
  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); setStatus({ text: ok, kind: 'ok' }); onChanged(); }
    catch (e) { setStatus({ text: e.message, kind: 'error' }); }
    setBusy(false);
  };
  return h('li', { class: 'hook-card' + (ext.trusted ? '' : ' hook-card--off') },
    h('div', { class: 'hook-card__title' }, ext.name, ext.version ? h('span', { class: 'ext-card__version' }, ' ' + ext.version) : null),
    h('div', { class: 'hook-card__meta' },
      h('code', null, ext.file),
      ext.error ? h('span', { class: 'hook-chip hook-chip--bad' }, 'invalid')
        : ext.trusted ? h('span', { class: 'hook-chip' }, 'on · trusted')
          : h('span', { class: 'hook-chip hook-chip--warn' }, ext.changed ? 'off · changed since you trusted it' : 'off · not reviewed')),
    ext.description ? h('div', { class: 'hook-card__note' }, ext.description) : null,
    ext.error ? h('div', { class: 'hook-run__detail hook-run__detail--error' }, ext.error) : null,
    open && ext.summary ? h(ExtensionSummary, { summary: ext.summary }) : null,
    open && ext.files && ext.files.length ? h('p', { class: 'hint hint--compact' }, 'Its hooks run these project files: ', ext.files.join(', '), '. Changing them turns it off again.') : null,
    h('div', { class: 'hook-card__actions' },
      ext.summary ? h('button', { type: 'button', class: 'btn', onClick: () => setOpen((v) => !v) }, open ? 'Hide details' : 'Details') : null,
      ext.error ? null : ext.trusted
        ? h('button', { type: 'button', class: 'btn', disabled: busy,
          onClick: () => run(() => api('DELETE', '/api/extensions/' + ext.id + '/trust?projectDir=' + encodeURIComponent(projectDir)), ext.name + ' is off') }, 'Turn off')
        : h('button', { type: 'button', class: 'btn btn--primary', disabled: busy,
          onClick: () => run(() => api('POST', '/api/extensions/' + ext.id + '/trust', { projectDir, hash: ext.hash }), ext.name + ' is on') }, 'Trust and turn on')));
}

export function SettingsExtensionsView() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [pending, setPending] = useState(null); // { extension, summary } just imported
  const [refresh, setRefresh] = useState(0);
  const fileRef = useRef(null);
  const projectDir = (activeProject.value && activeProject.value.dir) || '';

  useEffect(() => {
    api('GET', '/api/extensions' + (projectDir ? '?projectDir=' + encodeURIComponent(projectDir) : ''))
      .then(setData, (e) => setStatus({ text: 'Could not load extensions: ' + e.message, kind: 'error' }));
  }, [projectDir, refresh]);

  const reload = () => setRefresh((n) => n + 1);

  async function onFile(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) { setStatus({ text: 'An extension file is at most 1 MiB', kind: 'error' }); return; }
    let manifest;
    try { manifest = JSON.parse(await file.text()); }
    catch (err) { setStatus({ text: 'Not a JSON file: ' + err.message, kind: 'error' }); return; }
    try {
      const out = await api('POST', '/api/extensions', { manifest });
      setPending(out);
      setStatus({ text: (out.replaced ? 'Replaced ' : 'Imported ') + out.extension.name + '. It stays off until you turn it on.', kind: 'ok' });
      reload();
    } catch (err) { setStatus({ text: err.message, kind: 'error' }); }
  }

  async function decide(on) {
    const ext = pending.extension;
    try {
      if (on) await api('PUT', '/api/extensions/' + ext.id, { enabled: true });
      else await api('DELETE', '/api/extensions/' + ext.id);
      setStatus({ text: on ? ext.name + ' is on' : ext.name + ' removed', kind: 'ok' });
    } catch (e) { setStatus({ text: e.message, kind: 'error' }); }
    setPending(null);
    reload();
  }

  const app = data ? data.app : [];
  const project = data ? data.project : [];

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Extensions')),
    h('section', { class: 'settings-hooks' },
      h('p', { class: 'hint settings-hooks__intro' },
        'An extension is one .mouaif-extension.json file. It can add hooks, a small UI in the chat or in Settings, and the MCP server behind them. Its UI runs sandboxed and can only do what you allow here. Its hooks and server run on this computer with your permissions.'),

      pending ? h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Turn on ' + pending.extension.name + '?'),
        h('div', { class: 'hook-card hook-card--new' },
          pending.extension.description ? h('p', { class: 'hook-card__note' }, pending.extension.description) : null,
          h(ExtensionSummary, { summary: pending.summary }),
          h('div', { class: 'hook-edit__bar' },
            h('button', { type: 'button', class: 'btn btn--primary', onClick: () => decide(true) }, 'Turn on'),
            h('button', { type: 'button', class: 'btn', onClick: () => setPending(null) }, 'Not now'),
            h('button', { type: 'button', class: 'btn btn--danger', onClick: () => decide(false) }, 'Remove')))) : null,

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Installed', h('span', { class: 'group__title-note' }, 'every project')),
        !data ? h('p', { class: 'hint hint--compact' }, 'Loading…') : null,
        data && !app.length ? h('p', { class: 'hint hint--compact' }, 'No extensions yet.') : null,
        app.length ? h('ul', { class: 'hook-list' }, app.map((ext) => h(AppExtension, { key: ext.id, ext, projectDir, onChanged: reload, setStatus }))) : null,
        h('div', { class: 'settings-hooks__actions' },
          h('button', { type: 'button', class: 'btn btn--primary', onClick: () => fileRef.current && fileRef.current.click() }, 'Import file'),
          h('input', { ref: fileRef, type: 'file', accept: '.json,application/json', hidden: true, onChange: onFile }))),

      projectDir ? h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'This project', h('span', { class: 'group__title-note' }, '.mouaif/extensions/')),
        data && !project.length ? h('p', { class: 'hint hint--compact' }, 'This project ships no extensions. A repository adds them as .mouaif/extensions/<id>.mouaif-extension.json; they stay off until reviewed here.') : null,
        project.length ? h('ul', { class: 'hook-list' }, project.map((ext) => h(ProjectExtension, { key: ext.id, ext, projectDir, onChanged: reload, setStatus }))) : null) : null,

      h('p', { class: 'status', 'data-state': status.kind, 'aria-live': 'polite' }, status.text)));
}
