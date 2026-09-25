// mouaif web — Git modal state (pure reducer, no Preact imports)
//
// Everything the Git modal shows lives in one reducer so each transition is
// explicit and testable in node (scripts/test-git-modal-state.mjs):
//
//   status        'loading' only before the first successful fetch. A later
//                 refresh keeps the current content on screen and sets
//                 `refreshing`, so expanded diffs, open commits and section
//                 toggles survive a Stage / Commit / Pull.
//   generation    bumped on every successful load. A "Load more" page that
//                 was requested against an older generation is dropped
//                 instead of being appended to the refreshed list.
//   busy          the git action in flight ('' when idle). Stays set until
//                 the follow-up reload finishes, so no control acts on stale
//                 data.
//   notice        { text, tone: 'ok' | 'error' } — survives the reload that
//                 follows a successful action.
//   confirm       the pending confirm sheet (commit action or stash drop);
//                 kept open while its action runs so it can say "Working…".
//   open          per-section toggle. `null` means "not touched yet": the
//                 section is open when it has entries.

export const COMMIT_PAGE = 20;

export const initialGitState = {
  status: 'loading',
  error: '',
  refreshing: false,
  generation: 0,
  data: null,
  commits: [],
  commitTotal: 0,
  loadingMore: false,
  moreError: '',
  busy: '',
  notice: null,
  confirm: null,
  commitMessage: '',
  open: { stash: false, staged: null, unstaged: null, commits: false }
};

export function gitReducer(state, action) {
  switch (action.type) {
    case 'load-start':
      return state.status === 'ready'
        ? Object.assign({}, state, { refreshing: true })
        : Object.assign({}, state, { status: 'loading', error: '' });
    case 'load-ok': {
      const data = action.data || {};
      return Object.assign({}, state, {
        status: 'ready',
        error: '',
        refreshing: false,
        generation: state.generation + 1,
        data,
        commits: Array.isArray(data.commits) ? data.commits : [],
        commitTotal: 0,
        loadingMore: false,
        moreError: ''
      });
    }
    case 'load-error':
      // A failed refresh keeps the last good content and reports the error in
      // the notice bar; only a failed first load replaces the body.
      if (state.status === 'ready') {
        return Object.assign({}, state, { refreshing: false, notice: { text: action.error, tone: 'error' } });
      }
      return Object.assign({}, state, { status: 'error', error: action.error, refreshing: false });
    case 'more-start':
      return Object.assign({}, state, { loadingMore: true, moreError: '' });
    case 'more-ok': {
      if (action.generation !== state.generation) return state;
      const seen = new Set(state.commits.map((c) => c.hash));
      const fresh = (action.commits || []).filter((c) => c && !seen.has(c.hash));
      return Object.assign({}, state, {
        loadingMore: false,
        commits: state.commits.concat(fresh),
        commitTotal: action.total || 0
      });
    }
    case 'more-error':
      if (action.generation !== state.generation) return state;
      return Object.assign({}, state, { loadingMore: false, moreError: action.error });
    case 'busy':
      return Object.assign({}, state, { busy: action.action, notice: null });
    case 'done':
      return Object.assign({}, state, {
        busy: '',
        confirm: null,
        notice: action.notice || null,
        commitMessage: action.clearMessage ? '' : state.commitMessage
      });
    case 'notice':
      return Object.assign({}, state, { notice: action.notice || null });
    case 'confirm':
      return state.busy ? state : Object.assign({}, state, { confirm: action.confirm });
    case 'cancel-confirm':
      return state.busy ? state : Object.assign({}, state, { confirm: null });
    case 'message':
      return Object.assign({}, state, { commitMessage: action.value });
    case 'toggle-section': {
      const current = sectionOpen(state, action.id);
      return Object.assign({}, state, { open: Object.assign({}, state.open, { [action.id]: !current }) });
    }
    default:
      return state;
  }
}

// Whether a section is expanded. Untouched staged / unstaged sections follow
// their content: open when they have entries.
export function sectionOpen(state, id) {
  const explicit = state.open[id];
  if (explicit === true || explicit === false) return explicit;
  const list = state.data && state.data[id];
  return Array.isArray(list) && list.length > 0;
}

export function hasMoreCommits(state) {
  if (state.commitTotal > 0) return state.commits.length < state.commitTotal;
  return state.commits.length >= COMMIT_PAGE && state.commits.length % COMMIT_PAGE === 0;
}

// The pathspecs a stage / unstage of this row passes to git. The server sends
// them in `paths` (both sides of a staged rename); older responses only had
// the display `path`.
export function pathsFor(file) {
  if (file && Array.isArray(file.paths) && file.paths.length) return file.paths;
  return file && file.path ? [file.path] : [];
}

// Every branch-select value: local names, then remote-only ones. `remote`
// tells the caller to check out with `track: true`.
export function branchOptions(data) {
  const local = (data && data.branches) || [];
  const remote = (data && data.remoteBranches) || [];
  return local.map((name) => ({ name, remote: false }))
    .concat(remote.map((name) => ({ name, remote: true })));
}

// The notice shown after a git action succeeds. Stage / unstage return ''
// (the list itself shows the result).
export function successText(action, arg) {
  switch (action) {
    case 'pull': return 'Pulled';
    case 'push': return 'Pushed';
    case 'checkout': return 'Checked out ' + (arg || '');
    case 'stash': return 'Stashed working changes';
    case 'stash-apply': return 'Applied ' + (arg || 'stash');
    case 'stash-pop': return 'Popped ' + (arg || 'stash');
    case 'stash-drop': return 'Dropped ' + (arg || 'stash');
    case 'commit': return 'Committed';
    case 'cherry-pick': return 'Cherry-picked ' + (arg || '');
    case 'revert': return 'Reverted ' + (arg || '');
    default: return '';
  }
}

// Failure text from a { stderr, error } result, never empty.
export function failureText(action, res) {
  const text = String((res && (res.stderr || res.error)) || '').trim();
  return text || 'git ' + action + ' failed';
}
