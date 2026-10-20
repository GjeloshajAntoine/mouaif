// mouaif web — Settings → Project → Shell review (its own page)
//
// The configuration page for shell review (docs/features/shell-review.md): a
// second model reads a shell command before it is approved and reports its
// effects with a SAFE / CAUTION / DANGER verdict.
//
// The model control is the app's model control. Every surface that picks a
// model — the chat head, the agent editor, the subagent defaults, dictation —
// renders `ModelPickerField` over the project's models unioned with each
// configured provider's live catalog, with the same pinned and recent
// sections and the same refresh action. This page does exactly that: one
// picker, one `{ providerId, modelId }` value, saved when it changes. There is
// no second way to spell a model here, so a reviewer cannot be configured with
// a shape the rest of the app would not recognise.
//
// Everything writes the same project value, `shellReview`, as one complete
// object per save: the server stores it as one value, so a partial write would
// be a read-modify-write with no guarantee both halves came from the same
// snapshot. The mode and the model commit immediately (both are closed
// choices); the prompt is text and saves as you type, debounced, like the
// agent editor's instructions.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, fetchLiveModels, activeProject } from '../api.js';
import { ModelPickerField } from './ModelPickerField.jsx';
import { sectionIcon } from './settingsProjectUi.js';
import { settingsLink, backHref, backTarget } from './settings/projectNavigation.js';
import { SHELL_REVIEW_MODES, shellReviewFromResolved } from './chat/shellReview.js';
import { loadPinned, togglePin, loadRecent, loadRecentFromServer, touchRecent, migrateProjectScopedBookmarks } from './chat/modelPicker.js';

// stateFor(saved) -> the row's standing description of the current choice.
//
// This is a NOTE, never a status message: `.settings-project__item-note` is the
// neutral grey line under a row's title, while `.settings-project__item-status`
// is the green/red line that means "just saved" / "save failed". Putting the
// configuration summary in the status slot painted a permanent sentence green,
// which reads as unread save feedback and never stops saying it.
function stateFor(saved) {
  if (!saved) return '';
  if (saved.mode === 'off') return 'Off — no command is sent to another model.';
  if (!saved.configured) return 'No review is sent yet: pick a model below.';
  const when = saved.mode === 'always'
    ? 'every shell command is reviewed before you approve it'
    : 'reviews happen only from the chat’s Review a command button';
  return 'Reviews go to ' + saved.providerId + ' · ' + saved.modelId + ' — ' + when + '.';
}

