// mouaif web — File editor popup (CodeMirror) + project file browser.
//
// Rendered as a full-screen overlay (modal sheet) on top of the chat
// view when the user taps the file-icon button on the composer. Owns
// its own internal state: the current browse dir, the open file, the
// working content, and the dirty / saving flags. Calls the
// `/api/files` and `/api/file` server endpoints (see src/files.js) to
// list folders and read / write text files inside the chat's project
// root.
//
// Layout:
//   ┌────────────────────────────────────────────┐
//   │ path input | Up | Refresh | Close           │
//   ├──────────────┬─────────────────────────────┤
//   │ file list    │ file header | Save | Revert  │
//   │ (dirs+files) │ ─────────────────────────── │
//   │              │ CodeMirror editor           │
//   │              │                             │
//   │              ├─────────────────────────────┤
//   │              │ status                      │
//   └──────────────┴─────────────────────────────┘
//
// On phones the two panes stack vertically (list on top, editor
// below); see the CSS.

import { h, Fragment } from 'preact';
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark, oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { DraftCraftSheet } from './DraftCraftSheet.jsx';

// ---- Language detection ------------------------------------------------

// Pick a CodeMirror language extension from a file path. Returns null
// for unknown extensions so the editor falls back to a plain text
// buffer. The list is intentionally small: common web / config files
// the user is most likely to tweak from the chat composer.
function langExtForPath(filePath) {
  if (!filePath) return null;
  const lower = filePath.toLowerCase();
  const name = lower.split('/').pop() || lower;
  // Filename-based matches first (e.g. .gitignore, Dockerfile).
  if (name === 'dockerfile') return null; // plain text is fine
  const ext = (name.match(/\.[a-z0-9]+$/) || [''])[0];
  switch (ext) {
    case '.js': case '.jsx': case '.mjs': case '.cjs':
      return javascript({ jsx: ext === '.jsx' });
    case '.ts': case '.tsx':
      return javascript({ jsx: ext === '.tsx', typescript: true });
    case '.html': case '.htm': case '.svg': case '.xml': case '.mdx':
      return html();
    case '.css': case '.scss': case '.sass': case '.less':
      return css();
    case '.json':
      return json();
    case '.md': case '.markdown':
      return markdown();
    case '.py':
      return python();
    default:
      return null;
  }
}

// ---- API helpers -------------------------------------------------------

async function apiList(projectDir, dir) {
  const params = new URLSearchParams();
  if (projectDir) params.set('projectDir', projectDir);
  if (dir) params.set('dir', dir);
  const r = await fetchJson('/api/files?' + params.toString());
  if (r.status !== 200) {
    return { error: (r.body && r.body.error) || ('HTTP ' + r.status), code: r.body && r.body.code };
  }
  return { body: r.body };
}

async function apiRead(projectDir, filePath) {
  const params = new URLSearchParams();
  if (projectDir) params.set('projectDir', projectDir);
  params.set('path', filePath);
  const r = await fetchJson('/api/file?' + params.toString());
  if (r.status !== 200) {
    return { error: (r.body && r.body.error) || ('HTTP ' + r.status), code: r.body && r.body.code };
  }
  return { body: r.body };
}

async function apiWrite(projectDir, filePath, content) {
  const r = await fetchJson('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, path: filePath, content })
  });
  if (r.status !== 200) {
    return { error: (r.body && r.body.error) || ('HTTP ' + r.status), code: r.body && r.body.code };
  }
  return { body: r.body };
}
// Read a previewable image (PNG/JPG/GIF/WebP/SVG/BMP/ICO) as a
// data URL. The server returns the bytes inline so the modal does
// not need a separate auth-bearing URL; the same `projectDir` +
// `path` shape as the text read keeps the UI consistent.
async function apiReadMedia(projectDir, filePath) {
  const params = new URLSearchParams();
  if (projectDir) params.set('projectDir', projectDir);
  params.set('path', filePath);
  const r = await fetchJson('/api/file-media?' + params.toString());
  if (r.status !== 200) {
    return { error: (r.body && r.body.error) || ('HTTP ' + r.status), code: r.body && r.body.code };
  }
  return { body: r.body };
}

// ---- Component ---------------------------------------------------------

