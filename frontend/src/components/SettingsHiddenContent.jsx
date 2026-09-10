import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { nav } from '../router.js';
import { AgentFilePicker } from './AgentFilePicker.jsx';
import { HiddenContentEditor } from './settings/HiddenContentEditor.jsx';
import { describeHidden, hiddenContentPath } from './settings/hiddenRanges.js';
import './settings/hiddenContent.css';

export function SettingsHiddenContentView({ projectDir = '', from = '', filePath = '' }) {
  const dir = projectDir || activeProject.value?.dir || '';
  const [rules, setRules] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [picking, setPicking] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRules(null);
    setError('');
    if (!dir) { setError('Open this page from a project’s settings.'); return; }
    fetchJson('/api/settings/hide-file-content?' + new URLSearchParams({ projectDir: dir }), { signal: controller.signal })
      .then((r) => {
        if (controller.signal.aborted) return;
        if (r.status !== 200 || !Array.isArray(r.body.rules)) throw new Error('Could not load hidden files.');
        setRules(r.body.rules);
      })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [dir, reload]);

  function onOpen(path) {
    setPicking(false);
    setNotice('');
    nav(hiddenContentPath({ projectDir: dir, from, filePath: path }));
  }
  function onClose() {
    nav(hiddenContentPath({ projectDir: dir, from }));
  }
  async function onSave(path, { ranges, chars }) {
    const next = rules.filter((rule) => rule.path !== path);
    const hasAny = ranges.length || chars.length;
    if (hasAny) next.push({ path, ranges, chars });
    const r = await fetchJson('/api/settings/hide-file-content', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir, rules: next })
    });
    if (r.status !== 200 || !Array.isArray(r.body.rules)) {
      throw new Error(`Could not save (HTTP ${r.status}).`);
    }
    setRules(r.body.rules);
    setNotice(hasAny ? 'Hidden content saved.' : 'File is no longer hidden.');
  }

  if (filePath && rules) return h(HiddenContentEditor, {
    key: dir + '|' + filePath, projectDir: dir, filePath,
    initialRule: rules.find((rule) => rule.path === filePath),
    onSave, onClose
  });
  const backParams = new URLSearchParams({ projectDir: dir });
  if (from) backParams.set('from', from);
  return h(Fragment, null,
    h('div', { class: 'view-head hidden-content__head' },
      h('a', { class: 'view-back', href: '#/settings/project?' + backParams, 'aria-label': 'Back to project settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Hide file content')
    ),
    h('section', { class: 'hidden-content', 'aria-label': 'Hidden files' },
      h('p', { class: 'hidden-content__intro' }, 'Choose a file, then tap the line numbers you want hidden from the agent file tools, or select text and hide just that span. Your file stays unchanged.'),
      h('p', { class: 'hidden-content__scope' },
        h('strong', null, 'Not a security boundary. '),
        'Only ', h('code', null, 'read_file'), ' and ', h('code', null, 'search_files'),
        ' are filtered. Shell, MCP, and other access can still read the original content.'
      ),
      error ? h('div', { role: 'alert' }, h('p', null, error), dir && h('button', { class: 'btn', onClick: () => setReload((n) => n + 1) }, 'Retry'))
        : rules === null ? h('p', { role: 'status' }, 'Loading hidden files…')
          : h(Fragment, null,
            rules.length ? h('ul', { class: 'hidden-content__files' }, rules.map((rule) => h('li', { key: rule.path },
              h('button', { class: 'hidden-content__file', onClick: () => onOpen(rule.path) },
                h('span', { class: 'hidden-content__file-main' },
                  h('span', { class: 'hidden-content__path' }, rule.path),
                  h('span', { class: 'hidden-content__muted' }, describeHidden(rule))
                ),
                h('span', { 'aria-hidden': 'true' }, '›')
              )
            ))) : h('p', { class: 'hidden-content__empty' }, 'Nothing hidden yet. Add a file to hide whole lines or selected text.'),
            h('button', { class: 'btn btn--primary', onClick: () => setPicking(true) }, '+ Add file'),
            h('p', { role: 'status', class: 'hidden-content__notice' }, notice)
          ),
      picking && h(AgentFilePicker, {
        projectDir: dir, onPick: onOpen, onClose: () => setPicking(false),
        label: 'Choose a file to hide lines',
        description: 'Choose a file to preview its contents and select hidden lines.'
      })
    )
  );
}