export function ShellReviewPageView({ projectDir = '', from = '', chatId = '' } = {}) {
  const dir = projectDir || (activeProject.value && activeProject.value.dir) || '';
  const context = { projectDir: dir, chatId, from };
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  // Two separate lines, like every sibling row: `note` is the standing
  // description of the saved choice, `status` is transient save feedback and
  // is empty unless a save is in flight or just failed.
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [statusState, setStatusState] = useState('');   // '' | 'busy' | 'success' | 'error'
  const [busy, setBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [prompt, setPrompt] = useState('');
  const alive = useRef(true);
  // Authoritative config snapshot for serialized writes, so rapid mode/model/prompt
  // edits never overwrite each other with stale closure state.
  const configRef = useRef({ mode: 'off', providerId: '', modelId: '', prompt: '' });
  const writeChainRef = useRef(Promise.resolve());
  // The debounce for the prompt's autosave. One timer, cleared on unmount, so
  // navigating away never writes a prompt the user had already abandoned.
  const promptTimer = useRef(null);
  useEffect(() => () => {
    alive.current = false;
    if (promptTimer.current) clearTimeout(promptTimer.current);
  }, []);

  // ---- Model bookmarks, exactly as the chat picker and dictation use them ----
  // Pins are a localStorage read (there on the first paint); recents are a
  // server read that arrives a moment later. Both helpers take a state-shaped
  // object because the chat head owns them; this page only supplies the two
  // fields they read, which is cheaper than a second implementation that could
  // drift from theirs.
  const bookmarkStateRef = useRef(null);
  const [pinned, setPinned] = useState(() => new Set());
  const [recent, setRecent] = useState([]);
  function bookmarkState() {
    const state = bookmarkStateRef.current || { props: { projectDir: '' }, recentModels: [] };
    bookmarkStateRef.current = state;
    state.props.projectDir = dir;
    return state;
  }

  useEffect(() => {
    let cancelled = false;
    migrateProjectScopedBookmarks();
    setPinned(loadPinned());
    setRecent(loadRecent(bookmarkState()));
    loadRecentFromServer(bookmarkState()).then((ok) => {
      if (!cancelled && ok) setRecent(loadRecent(bookmarkState()));
    });
    return () => { cancelled = true; };
  }, [dir]);

  function onTogglePin(model) {
    if (!model) return;
    togglePin(model.provider || '', model.id);
    setPinned(loadPinned());
    setRecent(loadRecent(bookmarkState()));
  }

  // loadCatalogs(force) — the project's saved models unioned with every
  // configured provider's live chat catalog. The union is the same one the
  // agent editor builds, so a reviewer can be any model the app can chat with.
  async function loadCatalogs(force = false) {
    setCatalogBusy(true);
    const query = '?projectDir=' + encodeURIComponent(dir || '');
    try {
      const [saved, connections] = await Promise.all([
        fetchJson('/api/ai/models' + query).catch(() => ({ body: {} })),
        fetchJson('/api/ai/models/providers').catch(() => ({ body: {} }))
      ]);
      if (!alive.current) return;
      const rows = (saved.body && saved.body.models) || [];
      const ids = ((connections.body && connections.body.providers) || []).map((p) => p && p.id).filter(Boolean);
      setProviders(ids);
      setCatalogLoaded(true);
      setModels(rows);
      const live = await Promise.all(ids.map(async (provider) => {
        const result = await fetchLiveModels(provider, { force }).catch(() => ({ models: [] }));
        return (result.models || []).map((m) => Object.assign({}, m, { provider }));
      }));
      if (!alive.current) return;
      const union = new Map();
      for (const m of rows.concat(...live)) {
        if (!m || !m.id) continue;
        const key = (m.provider || '') + '\u0000' + m.id;
        if (!union.has(key)) union.set(key, m);
      }
      setModels(Array.from(union.values()));
    } finally {
      if (alive.current) setCatalogBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!dir) { setStatus('Open this page from a project’s settings.'); setStatusState('error'); return; }
      setStatus('Loading…'); setStatusState('busy');
      try {
        const r = await fetchJson('/api/settings/resolved?projectDir=' + encodeURIComponent(dir));
        if (cancelled) return;
        const next = shellReviewFromResolved(r.status === 200 ? r.body.resolved : null);
        configRef.current = next;
        setConfig(next);
        setPrompt(next.prompt || '');
        setNote(stateFor(next));
        setStatus(''); setStatusState('');
      } catch (error) {
        if (!cancelled) {
          setStatus('Cannot load: ' + (error && error.message ? error.message : String(error)));
          setStatusState('error');
        }
      }
    }
    load();
    if (dir) loadCatalogs();
    return () => { cancelled = true; };
  }, [dir]);

  // write(next) — one complete `shellReview` object per save, serialized so
  // rapid mode/model/prompt edits never overwrite each other.
  function write(next) {
    if (!dir) {
      setStatus('Open this page from a project’s settings.');
      setStatusState('error');
      return Promise.resolve(false);
    }
    configRef.current = next;
    writeChainRef.current = writeChainRef.current.then(async () => {
      if (!alive.current) return false;
      const latest = configRef.current;
      setBusy(true);
      setStatus('Saving…'); setStatusState('busy');
      try {
        const r = await fetchJson('/api/settings/project', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectDir: dir,
            shellReview: {
              mode: latest.mode,
              providerId: latest.providerId || '',
              modelId: latest.modelId || '',
              prompt: latest.prompt || ''
            }
          })
        });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        if (!alive.current) return false;
        // Re-derive from the server's echo rather than the local object: a
        // server-side clamp (an unknown mode) then shows up here, not only after
        // a reload.
        const saved = shellReviewFromResolved(r.body && r.body.project);
        configRef.current = Object.assign({}, saved, { prompt: configRef.current.prompt });
        setConfig(saved);
        setNote(stateFor(saved));
        setStatus('Saved'); setStatusState('success');
        return true;
      } catch (error) {
        if (alive.current) {
          setStatus('Not saved: ' + (error && error.message ? error.message : String(error)));
          setStatusState('error');
        }
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    });
    return writeChainRef.current;
  }

  function nextConfig(patch) {
    const base = configRef.current || config || { mode: 'off', providerId: '', modelId: '', prompt: '' };
    const merged = Object.assign({}, base, { prompt }, patch || {});
    merged.configured = merged.mode !== 'off' && !!merged.providerId && !!merged.modelId;
    return merged;
  }

  function onModeChange(e) {
    const mode = e && e.target ? e.target.value : 'off';
    if (!config) return;
    // A closed choice, committed immediately: leaving it unsaved would
    // misreport whether reviews happen at all.
    const next = nextConfig({ mode });
    setConfig(next);
    setNote(stateFor(next));
    write(next);
  }

  // One { providerId, modelId } pair, saved on pick — the same contract every
  // other model control in the app has.
  function onPickModel(selection) {
    if (!config) return;
    const providerId = (selection && selection.providerId) || '';
    const modelId = (selection && selection.modelId) || '';
    // If the user picks a reviewer model while mode is still 'off', switch
    // mode to 'ask' (on demand) so the newly picked model is immediately ready.
    const mode = config.mode === 'off' && providerId && modelId ? 'ask' : config.mode;
    if (providerId && modelId && typeof touchRecent === 'function') {
      touchRecent(bookmarkState(), providerId, modelId);
      setRecent(loadRecent(bookmarkState()));
    }
    const next = nextConfig({ mode, providerId, modelId });
    setConfig(next);
    setNote(stateFor(next));
    write(next);
  }

  // The prompt saves as you type, debounced: it is free text, and a PUT per
  // keystroke would rewrite the project file dozens of times for one sentence
  // (the same rule the agent editor's instructions follow).
  function onPromptInput(value) {
    setPrompt(value);
    configRef.current = Object.assign({}, configRef.current, { prompt: value });
    if (promptTimer.current) clearTimeout(promptTimer.current);
    promptTimer.current = setTimeout(() => {
      promptTimer.current = null;
      if (alive.current) write(nextConfig({ prompt: value }));
    }, 600);
  }

  const selection = config && config.modelId
    ? { providerId: config.providerId || (models.find((m) => m && m.id === config.modelId) || {}).provider || '', modelId: config.modelId }
    : null;
  const noProviders = catalogLoaded && providers.length === 0 && models.length === 0;
  const providerUnknown = !!(config && config.providerId) && catalogLoaded && providers.length > 0
    && !providers.includes(config.providerId);
  const back = backTarget(context);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref(context), class: 'view-back', 'aria-label': back.label }, '←'),
      h('h2', { class: 'view-title' }, 'Shell review')
    ),
    h('section', { class: 'settings-project' },
      h('p', { class: 'settings-project__lede' },
        'A second model reads a shell command before you approve it and reports what it would do. It never runs, approves or changes anything — the normal approval card still decides whether a command runs.'),

      // ---- When -----------------------------------------------------------
      // The same settings row idiom as Settings → Project → File tool options:
      // a `.group__list` of `.settings-project__item` cards, each with a bold
      // title, a note, an optional status line, and its control. The page used
      // to nest the generic `.row` inside its own padded wrapper, which indented
      // every control twice and shrank the labels to 0.72 rem — it read as a
      // different app next to the pages beside it.
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('tools'),
          h('span', null, 'When to review'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About the review modes' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Off never reviews. On demand reviews only the command you ask about from the chat’s tool menu. Always reviews every shell command the assistant proposes, before its approval card is answered — each review is a separate request on the chosen model’s account.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sr-mode' }, 'Mode'),
              h('div', { class: 'settings-project__item-note' }, note || 'When a proposed shell command is sent to the reviewer.'),
              status
                ? h('div', {
                  class: 'settings-project__item-status',
                  'data-state': statusState || undefined,
                  role: 'status',
                  'aria-live': 'polite'
                }, status)
                : null
            ),
            h('select', {
              class: 'input settings-project__select',
              id: 'sr-mode',
              value: config ? config.mode : 'off',
              disabled: !config || busy,
              onChange: onModeChange
            }, SHELL_REVIEW_MODES.map((m) => h('option', { key: m.value, value: m.value }, m.label)))
          )
        )
      ),

      // ---- Model ----------------------------------------------------------
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('general'),
          h('span', null, 'Review model'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About the review model' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'The model that reviews. It is independent of the chat’s model: pick a cheaper or a stricter one.'),
              h('p', null, 'There is no default — a review is a request on your account, so nothing is sent until a model is picked. The list is your project’s models plus every configured provider’s live catalog, with the same pinned and recent rows as the chat’s model picker.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-main' },
              h('span', { class: 'settings-project__item-title' }, 'Model'),
              h('div', { class: 'settings-project__item-note' }, 'A review is a request on this model’s account. Mode Off means no reviewer.')
            ),
            // Full width, on its own line: the picker's two-line trigger needs
            // the room a long model id takes, and putting it beside the title on
            // a 360 px phone only ellipsized it.
            h(ModelPickerField, {
            className: 'settings-project__shell-review-model',
            models,
            extraProviders: providers,
            noProviders,
            variant: 'sheet',
            value: selection,
            // No clear row: a review without a model is not a state anyone
            // wants, and the mode's Off already means "no reviewer".
            placeholder: catalogBusy ? 'Loading models…' : (noProviders ? 'No providers connected' : 'Pick a model'),
            ariaLabel: 'Model that reviews shell commands',
            disabled: !config || busy,
            pinned,
            onTogglePin,
            recent,
            refresh: () => loadCatalogs(true),
            refreshEmpty: 'Refresh models',
            onChange: onPickModel,
            onOpen: () => {
            loadRecentFromServer(bookmarkState()).then((ok) => {
            if (alive.current && ok) setRecent(loadRecent(bookmarkState()));
            });
            }
            }),
            noProviders
            ? h('a', { class: 'btn settings-project__shell-review-providers-link', href: '#/settings/providers' },
            'Open Providers settings')
            : null,
            providerUnknown
            ? h('div', { class: 'settings-project__item-note settings-project__shell-review-warn', role: 'status' },
            'The saved model is on “' + config.providerId + '”, which has no connection any more — reviews will fail until it is added back in Settings → Providers.')
            : null
          )
        )
      ),

      // ---- Prompt ---------------------------------------------------------
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('chat'),
          h('span', null, 'Prompt'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About the review prompt' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'What the reviewer is asked, sent as its system message. Leave it blank to use the built-in instruction: describe the effects, then answer with one verdict line — SAFE, CAUTION or DANGER.'),
              h('p', null, 'The chat’s review sheet can edit the prompt for one run without saving it here.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sr-prompt' }, 'Review prompt'),
              h('div', { class: 'settings-project__item-note' }, 'Saved automatically as you type. Blank uses the built-in instruction.')
            ),
            h('textarea', {
              class: 'input settings-project__mono settings-project__shell-review-prompt',
              id: 'sr-prompt',
              rows: 6,
              spellcheck: false,
              placeholder: 'Built-in prompt: describe the effects, then answer SAFE, CAUTION or DANGER. Leave blank to use it.',
              value: prompt,
              disabled: !config,
              onInput: (e) => onPromptInput(e.currentTarget.value),
              'aria-label': 'Prompt the reviewer receives'
            })
          )
        )
      ),

      // ---- Where the verdict appears --------------------------------------
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('more'),
          h('span', null, 'Where the verdict appears')
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-main' },
              h('div', { class: 'settings-project__item-title' }, 'Approval card'),
              h('div', { class: 'settings-project__item-note' }, 'A Second opinion block above the decision buttons, as soon as the review lands — a reload still shows it.')
            )
          ),
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-main' },
              h('div', { class: 'settings-project__item-title' }, 'Chat tool menu'),
              h('div', { class: 'settings-project__item-note' }, 'Review a command opens a sheet seeded with the composer draft, sends only that text, and never runs it.')
            )
          )
        ),
        h('a', {
          class: 'group__row settings-project__link-row',
          href: settingsLink('settings/project', context),
          'aria-label': 'Back to project settings'
        },
          h('span', { class: 'group__row-body' },
            h('span', { class: 'group__row-label' }, 'Project settings'),
            h('span', { class: 'settings-project__link-sub' }, 'Tools, agents, and the rest of this project')
          ),
          h('span', { class: 'group__row-chev', 'aria-hidden': 'true' }, '›')
        )
      )
    )
  );
}
