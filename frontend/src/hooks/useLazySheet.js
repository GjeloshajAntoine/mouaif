// mouaif web — the shared rule for a lazily imported sheet.
//
// Every full-screen sheet that is not needed at startup (the CLI terminal, the
// Git modal, the file editor, screen capture, artifacts, the web-preview
// viewer, the image annotator) is a separate hashed chunk, fetched only when
// the user first opens it: see FileToolbar.jsx and the Chat.jsx sheets.
//
// Those fetches can fail, and the failure used to be silent and permanent. A
// chunk URL is content-hashed into the *entry* bundle that is already in
// memory, so a rebuild or redeploy while the tab was open leaves the page
// asking for a chunk name the server no longer has. src/server-web-static.js
// answers a missing asset with `404 {error:'Not found'}`, the dynamic import
// rejects, and the old `.catch()` set the component back to `null` — which is
// exactly what it already was. Nothing re-ran (the loader effect's deps never
// changed) and nothing was rendered (`open && View ? … : null`), so the tap
// that opened the sheet did nothing at all, and every later tap only re-set an
// already-true "open" flag. The sheet stayed dead until a full reload.
//
// The rule this module encodes: a failed load is *state*, not a no-op. The
// caller renders `status === 'error'` (components/chat/LazySheetError.jsx)
// instead of nothing, so the user learns what happened and how to get out.
//
// Why the way out is a reload and not a retry: the HTML spec memoizes an import
// that failed in the document's module map, so every later `import()` of the
// same specifier rejects again *without issuing a request* (measured in Chrome:
// the first failure is one network request, the second is zero). A Retry button
// would therefore be a button that provably cannot work. The one action that
// does — a fresh document, whose index.html is network-first in the service
// worker (frontend/build/sw-src.js) and so names the current hashed entry — is
// what the error card offers as Reload the app.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

// lazySheetMessage(error, label) — the one sentence shown when a sheet's code
// could not be fetched. It names what failed (never a stack trace), states the
// likely cause in the user's terms, and says what to do. A chunk that 404s
// after a rebuild is the common case; a dropped connection is the rest, and
// both are answered the same way.
export function lazySheetMessage(error, label) {
  const name = label || 'this view';
  const detail = error && error.message ? String(error.message) : '';
  // `Failed to fetch`, `error loading dynamically imported module`,
  // `ChunkLoadError`, or a 404 for the hashed URL all mean the same thing to
  // the user, and none of them is worth showing verbatim.
  const networkish = !detail || /fetch|chunk|import|module|404|not found|loading/i.test(detail);
  const cause = networkish
    ? 'The app was probably updated since this page was loaded.'
    : detail;
  return 'Could not load ' + name + '. ' + cause + ' Reload the app to continue.';
}

// reloadDocument() — the recovery for a chunk that cannot be fetched. Split out
// so the error card and the hook share one implementation and a test can drive
// the two parts of it.
export function reloadDocument() {
  if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
    window.location.reload();
    return true;
  }
  return false;
}

// useLazySheet(name, loader) -> { View, status, error, load, retryAllowed }
//
// `loader()` is the dynamic import (`() => import('./CliModal.jsx')`) and
// `name` the named export to keep (`'CliModal'`). Returns:
//
//   View    the component, or null until it has loaded
//   status  'idle' (never asked for) | 'loading' | 'ready' | 'error'
//   error   the rejection reason once status is 'error'
//   load()  start the fetch. A no-op while it is loading, once it has
//           succeeded, and after it has failed: a failed import is memoized for
//           the document (see the header), so asking again is provably useless.
//           This is what an open handler calls.
//   errorCard()  the props for LazySheetError, or null when there is nothing
//           to report — one place that decides the wording and the actions, so
//           every caller renders the same card.
//
// The hook holds no visibility state: the caller keeps its own "open" flag and
// decides what to render from `status`. That split is what makes a failed load
// renderable, instead of a sheet that is open with no component to draw.
export function useLazySheet(name, loader) {
  const [View, setView] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  // The loader is usually an inline arrow recreated on every render, so it is
  // read through a ref rather than being a dependency.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const nameRef = useRef(name);
  nameRef.current = name;
  // One attempt per document, for the reason in the header.
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  // A view can unmount mid-flight (the chat view is replaced when the user
  // switches chats), and must not write state afterwards.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus('loading');
    setError(null);
    Promise.resolve()
      .then(() => loaderRef.current())
      .then((mod) => {
        if (!mountedRef.current) return;
        const picked = mod ? mod[nameRef.current] : null;
        // A chunk that loaded but does not export the name means the build and
        // the entry bundle disagree — the same stale-build failure as a 404,
        // so it is reported rather than rendering nothing.
        if (!picked) throw new Error('missing export ' + String(nameRef.current));
        setView(() => picked);
        setStatus('ready');
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setView(null);
        setError(err || new Error('load failed'));
        setStatus('error');
      });
  }, []);

  return { View, status, error, load };
}
