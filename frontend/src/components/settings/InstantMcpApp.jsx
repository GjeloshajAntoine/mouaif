import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, setActiveProject } from '../../api.js';
import { nav } from '../../router.js';
import './instantMcpApp.css';

const MAX_SOURCE_BYTES = 512 * 1024;

export function InstantMcpApp({ projectDir, onImported }) {
  const [mode, setMode] = useState('request');
  const [name, setName] = useState('');
  const [request, setRequest] = useState('');
  const [path, setPath] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      const body = { projectDir, name: name.trim() || 'On-the-fly app' };
      if (mode === 'request') body.request = request;
      else if (file) {
        if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose a file of at most 512 KiB');
        body.filename = file.name;
        body.source = await file.text();
      } else body.path = path.trim();
      const result = await fetchJson('/api/mcp/apps/' + (mode === 'request' ? 'request' : 'import'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!mounted.current) return;
      if (result.status !== 201) throw new Error(result.body?.error || 'HTTP ' + result.status);
      if (mode === 'request') {
        setActiveProject(projectDir, '');
        nav('chat/' + encodeURIComponent(result.body.chatId));
      } else {
        setStatus('Added. Start the server, then ask a chat to open its view tool.');
        onImported();
      }
    } catch (error) {
      if (mounted.current) setStatus(error.message || 'Could not create app');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const id = 'instant-mcp-app';
  return h('form', { class: 'group instant-mcp-app', onSubmit: submit, 'aria-label': 'On-the-fly MCP app' },
    h('h3', { class: 'group__title' }, 'On-the-fly app'),
    h('p', { class: 'hint' }, 'Build from a request in a separate development chat, or import one HTML/browser-JS file. No server project or install needed.'),
    h('label', { class: 'label', for: id + '-mode' }, 'Create from'),
    h('select', { class: 'input', id: id + '-mode', value: mode, disabled: busy, onChange: event => { setMode(event.target.value); setStatus(''); } },
      h('option', { value: 'request' }, 'Request'), h('option', { value: 'file' }, 'Single HTML / JS file')),
    h('label', { class: 'label', for: id + '-name' }, 'App name'),
    h('input', { class: 'input', id: id + '-name', value: name, maxLength: 100, disabled: busy, placeholder: 'My app', onInput: event => setName(event.target.value) }),
    mode === 'request'
      ? h('div', null,
          h('label', { class: 'label', for: id + '-request' }, 'What should the app do?'),
          h('textarea', { class: 'input', id: id + '-request', value: request, required: true, rows: 4, maxLength: 16000, disabled: busy,
            placeholder: 'A tap-friendly project checklist…', onInput: event => setRequest(event.target.value) }),
          h('p', { class: 'hint' }, 'Opens a draft for review. Choose a model and send it when ready; import the generated file afterward.'))
      : h('div', null,
          h('label', { class: 'label', for: id + '-file' }, 'Upload a file (512 KiB max)'),
          h('input', { class: 'input', id: id + '-file', type: 'file', accept: '.html,.htm,.js,.mjs', disabled: busy,
            onChange: event => setFile(event.target.files?.[0] || null) }),
          h('label', { class: 'label', for: id + '-path' }, 'Or project-relative file path'),
          h('input', { class: 'input', id: id + '-path', value: path, disabled: busy || !!file, required: !file,
            placeholder: 'apps/checklist.html', onInput: event => setPath(event.target.value) }),
          h('p', { class: 'hint' }, 'Browser code runs only in the sandbox. Node scripts, external imports and network access are not supported.')),
    h('button', { class: 'btn', type: 'submit', disabled: busy }, busy ? 'Creating…' : mode === 'request' ? 'Open development chat' : 'Add app'),
    status ? h('p', { role: 'status', class: 'hint instant-mcp-app__status' }, status) : null);
}
