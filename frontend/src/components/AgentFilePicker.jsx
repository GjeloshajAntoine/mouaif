// mouaif web — AgentFilePicker
//
// A mobile-first file browser popup for the "File names to look for"
// field in Project Settings → Agent files. It lists the project's
// folders and text files via the existing `/api/files` endpoint (the
// same contract the chat file editor uses — see src/files.js), letting
// the user navigate and tap a file to fill the agent-file-names
// textarea with its project-relative path.
//
// It is intentionally read-only: tapping a file only reports its
// `relPath` back to the parent, which appends it to the setting. We
// never create, edit, or delete anything here. Binary files are
// listed but greyed out, matching the file editor.
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';

async function listDir(projectDir, dir) {
  const params = new URLSearchParams();
  if (projectDir) params.set('projectDir', projectDir);
  if (dir) params.set('dir', dir);
  const r = await fetchJson('/api/files?' + params.toString());
  if (r.status !== 200) {
    return { error: (r.body && r.body.error) || ('HTTP ' + r.status) };
  }
  return { body: r.body };
}

export function AgentFilePicker(props) {
  // props: { projectDir, onPick(relPath), onClose }
  const projectDir = props.projectDir || '';
  const onPick = props.onPick || (() => {});
  const onClose = props.onClose || (() => {});
  const [dir, setDir] = useState(projectDir || '');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function loadDir(target) {
    const d = (typeof target === 'string' && target) ? target : projectDir || '';
    setLoading(true);
    setErr('');
    const r = await listDir(projectDir, d);
    if (r.error) {
      setErr(r.error);
      setEntries([]);
      setLoading(false);
      return;
    }
    setDir(r.body.dir);
    setEntries(Array.isArray(r.body.entries) ? r.body.entries : []);
    setLoading(false);
  }

  useEffect(() => { loadDir(projectDir); }, [projectDir]);

  // Close on Escape.
  useEffect(() => {
    function onKey(ev) { if (ev.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function goUp() {
    const d = dir || '';
    if (!d) return;
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (idx <= 0) { loadDir(projectDir); return; }
    loadDir(norm.slice(0, idx));
  }

  function onEntry(e) {
    if (e.type === 'dir') { loadDir(e.path); return; }
    if (e.binary) return; // greyed out, matching the file editor
    onPick(e.relPath);
  }

  function parentRel() {
    const d = dir || '';
    if (!d || d === projectDir) return null;
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx > 0 ? norm.slice(0, idx) : projectDir;
  }

  return h('div', {
    class: 'afp__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Pick an agent file',
    onClick: (ev) => { if (ev.target === ev.currentTarget) onClose(); }
  },
    h('div', { class: 'afp__sheet' },
      h('div', { class: 'afp__head' },
        h('div', { class: 'afp__title' }, 'Pick a file'),
        h('div', { class: 'afp__sub' }, 'Tapping a file adds its project-relative path to the list.'),
        h('div', { class: 'afp__path-row' },
          h('button', { class: 'afp__iconbtn', type: 'button', onClick: goUp, 'aria-label': 'Up one folder', title: 'Up' },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
              h('path', { d: 'M12 4 4 12l8 8 1.4-1.4L8.8 14H20v-2H8.8l4.6-4.6L12 4Z', fill: 'currentColor', transform: 'rotate(-90 12 12)' })
            )
          ),
          h('div', { class: 'afp__path' }, dir || 'project'),
          h('button', { class: 'afp__iconbtn afp__iconbtn--close', type: 'button', onClick: onClose, 'aria-label': 'Close', title: 'Close' },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
              h('path', { d: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.3l6.29 6.29 6.3-6.29 1.41 1.41Z', fill: 'currentColor' })
            )
          )
        )
      ),
      h('div', { class: 'afp__body' },
        err ? h('p', { class: 'afp__err' }, err)
          : h('ul', { class: 'afp__list', 'aria-label': 'Files and folders' },
              entries.length === 0
                ? h('li', { class: 'afp__empty' }, loading ? 'loading…' : 'no files here')
                : entries.map((e) =>
                    h('li', {
                      key: e.path,
                      class: 'afp__row' + (e.binary ? ' afp__row--binary' : ''),
                      role: 'button',
                      tabindex: e.binary ? -1 : 0,
                      'aria-disabled': e.binary ? 'true' : 'false',
                      title: e.binary ? 'binary file — cannot be picked here' : (e.relPath || e.path),
                      onClick: () => onEntry(e),
                      onKeydown: (ev) => {
                        if (e.binary) return;
                        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onEntry(e); }
                      }
                    },
                      h('span', { class: 'afp__row-icon', 'aria-hidden': 'true' },
                        e.type === 'dir'
                          ? h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
                              h('path', { d: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z', fill: 'currentColor' }))
                          : h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
                              h('path', { d: 'M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5Z', fill: 'currentColor' })
                            )
                      ),
                      h('span', { class: 'afp__row-name' }, e.name),
                      e.type === 'dir'
                        ? h('span', { class: 'afp__row-meta' }, e.hasChildren ? '…' : '·')
                        : h('span', { class: 'afp__row-meta' }, e.binary ? 'binary' : (e.size < 1024 ? (e.size + ' B') : Math.round(e.size / 1024) + ' KB'))
                    )
                  )
            ),
        h('div', { class: 'afp__foot' },
          parentRel() ? h('button', { class: 'btn btn--ghost afp__up', type: 'button', onClick: goUp }, '↑ Up') : null,
          h('button', { class: 'btn', type: 'button', onClick: onClose }, 'Cancel')
        )
      )
    )
  );
}