export function FileEditorView(props) {
  // props: { projectDir, onClose }
  const projectDir = props.projectDir || '';
  const onClose = props.onClose || (() => {});

  // currentDirRef holds the directory we're listing. We keep it in a
  // ref (not just state) because typing in the path input should not
  // re-fetch on every keystroke — the user commits the new path with
  // Enter or the "Go" button.
  const currentDir = useRef(projectDir);
  const [dirDisplay, setDirDisplay] = useState(projectDir || '');
  const [entries, setEntries] = useState([]);
  const [listStatus, setListStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const [openFile, setOpenFile] = useState(null); // { relPath, absPath, content, size, ext }
  const [openMedia, setOpenMedia] = useState(null); // { relPath, absPath, dataUrl, mime, size, ext }
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaStatus, setMediaStatus] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorStatus, setEditorStatus] = useState('');
  const [draftCraftOpen, setDraftCraftOpen] = useState(false);
  const [draftCraftPayload, setDraftCraftPayload] = useState(null);
  const editorHostRef = useRef(null);
  const viewRef = useRef(null);     // CodeMirror EditorView
  // editorFull hides the file list so the editor takes the whole
  // pane. Default is false (split layout) — toggling off restores
  // the same layout the modal opened with.
  const [editorFull, setEditorFull] = useState(false);
  // saveRef always points to the latest save callback. CodeMirror's
  // keymap is configured once per open, so without this the Ctrl+S
  // binding would capture a stale save reference (and fail to write
  // when the user changed the open file).
  const saveRef = useRef(null);

  // ---- listDir --------------------------------------------------------

  const loadDir = useCallback(async (dir) => {
    const target = (typeof dir === 'string' && dir) ? dir : currentDir.current || projectDir;
    setLoading(true);
    setListStatus('loading…');
    const r = await apiList(projectDir, target);
    if (r.error) {
      setListStatus(r.error);
      setEntries([]);
      setLoading(false);
      return;
    }
    currentDir.current = r.body.dir;
    setDirDisplay(r.body.dir);
    setEntries(Array.isArray(r.body.entries) ? r.body.entries : []);
    setListStatus((r.body.entries ? r.body.entries.length : 0) + ' items');
    setLoading(false);
  }, [projectDir]);

  useEffect(() => { loadDir(projectDir); }, [loadDir, projectDir]);

  // ---- open file ------------------------------------------------------

  // If the user has unsaved changes when they tap a different file or
  // close the popup, we ask for confirmation. The popup's parent (chat
  // view) cannot intercept — we own the lifecycle here.
  const confirmDiscardIfDirty = useCallback(() => {
    if (!dirty) return true;
    // keep the popup synchronous; window.confirm is the same pattern
    // the rest of the app uses (e.g. the chat delete button).
    // eslint-disable-next-line no-alert
    return window.confirm('Discard unsaved changes?');
  }, [dirty]);

  const openPath = useCallback(async (relOrAbs) => {
    if (!confirmDiscardIfDirty()) return;
    // Opening a text file means the preview pane is no longer
    // current. Clear it so the editor owns the right-hand pane.
    setOpenMedia(null);
    setMediaStatus('');
    setEditorStatus('loading…');
    const r = await apiRead(projectDir, relOrAbs);
    if (r.error) {
      setEditorStatus(r.error);
      return;
    }
    // Swap the editor into the new file. We mount the view once and
    // reconfigure it via setState on every open so the DOM node
    // persists (faster second open, preserves scroll position when
    // re-opening the same file).
    const file = {
      relPath: r.body.relPath,
      absPath: r.body.path,
      content: r.body.content,
      size: r.body.size,
      ext: r.body.ext
    };
    setOpenFile(file);
    setDirty(false);
    setEditorStatus(file.size + ' bytes');
  }, [projectDir, confirmDiscardIfDirty]);
  // Open an image for preview. SVG can be edited as text, so callers
  // pass `forceText: true` when the user picks "Edit" from the
  // preview header; everything else is read-only here.
  const openMediaPath = useCallback(async (relOrAbs, opts) => {
    if (opts && opts.forceText) {
      // Hand off to the text path; it owns the editor lifecycle.
      return openPath(relOrAbs);
    }
    setMediaLoading(true);
    setMediaStatus('loading…');
    const r = await apiReadMedia(projectDir, relOrAbs);
    setMediaLoading(false);
    if (r.error) {
      setMediaStatus(r.error);
      setOpenMedia(null);
      return;
    }
    // Close the editor when switching to preview so the right-hand
    // pane swaps cleanly. The user's dirty text buffer is dropped
    // here without a confirm() — preview is a different mode and
    // discarding a half-typed file just to look at an image is the
    // expected trade-off.
    setOpenFile(null);
    setDirty(false);
    setEditorStatus('');
    setOpenMedia({
      relPath: r.body.relPath,
      absPath: r.body.path,
      dataUrl: r.body.dataUrl,
      mime: r.body.mime,
      size: r.body.size,
      ext: r.body.ext
    });
    setMediaStatus(r.body.size + ' bytes · ' + r.body.mime);
  }, [projectDir, openPath]);

  useLayoutEffect(() => {
    if (!openFile) return;
    mountEditor(openFile);
  }, [openFile]);

  // ---- CodeMirror mount / reconfigure ---------------------------------

  // Build (or rebuild) the CodeMirror EditorView for a given file.
  // Called once on the first open and again on every subsequent open
  // so the language pack + content match the current file.
  function mountEditor(file) {
    if (!editorHostRef.current) return;
    // Tear down any previous view so we don't leak listeners.
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    const langExt = langExtForPath(file.relPath);
    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(oneDarkHighlightStyle),
      keymap.of([
        // Ctrl/Cmd+S — save. The browser's "save page" dialog is
        // suppressed by preventDefault. Calling through saveRef means
        // we always hit the latest save closure (which closes over
        // the current openFile and viewRef).
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => { if (saveRef.current) saveRef.current(); return true; }
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap
      ]),
      EditorView.lineWrapping,
      oneDark,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          if (!dirty) setDirty(true);
          if (editorStatus && editorStatus.indexOf('saved') !== 0) setEditorStatus('edited');
        }
      })
    ];
    if (langExt) extensions.push(langExt);
    const state = EditorState.create({
      doc: file.content,
      extensions
    });
    viewRef.current = new EditorView({ state, parent: editorHostRef.current });
    requestAnimationFrame(() => {
      if (!viewRef.current) return;
      viewRef.current.requestMeasure();
    });
  }

  // When the popup unmounts (e.g. onClose), destroy the view so we
  // don't leak listeners.
  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, []);
  // When the user switches to a preview, drop the editor view so it
  // does not linger in the background and waste memory. mountEditor
  // will rebuild it from scratch the next time openFile is set.
  useEffect(() => {
    if (openMedia && viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
  }, [openMedia]);

  // ---- save / revert --------------------------------------------------

  const save = useCallback(async () => {
    if (!openFile || !viewRef.current) return;
    setSaving(true);
    setEditorStatus('saving…');
    const content = viewRef.current.state.doc.toString();
    const r = await apiWrite(projectDir, openFile.relPath, content);
    setSaving(false);
    if (r.error) {
      setEditorStatus('save failed: ' + r.error);
      return;
    }
    setDirty(false);
    setEditorStatus('saved · ' + r.body.size + ' bytes');
  }, [openFile, projectDir]);

  // Keep saveRef in sync with the latest save callback so the
  // CodeMirror Ctrl+S keymap (configured once per open) always hits
  // the closure that knows the current file + viewRef.
  useEffect(() => { saveRef.current = save; }, [save]);

  const revert = useCallback(() => {
    if (!openFile || !viewRef.current) return;
    if (!confirmDiscardIfDirty()) return;
    viewRef.current.dispatch({
      changes: { from: 0, to: viewRef.current.state.doc.length, insert: openFile.content }
    });
    setDirty(false);
    setEditorStatus('reverted');
  }, [openFile, confirmDiscardIfDirty]);

  // ---- close ----------------------------------------------------------

  const handleClose = useCallback(() => {
    if (!confirmDiscardIfDirty()) return;
    onClose();
  }, [confirmDiscardIfDirty, onClose]);

  // ---- navigation handlers -------------------------------------------

  function goUp() {
    const d = currentDir.current || '';
    if (!d) return;
    // Strip trailing separators; find the last separator; pop one
    // segment. Home (`~`) is the empty string in our model.
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (idx <= 0) {
      // Going above the project root is not allowed: popups are
      // scoped to the project. Replace with the project root instead.
      loadDir(projectDir);
      return;
    }
    loadDir(norm.slice(0, idx));
  }

  function onPathKey(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const v = (dirDisplay || '').trim();
      // If empty, treat as "go to project root". Otherwise use as is.
      loadDir(v || projectDir);
    }
  }

  function onPathGo() {
    const v = (dirDisplay || '').trim();
    loadDir(v || projectDir);
  }

  function onEntryClick(entry) {
    if (entry.type === 'dir') {
      loadDir(entry.path);
      return;
    }
    // Image files open in the preview pane. The list marks them
    // with `binary: true` so the icon is consistent, but the
    // preview is a first-class action and not a "rejection".
    if (entry.image) {
      openMediaPath(entry.relPath);
      return;
    }
    // Reject other binaries client-side as a UX shortcut (the server
    // would reject them anyway, but greying them out communicates
    // the rule without a round-trip).
    if (entry.binary) return;
    openPath(entry.relPath);
  }

  function openDraftCraft() {
    if (!openFile || !viewRef.current) return;
    const selection = viewRef.current.state.selection.main;
    if (selection.empty) {
      setEditorStatus('Select code before using Draft Craft.');
      viewRef.current.focus();
      return;
    }
    const code = viewRef.current.state.sliceDoc(selection.from, selection.to);
    const startLine = viewRef.current.state.doc.lineAt(selection.from).number;
    const endLine = viewRef.current.state.doc.lineAt(selection.to).number;
    setDraftCraftPayload({
      projectDir,
      text: openFile.relPath + ':' + startLine + (endLine !== startLine ? '-' + endLine : '') + '\n' + code
    });
    setDraftCraftOpen(true);
  }

  function parentRel() {
    const d = currentDir.current || '';
    if (!d || d === projectDir) return null;
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx > 0 ? norm.slice(0, idx) : projectDir;
  }

  // ---- render ---------------------------------------------------------

  // The breadcrumb above the list shows the project root + every
  // segment of the current dir so the user can jump up several levels
  // in one tap. Each segment is a button (not a link) so we stay
  // inside the popup instead of navigating the app.
  function renderBreadcrumb() {
    const root = projectDir || '';
    const cur = currentDir.current || root;
    if (!root || cur === root) {
      return h(Fragment, null,
        h('span', { class: 'fe__crumb fe__crumb--root' }, root || 'project')
      );
    }
    const rel = cur.startsWith(root) ? cur.slice(root.length).replace(/^[\\/]+/, '') : cur;
    const segs = rel ? rel.split(/[\\/]+/) : [];
    const items = [];
    items.push(h('button', {
      key: 'root', type: 'button', class: 'fe__crumb fe__crumb--root',
      onClick: () => loadDir(root)
    }, root.split(/[\\/]+/).pop() || root));
    let acc = root;
    segs.forEach((seg, i) => {
      acc = acc + (acc.endsWith('\\') || acc.endsWith('/') ? '' : '/') + seg;
      items.push(h('span', { key: 'sep-' + i, class: 'fe__crumb-sep', 'aria-hidden': 'true' }, '/'));
      items.push(h('button', {
        key: 'seg-' + i, type: 'button', class: 'fe__crumb',
        onClick: () => loadDir(acc)
      }, seg));
    });
    return h(Fragment, null, items);
  }

  return h('div', {
    class: 'fe__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'File editor',
    onClick: (ev) => { /* clicks on the overlay do not close; the X does */ }
  },
    h('div', { class: 'fe__sheet' + (editorFull ? ' fe__sheet--full' : '') },
h('div', { class: 'fe__head' },
// In full-editor mode the file list (and the
          // breadcrumb + nav bar) is gone, so we render a
          // minimal header with just the toggle (to switch
          // back to split) and Close. The toggle icon shows
          // the *next* state: two equal bars = split view.
          // The icon is rendered at 18px so the single shape
          // stays legible at the 36px mobile touch target.
          editorFull
            ? h('div', { class: 'fe__path-row' },
                h('button', {
                  class: 'fe__iconbtn is-active',
                  type: 'button',
                  onClick: () => setEditorFull(false),
                  'aria-label': 'Show file list',
                  'aria-pressed': 'true',
                  title: 'Show file list'
                },
                  h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
                    h('path', { d: 'M4 4h7v16H4zM13 4h7v16h-7z', fill: 'currentColor' })
                  )
                ),
                h('button', { class: 'fe__iconbtn fe__iconbtn--close', type: 'button', onClick: handleClose, 'aria-label': 'Close', title: 'Close' },
                  h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
                    h('path', { d: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.3l6.29 6.29 6.3-6.29 1.41 1.41Z', fill: 'currentColor' })
                  )
                )
              )
            : h('div', { class: 'fe__path-row' },
          h('button', { class: 'fe__iconbtn', type: 'button', onClick: goUp, 'aria-label': 'Up one folder', title: 'Up' },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
              h('path', { d: 'M12 4 4 12l8 8 1.4-1.4L8.8 14H20v-2H8.8l4.6-4.6L12 4Z', fill: 'currentColor', transform: 'rotate(-90 12 12)' })
            )
          ),
          h('div', { class: 'fe__path-input-wrap' },
            h('input', {
              class: 'input fe__path-input',
              type: 'text',
              value: dirDisplay,
              onInput: (ev) => setDirDisplay(ev.currentTarget.value),
              onKeydown: onPathKey,
              placeholder: 'Folder path under this project',
              'aria-label': 'Current folder',
              spellcheck: 'false',
              autocomplete: 'off'
            })
          ),
          h('button', { class: 'fe__iconbtn', type: 'button', onClick: onPathGo, 'aria-label': 'Go to folder', title: 'Go' }, 'Go'),
          h('button', { class: 'fe__iconbtn', type: 'button', onClick: () => loadDir(currentDir.current), 'aria-label': 'Refresh', title: 'Refresh' },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
              h('path', { d: 'M12 4V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 13c0-4.42-3.58-8-8-8Zm-5.3 7.7A7.93 7.93 0 0 0 4 13c0 4.42 3.58 8 8 8v3l5-5-5-5v3c-3.31 0-6-2.69-6-6 0-1 .25-1.97.7-2.8L5.24 10.24Z', fill: 'currentColor' })
            )
          ),
          // Toggle to full-editor mode. The icon is the *next*
          // state (one wide rectangle) so the button reads as
          // "go to full editor". A larger 18px box keeps the
          // single shape legible on phone-sized buttons.
          h('button', {
            class: 'fe__iconbtn',
            type: 'button',
            onClick: () => setEditorFull(true),
            'aria-label': 'Hide file list',
            'aria-pressed': 'false',
            title: 'Hide file list'
          },
            h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
              h('path', { d: 'M3 5h18v14H3z', fill: 'currentColor' })
            )
          ),
          h('button', { class: 'fe__iconbtn fe__iconbtn--close', type: 'button', onClick: handleClose, 'aria-label': 'Close', title: 'Close' },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
              h('path', { d: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.3l6.29 6.29 6.3-6.29 1.41 1.41Z', fill: 'currentColor' })
            )
          )
        ),
        // Breadcrumb + list-status are list-navigation
        // chrome; hide them in full-editor mode so the
        // header only carries actions that make sense for
        // a single-pane layout.
        !editorFull && h('div', { class: 'fe__crumbs', 'aria-label': 'Breadcrumb' }, renderBreadcrumb()),
        !editorFull && h('div', { class: 'fe__list-status' },
          h('span', { class: 'status' }, listStatus || ' '),
          parentRel() ? h('button', { class: 'btn btn--ghost fe__list-up', type: 'button', onClick: goUp }, '↑ Up') : null
        )
      ),
      h('div', { class: 'fe__body' },
        h('div', { class: 'fe__list-wrap' },
          h('ul', { class: 'fe__list', 'aria-label': 'Files and folders' },
            entries.length === 0
              ? h('li', { class: 'fe__empty' }, loading ? 'loading…' : 'no files here')
              : entries.map((e) =>
                  h('li', {
                    key: e.path,
                    class: 'fe__row' + (e.binary ? ' fe__row--binary' : '') + (e.image ? ' fe__row--image' : '') + ((openFile && openFile.relPath === e.relPath) || (openMedia && openMedia.relPath === e.relPath) ? ' is-open' : ''),
                    role: 'button',
                    tabindex: e.binary ? -1 : 0,
                    'aria-disabled': e.binary ? 'true' : 'false',
                    title: (e.binary && !e.image) ? 'binary file — cannot be opened here' : (e.path),
                    onClick: () => onEntryClick(e),
                    onKeydown: (ev) => {
                      if (e.binary && !e.image) return;
                      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onEntryClick(e); }
                    }
                  },
                    h('span', { class: 'fe__row-icon', 'aria-hidden': 'true' },
                      e.type === 'dir'
                        ? h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
                            h('path', { d: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z', fill: 'currentColor' }))
                        : e.image
                          ? h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
                              h('path', { d: 'M21 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm-9 11-3-4-2.5 3L4 13.5V7h16v9l-4-3-4 3Zm-4-7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z', fill: 'currentColor' }))
                          : h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
                              h('path', { d: 'M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5Z', fill: 'currentColor' })
                            )
                    ),
                    h('span', { class: 'fe__row-name' }, e.name),
                    e.type === 'dir'
                      ? h('span', { class: 'fe__row-meta' }, e.hasChildren ? '…' : '·')
                      : h('span', { class: 'fe__row-meta' },
                          e.image ? 'image'
                            : (e.binary ? 'binary' : (e.size < 1024 ? (e.size + ' B') : Math.round(e.size / 1024) + ' KB'))
                        )
                  )
                )
          )
        ),
        h('div', { class: 'fe__editor-wrap' },
          openMedia
            ? h(Fragment, null,
                h('div', { class: 'fe__editor-head' },
                  h('div', { class: 'fe__editor-path', title: openMedia.absPath }, openMedia.relPath),
                  h('div', { class: 'fe__editor-actions' },
                    // SVG is also a text file; offer to
                    // switch to the editor for it. Other
                    // image types stay read-only.
                    (openMedia.ext === '.svg' || (openMedia.mime === 'image/svg+xml'))
                      ? h('button', {
                          class: 'btn',
                          type: 'button',
                          onClick: () => openMediaPath(openMedia.relPath, { forceText: true }),
                          title: 'Open this file in the code editor'
                        }, 'Edit')
                      : null,
                    h('button', {
                      class: 'btn',
                      type: 'button',
                      onClick: () => { setOpenMedia(null); setMediaStatus(''); },
                      title: 'Close preview'
                    }, 'Close')
                  )
                ),
                h('div', { class: 'fe__media-host' },
                  openMedia.mime === 'image/svg+xml'
                    ? h('div', {
                        class: 'fe__media-svg',
                        role: 'img',
                        'aria-label': openMedia.relPath,
                        dangerouslySetInnerHTML: { __html: atob(openMedia.dataUrl.split(',')[1] || '') }
                      })
                    : h('img', {
                        class: 'fe__media-img',
                        src: openMedia.dataUrl,
                        alt: openMedia.relPath,
                        draggable: 'false'
                      })
                ),
                h('div', { class: 'fe__editor-status' },
                  h('span', { class: 'status' }, mediaStatus || ' ')
                )
              )
            : openFile
              ? h(Fragment, null,
                h('div', { class: 'fe__editor-head' },
                  h('div', { class: 'fe__editor-path', title: openFile.absPath }, openFile.relPath + (dirty ? ' •' : '')),
h('div', { class: 'fe__editor-actions' },
h('button', {
class: 'btn fe__draft-craft',
type: 'button',
onClick: openDraftCraft,
disabled: saving,
title: 'Add the selected code to any chat draft'
},
h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
h('path', { d: 'M4 4h16v13a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V4Zm2 2v9h4a2 2 0 0 0 4 0h4V6H6Z', fill: 'currentColor' })
),
h('span', null, 'Draft Craft')
),
h('button', {
class: 'btn',
type: 'button',
onClick: revert,
disabled: !dirty || saving,
title: 'Revert to the last saved version'
}, 'Revert'),
                    h('button', {
                      class: 'btn btn--primary',
                      type: 'button',
                      onClick: save,
                      disabled: !dirty || saving,
                      title: 'Save (Ctrl/Cmd+S is wired to the editor save keymap via the browser default)',
                      'aria-label': 'Save file'
                    }, saving ? 'Saving…' : 'Save')
                  )
                ),
                h('div', { ref: editorHostRef, class: 'fe__editor-host' }),
                h('div', { class: 'fe__editor-status' },
                  h('span', { class: 'status' }, editorStatus || ' ')
                )
              )
            : h('div', { class: 'fe__editor-empty' },
h('p', null, 'Pick a file from the list to start editing, or tap an image to preview it.'),
h('p', { class: 'fe__editor-hint' }, 'Tip: type a path above or use the breadcrumb to jump to a folder.')
)
)
),
h(DraftCraftSheet, {
open: draftCraftOpen,
payload: draftCraftPayload,
placement: 'top',
onClose: () => setDraftCraftOpen(false),
onAdded: (result) => {
setDraftCraftOpen(false);
setEditorStatus('Selected code added with Draft Craft.');
if (props.onDraftCraftAdded) props.onDraftCraftAdded(result);
}
})
)
);
}
