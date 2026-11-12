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
//
// A chat's artifacts open here too (docs/features/chat-artifacts.md), as
// `artifact:<name>` paths under a virtual folder at the top of the project.
// This component is lazy-loaded on demand (see Chat.jsx), so its CSS is
// imported here rather than via the global style.css chain — it only
// downloads when the file editor is opened.
import '../file-editor.css';

import { h, Fragment } from 'preact';
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { useBackClose } from '../hooks/useBackClose.js';
import { ARTIFACTS_CHANGED } from './chat/extensionEvents.js';
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

const ARTIFACTS_DIR = 'artifact:';
const isArtifact = (p) => typeof p === 'string' && p.startsWith(ARTIFACTS_DIR);
const shownPath = (p) => (isArtifact(p) ? p.slice(ARTIFACTS_DIR.length) : p);

function artifactUrl(projectDir, chatId, name) {
  return '/api/chats/' + encodeURIComponent(chatId || '') + '/artifacts' + (name ? '/' + encodeURIComponent(name) : '')
    + '?projectDir=' + encodeURIComponent(projectDir);
}

// The chat's artifacts in the shape a folder listing has. An artifact that is
// neither text nor an image can't open here, so its row opens the sheet instead.
async function apiListArtifacts(projectDir, chatId) {
  if (!chatId) return { error: 'Artifacts belong to a chat' };
  const r = await fetchJson(artifactUrl(projectDir, chatId));
  if (r.status !== 200) return { error: (r.body && r.body.error) || ('HTTP ' + r.status) };
  const entries = r.body.artifacts.map((a) => ({
    type: 'file',
    name: a.name,
    path: a.link,
    relPath: a.link,
    size: a.size,
    mime: a.mimeType,
    updatedAt: a.updatedAt,
    image: a.kind === 'image' || a.mimeType === 'image/svg+xml',
    sheetOnly: a.kind === 'binary'
  }));
  return { body: { dir: ARTIFACTS_DIR, entries } };
}

async function apiFindArtifact(projectDir, chatId, link) {
  const r = await apiListArtifacts(projectDir, chatId);
  if (r.error) return r;
  const entry = r.body.entries.find((e) => e.relPath === link);
  return entry ? { entry } : { error: 'This artifact is no longer in this chat.' };
}

async function apiReadArtifact(projectDir, chatId, link) {
  const name = link.slice(ARTIFACTS_DIR.length);
  const r = await fetchJson(artifactUrl(projectDir, chatId, name) + '&text=1');
  if (r.status !== 200) return { error: (r.body && r.body.error) || ('HTTP ' + r.status) };
  return { body: { relPath: link, path: link, content: r.body.text, size: r.body.artifact.size, ext: '' } };
}

// A raster image is drawn from its own route, so a large photo needs no data
// URL. The file route never draws an SVG, so it goes through the <img> below as a
// data URL, which keeps it a script-disabled document.
async function apiReadArtifactMedia(projectDir, chatId, link) {
  const found = await apiFindArtifact(projectDir, chatId, link);
  if (found.error) return found;
  const { entry } = found;
  const svg = entry.mime === 'image/svg+xml';
  let dataUrl = artifactUrl(projectDir, chatId, entry.name) + '&inline=1&v=' + encodeURIComponent(entry.updatedAt);
  if (svg) {
    const text = await apiReadArtifact(projectDir, chatId, link);
    if (text.error) return text;
    dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text.body.content);
  }
  return { body: { relPath: link, path: link, dataUrl, mime: entry.mime, size: entry.size, ext: svg ? '.svg' : '' } };
}

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

async function apiRead(projectDir, filePath, chatId) {
  if (isArtifact(filePath)) return apiReadArtifact(projectDir, chatId, filePath);
  const params = new URLSearchParams();
  if (projectDir) params.set('projectDir', projectDir);
  params.set('path', filePath);
  const r = await fetchJson('/api/file?' + params.toString());
  if (r.status !== 200) {
    return { error: (r.body && r.body.error) || ('HTTP ' + r.status), code: r.body && r.body.code };
  }
  return { body: r.body };
}

