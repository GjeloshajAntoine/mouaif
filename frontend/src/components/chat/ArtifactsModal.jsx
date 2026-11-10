// mouaif web — a chat's artifacts (docs/features/chat-artifacts.md)
//
// The sheet behind File tools → Artifacts: the files kept with this chat, what
// the agent saved and what the user added. A list, then one artifact at a time:
// open it in the Files editor, tag it in the message, open it as an app, download,
// rename or delete it. Nothing here reloads an app itself: telling the page an
// artifact changed is enough for a mounted app that links it to check its data.
import { h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { ARTIFACTS_CHANGED, COMPOSER_INSERT } from './extensionEvents.js';
import './artifacts.css';

const ICONS = { image: '\u{1F5BC}️', text: '\u{1F4C4}', binary: '\u{1F4E6}', app: '\u{1F9E9}' };

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function metaLine(artifact) {
  const by = artifact.createdBy === 'agent' ? 'from the agent' : artifact.createdBy === 'user' ? 'from you' : '';
  return [formatSize(artifact.size), formatWhen(artifact.updatedAt), by].filter(Boolean).join(' · ');
}

export function ArtifactsModal({ projectDir, chatId, initialName, onClose, onOpenInEditor }) {
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
  const [artifacts, setArtifacts] = useState(null);
  // 'list', 'new', or the name of the artifact being shown.
  const [view, setView] = useState(initialName || 'list');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef(null);

  const base = '/api/chats/' + encodeURIComponent(chatId) + '/artifacts';
  const query = '?projectDir=' + encodeURIComponent(projectDir);
  const urlFor = useCallback(name => base + '/' + encodeURIComponent(name) + query, [base, query]);

  const reload = useCallback(async () => {
    const response = await fetchJson(base + query);
    if (response.status !== 200) throw new Error(response.body?.error || 'Could not load artifacts');
    setArtifacts(response.body.artifacts);
    return response.body.artifacts;
  }, [base, query]);

  useEffect(() => {
    reload().catch(e => setError(e.message));
    // The agent can save one while this sheet is open.
    const onChanged = () => { reload().catch(() => {}); };
    window.addEventListener(ARTIFACTS_CHANGED, onChanged);
    return () => window.removeEventListener(ARTIFACTS_CHANGED, onChanged);
  }, [reload]);

  // Reports a change and refreshes the list; throws so a form keeps its input.
  const changed = useCallback(async () => {
    window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: { projectDir, chatId } }));
    await reload();
  }, [projectDir, chatId, reload]);

  const run = useCallback(async (work) => {
    setBusy(true);
    setError('');
    try { return await work(); }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  }, []);

  const put = useCallback(async (name, body) => {
    const response = await fetchJson(urlFor(name), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });
    if (response.status !== 200) throw new Error(response.body?.error || 'Could not save ' + name);
    return response.body.artifact;
  }, [urlFor]);

  function onUpload(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    run(async () => {
      let last = null;
      for (const file of files) last = await put(file.name, file);
      await changed();
      if (files.length === 1 && last) setView(last.name);
    });
  }

  const current = artifacts && view !== 'list' && view !== 'new' ? artifacts.find(item => item.name === view) : null;
  const title = view === 'new' ? 'New artifact' : current ? current.name : 'Artifacts';
  return h('div', {
    class: 'artifacts__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Artifacts of this chat',
    onClick: e => { if (e.target === e.currentTarget && onClose) onClose(); }
  },
  h('div', { class: 'artifacts', ref: sheetRef },
    h('header', { class: 'artifacts__head' },
      view !== 'list' ? h('button', { type: 'button', class: 'btn artifacts__back', onClick: () => { setError(''); setView('list'); }, 'aria-label': 'Back to all artifacts' }, '‹') : null,
      h('strong', { class: 'artifacts__title' }, title),
      h('button', { type: 'button', class: 'btn artifacts__close', onClick: onClose, 'aria-label': 'Close artifacts' }, 'Close')),
    error ? h('p', { class: 'artifacts__error', role: 'alert' }, error) : null,
    view === 'list' ? h(ArtifactList, {
      artifacts, busy,
      onPick: setView,
      onNew: () => { setError(''); setView('new'); },
      onUpload: () => uploadRef.current && uploadRef.current.click()
    }) : null,
    view === 'new' ? h(NewArtifact, {
      busy,
      onCreate: name => run(async () => {
        const made = await put(name, '');
        await changed();
        if (made.kind === 'binary') setView(made.name);
        else onOpenInEditor(made.link);
      })
    }) : null,
    current ? h(ArtifactDetail, { key: current.name, artifact: current, url: urlFor(current.name), busy, run, changed, setView, projectDir, chatId, onClose, onOpenInEditor }) : null,
    artifacts && view !== 'list' && view !== 'new' && !current
      ? h('p', { class: 'artifacts__empty' }, 'This artifact is no longer in this chat.')
      : null,
    h('input', { ref: uploadRef, class: 'artifacts__file', type: 'file', multiple: true, onChange: onUpload, 'aria-hidden': 'true', tabindex: -1 })));
}

function ArtifactList({ artifacts, busy, onPick, onNew, onUpload }) {
  return h('div', { class: 'artifacts__body' },
    h('div', { class: 'artifacts__actions artifacts__actions--two' },
      h('button', { type: 'button', class: 'btn btn--primary', disabled: busy, onClick: onUpload }, 'Upload files'),
      h('button', { type: 'button', class: 'btn', disabled: busy, onClick: onNew }, 'New text')),
    artifacts === null ? h('p', { class: 'artifacts__empty', role: 'status' }, 'Loading…') : null,
    artifacts && !artifacts.length
      ? h('p', { class: 'artifacts__empty' }, 'Nothing here yet. Add a file, or ask the agent to save one. Type @ in the message box to use an artifact.')
      : null,
    artifacts && artifacts.length ? h('ul', { class: 'artifacts__list' },
      artifacts.map(item => h('li', { key: item.name },
        h('button', { type: 'button', class: 'artifacts__row', onClick: () => onPick(item.name) },
          h('span', { class: 'artifacts__icon', 'aria-hidden': 'true' }, item.app ? ICONS.app : ICONS[item.kind]),
          h('span', { class: 'artifacts__rowtext' },
            h('span', { class: 'artifacts__name' }, item.name),
            item.description ? h('span', { class: 'artifacts__desc' }, item.description) : null,
            h('span', { class: 'artifacts__meta' }, metaLine(item))))))) : null);
}

function NewArtifact({ busy, onCreate }) {
  const [name, setName] = useState('');
  return h('form', { class: 'artifacts__body', onSubmit: e => { e.preventDefault(); onCreate(name); } },
    h('label', { class: 'artifacts__label' }, 'File name',
      h('input', { class: 'input', value: name, placeholder: 'notes.md', autocapitalize: 'off', spellcheck: false, onInput: e => setName(e.target.value) })),
    h('div', { class: 'artifacts__actions' },
      h('button', { type: 'submit', class: 'btn btn--primary', disabled: busy || !name.trim() }, 'Create and edit')));
}

function ArtifactDetail({ artifact, url, busy, run, changed, setView, projectDir, chatId, onClose, onOpenInEditor }) {
  const [mode, setMode] = useState('view'); // view | rename | delete
  const [nextName, setNextName] = useState(artifact.name);
  const [description, setDescription] = useState(artifact.description);
  const detailsChanged = description !== artifact.description;

  function insertMention() {
    window.dispatchEvent(new CustomEvent(COMPOSER_INSERT, { detail: { projectDir, chatId, text: '@' + artifact.link + ' ' } }));
    onClose();
  }

  const patch = body => run(async () => {
    const response = await fetchJson(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.status !== 200) throw new Error(response.body?.error || 'Could not save');
    await changed();
    return response.body.artifact;
  });

  return h('div', { class: 'artifacts__body' },
    h('p', { class: 'artifacts__meta' }, artifact.mimeType + ' · ' + metaLine(artifact)),
    artifact.kind === 'image'
      ? h('img', { class: 'artifacts__image', src: url + '&inline=1&v=' + encodeURIComponent(artifact.updatedAt), alt: artifact.description || artifact.name })
      : null,
    artifact.kind === 'binary' ? h('p', { class: 'artifacts__empty' }, 'No preview for this file. Download it to open it.') : null,
    h('label', { class: 'artifacts__label' }, 'Description',
      h('input', { class: 'input', value: description, maxlength: 500, placeholder: 'What this is', onInput: e => setDescription(e.target.value) })),
    detailsChanged ? h('div', { class: 'artifacts__actions' },
      h('button', { type: 'button', class: 'btn', disabled: busy, onClick: () => patch({ description }) }, 'Save description')) : null,
    mode === 'view' ? h('div', { class: 'artifacts__actions artifacts__actions--two' },
      artifact.kind !== 'binary' ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => onOpenInEditor(artifact.link) }, artifact.kind === 'text' ? 'Open in editor' : 'Open') : null,
      h('button', { type: 'button', class: 'btn', onClick: insertMention }, 'Use in message'),
      artifact.app ? h('button', { type: 'button', class: 'btn', disabled: busy, onClick: () => run(async () => {
        const response = await fetchJson(url.replace('?', '/open?'), { method: 'POST' });
        if (response.status !== 200) throw new Error(response.body?.error || 'Could not open the app');
        onClose();
      }) }, 'Open as app') : null,
      h('a', { class: 'btn artifacts__link', href: url, download: artifact.name }, 'Download'),
      h('button', { type: 'button', class: 'btn', onClick: () => { setNextName(artifact.name); setMode('rename'); } }, 'Rename'),
      h('button', { type: 'button', class: 'btn btn--danger', onClick: () => setMode('delete') }, 'Delete')) : null,
    mode === 'rename' ? h('form', { class: 'artifacts__confirm', onSubmit: async e => {
      e.preventDefault();
      const renamed = await patch({ name: nextName });
      if (renamed) setView(renamed.name);
    } },
      h('label', { class: 'artifacts__label' }, 'New name',
        h('input', { class: 'input', value: nextName, autocapitalize: 'off', spellcheck: false, onInput: e => setNextName(e.target.value) })),
      h('div', { class: 'artifacts__actions artifacts__actions--two' },
        h('button', { type: 'button', class: 'btn', onClick: () => setMode('view') }, 'Keep name'),
        h('button', { type: 'submit', class: 'btn btn--primary', disabled: busy || !nextName.trim() }, 'Rename'))) : null,
    mode === 'delete' ? h('div', { class: 'artifacts__confirm', role: 'alertdialog', 'aria-label': 'Delete ' + artifact.name },
      h('p', null, 'Delete ' + artifact.name + '? Apps that link it stop working until it is back.'),
      h('div', { class: 'artifacts__actions artifacts__actions--two' },
        h('button', { type: 'button', class: 'btn', onClick: () => setMode('view') }, 'Keep'),
        h('button', { type: 'button', class: 'btn btn--danger', disabled: busy, onClick: () => run(async () => {
          const response = await fetchJson(url, { method: 'DELETE' });
          if (response.status !== 200) throw new Error(response.body?.error || 'Could not delete');
          setView('list');
          await changed();
        }) }, 'Delete'))) : null);
}