async function apiWrite(projectDir, filePath, content, chatId) {
  if (isArtifact(filePath)) {
    const r = await fetchJson(artifactUrl(projectDir, chatId, filePath.slice(ARTIFACTS_DIR.length)), {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: content
    });
    if (r.status !== 200) return { error: (r.body && r.body.error) || ('HTTP ' + r.status), code: r.body && r.body.code };
    window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: { projectDir, chatId } }));
    return { body: { size: r.body.artifact.size } };
  }
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
async function apiReadMedia(projectDir, filePath, chatId) {
  if (isArtifact(filePath)) return apiReadArtifactMedia(projectDir, chatId, filePath);
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
  // props: { projectDir, chatId, initialPath, onClose, onManageArtifact }
  const projectDir = props.projectDir || '';
  const chatId = props.chatId || '';
  const initialPath = props.initialPath || '';
  const onClose = props.onClose || (() => {});
  const onManageArtifact = props.onManageArtifact;

  // currentDirRef holds the directory we're listing. We keep it in a
  // ref (not just state) because typing in the path input should not
  // re-fetch on every keystroke — the user commits the new path with
  // Enter or the "Go" button.
  const currentDir = useRef(projectDir);
  const [dirDisplay, setDirDisplay] = useState(projectDir || '');
  const [browseTop, setBrowseTop] = useState('');
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
  // What the open artifact holds on the server, so its own save isn't mistaken
  // for a change the agent made.
  const savedContentRef = useRef(null);
  // Bumped by every open, so a slow read can't land over a later tap.
  const openSeqRef = useRef(0);

  // ---- listDir --------------------------------------------------------

  const loadDir = useCallback(async (dir) => {
    const target = (typeof dir === 'string' && dir) ? dir : currentDir.current || projectDir;
    setLoading(true);
    setListStatus('loading…');
    const r = isArtifact(target) ? await apiListArtifacts(projectDir, chatId) : await apiList(projectDir, target);
    if (r.error) {
      setListStatus(r.error);
      setEntries([]);
      setLoading(false);
      return;
    }
    currentDir.current = r.body.dir;
    setDirDisplay(r.body.dir);
    // The artifacts folder has no boundary of its own: keep the project's.
    if (!isArtifact(target)) setBrowseTop(r.body.browseTop || '');
    const listed = Array.isArray(r.body.entries) ? r.body.entries : [];
    setListStatus(listed.length + ' items');
    // The chat's artifacts are reached from the top of its project.
    const atProject = chatId && r.body.dir === r.body.projectDir;
    setEntries(atProject
      ? [{ type: 'dir', name: 'Artifacts of this chat', path: ARTIFACTS_DIR, relPath: ARTIFACTS_DIR, hasChildren: true }, ...listed]
      : listed);
    setLoading(false);
  }, [projectDir, chatId]);

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
    const seq = ++openSeqRef.current;
    // Opening a text file means the preview pane is no longer
    // current. Clear it so the editor owns the right-hand pane.
    setOpenMedia(null);
    setMediaStatus('');
    setEditorStatus('loading…');
    const r = await apiRead(projectDir, relOrAbs, chatId);
    if (seq !== openSeqRef.current) return;
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
    savedContentRef.current = file.content;
    setOpenFile(file);
    setDirty(false);
    setEditorStatus(file.size + ' bytes');
  }, [projectDir, chatId, confirmDiscardIfDirty]);

  // Open an image for preview. SVG can be edited as text, so callers
  // pass `forceText: true` when the user picks "Edit" from the
  // preview header; everything else is read-only here.
  const openMediaPath = useCallback(async (relOrAbs, opts) => {
    if (opts && opts.forceText) {
      // Hand off to the text path; it owns the editor lifecycle.
      return openPath(relOrAbs);
    }
    // Leaving a text file for a preview drops its buffer, so ask first.
    if (!confirmDiscardIfDirty()) return;
    const seq = ++openSeqRef.current;
    setMediaLoading(true);
    setMediaStatus('loading…');
    const r = await apiReadMedia(projectDir, relOrAbs, chatId);
    if (seq !== openSeqRef.current) return;
    setMediaLoading(false);
    if (r.error) {
      setMediaStatus(r.error);
      setOpenMedia(null);
      return;
    }
    // Close the editor when switching to preview so the right-hand
    // pane swaps cleanly (the discard was confirmed above).
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
  }, [projectDir, chatId, openPath, confirmDiscardIfDirty]);

  const manageArtifact = useCallback((link) => {
    if (!onManageArtifact || !confirmDiscardIfDirty()) return;
    onManageArtifact(link.slice(ARTIFACTS_DIR.length));
  }, [onManageArtifact, confirmDiscardIfDirty]);

  // A chip only knows an artifact's name, so ask what it is before choosing a pane.
  const openArtifact = useCallback(async (link) => {
    const found = await apiFindArtifact(projectDir, chatId, link);
    if (found.error) { setEditorStatus(found.error); return; }
    if (found.entry.sheetOnly) manageArtifact(link);
    else if (found.entry.image) openMediaPath(link);
    else openPath(link);
  }, [projectDir, chatId, manageArtifact, openMediaPath, openPath]);

  // If the caller opened the editor for a specific file (e.g. tapping an
  // @-mentioned file chip in the composer), open it immediately. Through a ref:
  // the open callbacks change as the file gets dirty, and that must not open it
  // again over what is being typed.
  const openInitialRef = useRef(null);
  openInitialRef.current = isArtifact(initialPath) ? openArtifact : openPath;
  useEffect(() => {
    if (initialPath) openInitialRef.current(initialPath);
  }, [initialPath]);

  // The agent or another view changed an artifact: the list follows, and so does
  // an open artifact unless it has edits that a reload would lose.
  useEffect(() => {
    if (!chatId) return undefined;
    const onChanged = async (event) => {
      const detail = (event && event.detail) || {};
      if (detail.chatId && detail.chatId !== chatId) return;
      if (isArtifact(currentDir.current)) loadDir(ARTIFACTS_DIR);
      if (openMedia && isArtifact(openMedia.relPath)) openMediaPath(openMedia.relPath);
      if (!openFile || !isArtifact(openFile.relPath) || dirty) return;
      const r = await apiRead(projectDir, openFile.relPath, chatId);
      if (r.error || r.body.content === savedContentRef.current) return;
      savedContentRef.current = r.body.content;
      setOpenFile({ ...openFile, content: r.body.content, size: r.body.size });
      setEditorStatus('updated · ' + r.body.size + ' bytes');
    };
    window.addEventListener(ARTIFACTS_CHANGED, onChanged);
    return () => window.removeEventListener(ARTIFACTS_CHANGED, onChanged);
  }, [projectDir, chatId, openFile, openMedia, dirty, loadDir, openMediaPath]);

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
        // Set through updaters: this listener lives as long as the view,
        // so values read from the render that mounted it would be stale.
        if (u.docChanged) {
          setDirty(true);
          setEditorStatus((s) => (s && s.indexOf('saved') !== 0 ? 'edited' : s));
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
    // Set before the request: its change event can arrive before the response.
    const previous = savedContentRef.current;
    savedContentRef.current = content;
    const r = await apiWrite(projectDir, openFile.relPath, content, chatId);
    setSaving(false);
    if (r.error) {
      savedContentRef.current = previous;
      setEditorStatus('save failed: ' + r.error);
      return;
    }
    setDirty(false);
    setEditorStatus('saved · ' + r.body.size + ' bytes');
  }, [openFile, projectDir, chatId]);

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
  // System Back closes the editor through the same unsaved-changes prompt.
  useBackClose(true, handleClose);

  // ---- navigation handlers -------------------------------------------
  // The editor can now browse above the project root (up to the user's
  // home, or the whole filesystem with MOUAIF_ALLOW_ANY_ROOT=1), matching
  // the project-folder picker. `browseTop` holds that boundary from the
  // server; the Up button and breadcrumb clamp there rather than at the
  // project root.
  function goUp() {
    const d = currentDir.current || '';
    if (!d) return;
    if (isArtifact(d)) { loadDir(projectDir); return; }
    // Already at the browse boundary — nothing above to go to.
    const top = browseTop || '';
    if (top && d === top) return;
    // Strip trailing separators; find the last separator; pop one
    // segment. Home (`~`) is the empty string in our model.
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    if (idx <= 0) {
      loadDir(top);
      return;
    }
    const parent = norm.slice(0, idx);
    if (top && parent === top) {
      loadDir(top);
      return;
    }
    loadDir(parent);
  }

  function onPathKey(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const v = (dirDisplay || '').trim();
      // If empty, treat as "go to browse boundary". Otherwise use as is.
      loadDir(v || browseTop || projectDir);
    }
  }

  function onPathGo() {
    const v = (dirDisplay || '').trim();
    loadDir(v || browseTop || projectDir);
  }

  function onEntryClick(entry) {
    if (entry.type === 'dir') {
      loadDir(entry.path);
      return;
    }
    // Image files open in the preview pane. The list marks them
    // with `binary: true` so the icon is consistent, but the
    // preview is a first-class action and not a "rejection".
    if (entry.sheetOnly) {
      manageArtifact(entry.relPath);
      return;
    }
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
    if (!d) return null;
    if (isArtifact(d)) return projectDir;
    const top = browseTop || '';
    if (top && d === top) return null;
    const norm = d.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return idx > 0 ? norm.slice(0, idx) : (top || null);
  }

  // ---- render ---------------------------------------------------------

  // The breadcrumb above the list shows the project root + every
  // segment of the current dir so the user can jump up several levels
  // in one tap. Each segment is a button (not a link) so we stay
  // inside the popup instead of navigating the app. The base of the
  // breadcrumb is the browse boundary (home, or / with ALLOW_ANY_ROOT),
  // not the project root, so the user can find their way back up.
  function renderBreadcrumb() {
    const base = browseTop || projectDir || '';
    const cur = currentDir.current || base;
    if (isArtifact(cur)) {
      return h(Fragment, null,
        h('button', { key: 'root', type: 'button', class: 'fe__crumb fe__crumb--root', onClick: () => loadDir(projectDir) }, projectDir.split(/[\\/]+/).pop() || projectDir),
        h('span', { key: 'sep', class: 'fe__crumb-sep', 'aria-hidden': 'true' }, '/'),
        h('span', { key: 'artifacts', class: 'fe__crumb' }, 'Artifacts of this chat'));
    }
    if (!base || cur === base) {
      return h(Fragment, null,
        h('span', { class: 'fe__crumb fe__crumb--root' }, base || 'project')
      );
    }
    const rel = cur.startsWith(base) ? cur.slice(base.length).replace(/^[\\/]+/, '') : cur;
    const segs = rel ? rel.split(/[\\/]+/) : [];
    const items = [];
    items.push(h('button', {
      key: 'root', type: 'button', class: 'fe__crumb fe__crumb--root',
      onClick: () => loadDir(base)
    }, base.split(/[\\/]+/).pop() || base));
    let acc = base;
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

  // One layout toggle, shared by both header variants so it keeps its
  // place, its label and its pressed state across the switch.
  // aria-pressed tracks "file list shown". The glyph is a panel outline:
  // the list's pane is filled while it is shown and empty while hidden.
  // Phones stack the list above the editor and wider screens put it on
  // the left, so the SVG holds both shapes and CSS shows the one that
  // matches the current layout.
  const listShown = !editorFull;
  const layoutToggle = h('button', {
    class: 'icon-btn fe__iconbtn fe__layout-toggle' + (listShown ? ' is-active' : ''),
    type: 'button',
    onClick: () => setEditorFull((v) => !v),
    'aria-label': 'Show file list',
    'aria-pressed': listShown ? 'true' : 'false',
    title: listShown ? 'Hide file list (full editor)' : 'Show file list (split view)'
  },
    h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round' },
      h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
      h('g', { class: 'fe__layout-icon fe__layout-icon--stack' },
        h('path', { d: 'M3 10h18' }),
        listShown ? h('path', { d: 'M5 6h14v3H5z', fill: 'currentColor', stroke: 'none' }) : null
      ),
      h('g', { class: 'fe__layout-icon fe__layout-icon--side' },
        h('path', { d: 'M9 4v16' }),
        listShown ? h('path', { d: 'M5 6h3v12H5z', fill: 'currentColor', stroke: 'none' }) : null
      )
    )
  );
  const closeBtn = h('button', { class: 'icon-btn icon-btn--close fe__iconbtn', type: 'button', onClick: handleClose, 'aria-label': 'Close', title: 'Close' },
    h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
      h('path', { d: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.88 18.3 9.17 12 2.88 5.71 4.3 4.3l6.29 6.29 6.3-6.29 1.41 1.41Z', fill: 'currentColor' })
    )
  );
  const hasPane = !!(openFile || openMedia);
  // Full editor with a file or image open: the top bar would only carry
  // the toggle and Close, so they move to the end of the file's own row
  // and the sheet keeps a single bar. They stay on the right, as in the
  // top bar: the left screen edge is the phone's back-gesture zone.
  // With nothing open there is no file row, so the top bar stays.
  const navInPane = editorFull && hasPane;
  // Renaming, deleting and the rest of an artifact's actions stay in its sheet.
  const manageBtn = (relPath) => (isArtifact(relPath) && onManageArtifact
    ? h('button', { class: 'btn', type: 'button', onClick: () => manageArtifact(relPath), title: 'Rename, delete, download or use it in a message' }, 'Manage')
    : null);

  return h('div', {
    class: 'fe__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'File editor',
    onClick: (ev) => { /* clicks on the overlay do not close; the X does */ }
  },
    h('div', { class: 'fe__sheet' + (editorFull ? ' fe__sheet--full' : '') },
!navInPane && h('div', { class: 'fe__head' },
// In full-editor mode the file list (and the
          // breadcrumb + nav bar) is gone, so we render a
          // minimal header with just the layout toggle (to
          // switch back to split) and Close.
          editorFull
            ? h('div', { class: 'fe__path-row' },
                layoutToggle,
          closeBtn
      )
      : h('div', { class: 'fe__path-row' },
        h('button', { class: 'icon-btn fe__iconbtn', type: 'button', onClick: goUp, 'aria-label': 'Up one folder', title: 'Up' },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
              // The path is a left-pointing arrow; +90° turns it up.
              h('path', { d: 'M12 4 4 12l8 8 1.4-1.4L8.8 14H20v-2H8.8l4.6-4.6L12 4Z', fill: 'currentColor', transform: 'rotate(90 12 12)' })
            )
          ),
          h('div', { class: 'fe__path-input-wrap' },
            h('input', {
              class: 'input fe__path-input',
              type: 'text',
              value: dirDisplay,
              onInput: (ev) => setDirDisplay(ev.currentTarget.value),
              onKeydown: onPathKey,
              placeholder: 'Folder path (absolute, or under this project)',
              'aria-label': 'Current folder',
              spellcheck: 'false',
              autocomplete: 'off'
            })
          ),
        h('button', { class: 'icon-btn fe__iconbtn', type: 'button', onClick: onPathGo, 'aria-label': 'Go to folder', title: 'Go' }, 'Go'),
        h('button', { class: 'icon-btn fe__iconbtn', type: 'button', onClick: () => loadDir(currentDir.current), 'aria-label': 'Refresh', title: 'Refresh' },
            h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
              h('path', { d: 'M12 4V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 13c0-4.42-3.58-8-8-8Zm-5.3 7.7A7.93 7.93 0 0 0 4 13c0 4.42 3.58 8 8 8v3l5-5-5-5v3c-3.31 0-6-2.69-6-6 0-1 .25-1.97.7-2.8L5.24 10.24Z', fill: 'currentColor' })
            )
          ),
          layoutToggle,
          closeBtn
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
      h('div', { class: 'fe__body' + (hasPane ? ' fe__body--has-pane' : '') },
        h('div', { class: 'fe__list-wrap' },
          h('ul', { class: 'fe__list', 'aria-label': 'Files and folders' },
            entries.length === 0
              ? h('li', { class: 'fe__empty' }, loading ? 'loading…' : 'no files here')
              : entries.map((e) =>
                  h('li', {
                    key: e.path,
                    // Images carry `binary` too, but they open in the preview.
                    class: 'fe__row' + (e.binary && !e.image ? ' fe__row--binary' : '') + (e.image ? ' fe__row--image' : '') + ((openFile && openFile.relPath === e.relPath) || (openMedia && openMedia.relPath === e.relPath) ? ' is-open' : ''),
                    role: 'button',
                    tabindex: e.binary && !e.image ? -1 : 0,
                    'aria-disabled': e.binary && !e.image ? 'true' : 'false',
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
                  h('div', { class: 'fe__editor-path', title: openMedia.absPath }, shownPath(openMedia.relPath)),
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
                    manageBtn(openMedia.relPath),
                    h('button', {
                      class: 'btn',
                      type: 'button',
                      onClick: () => { setOpenMedia(null); setMediaStatus(''); },
                      title: 'Close preview'
                    }, 'Close')
                  ),
                  navInPane && layoutToggle,
                  navInPane && closeBtn
                ),
                // Every previewable image — SVG included — renders through
                // this single <img>. An SVG loaded from a data: URL as an
                // image is a separate, script-disabled document: no
                // <script>, no on* handler, no <foreignObject> HTML, no
                // external fetch. Decoding the file into markup with
                // innerHTML instead (the previous `.fe__media-svg` branch)
                // executed whatever a repo's .svg contained, inside the
                // app's own origin. Keep this branch and the `img` alt as
                // the only preview path.
                h('div', { class: 'fe__media-host' },
                h('img', {
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
                  h('div', { class: 'fe__editor-path', title: openFile.absPath }, shownPath(openFile.relPath) + (dirty ? ' •' : '')),
h('div', { class: 'fe__editor-actions' + (isArtifact(openFile.relPath) ? ' fe__editor-actions--artifact' : '') },
manageBtn(openFile.relPath),
h('button', {
class: 'btn fe__draft-craft',
type: 'button',
onClick: openDraftCraft,
disabled: saving,
'aria-label': 'Draft Craft',
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
                  ),
                  navInPane && layoutToggle,
                  navInPane && closeBtn
                ),
                h('div', { ref: editorHostRef, class: 'fe__editor-host' }),
                h('div', { class: 'fe__editor-status' },
                  h('span', { class: 'status' }, editorStatus || ' ')
                )
              )
            : h('div', { class: 'fe__editor-empty' },
// A file that failed to open has no status bar of its own to say why.
editorStatus && editorStatus !== 'loading…' ? h('p', { role: 'alert' }, editorStatus) : null,
mediaStatus && !mediaLoading ? h('p', { role: 'alert' }, mediaStatus) : null,
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
