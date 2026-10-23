// mouaif web — Settings → Project → Shell review (its own page)
//
// The configuration page for shell review (docs/features/shell-review.md):
// the same model as the rest of the app reads a shell command when the CLI is
// set to Ask, reports its effects with a SAFE / CAUTION / DANGER verdict, and
// auto-allows SAFE commands to run without waiting for a manual tap.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, fetchLiveModels, activeProject } from '../api.js';
import { ModelPickerField } from './ModelPickerField.jsx';
import { ThinkingSelectField } from './ThinkingSelectField.jsx';
import { loadPinned, loadRecent, loadRecentFromServer, touchRecent, togglePin } from './chat/modelPicker.js';
import { sectionIcon } from './settingsProjectUi.js';
import { settingsLink, backHref, backTarget } from './settings/projectNavigation.js';
import { SHELL_REVIEW_MODES, shellReviewFromResolved } from './chat/shellReview.js';

// stateFor(saved) -> the row's standing description of the current choice.
//
// This is a NOTE, never a status message: `.settings-project__item-note` is the
// neutral grey line under a row's title, while `.settings-project__item-status`
// is the green/red line that means "just saved" / "save failed".
function stateFor(saved) {
  if (!saved) return '';
  if (saved.mode === 'off') return 'Off — commands are not reviewed.';
  const modelLabel = saved.providerId && saved.modelId
    ? (saved.providerId + ' · ' + saved.modelId)
    : 'the chat’s current model';
  if (saved.mode === 'always') {
    const autoDesc = saved.autoAllow !== false
      ? 'SAFE commands auto-run when CLI is set to Ask; CAUTION and DANGER still wait for approval'
      : 'every shell command is reviewed before you approve it';
    return 'Reviewed by ' + modelLabel + ' — ' + autoDesc + '.';
  }
  return 'Reviewed by ' + modelLabel + ' — only from the chat’s Review a command button.';
}

export function ShellReviewPageView({ projectDir = '', from = '', chatId = '' } = {}) {
  const dir = projectDir || (activeProject.value && activeProject.value.dir) || '';
  const context = { projectDir: dir, chatId, from };
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const bookmarks = useRef({ recentModels: [] });
  const [pinned, setPinned] = useState(() => loadPinned());
  const [recent, setRecent] = useState(() => loadRecent(bookmarks.current));
  async function refreshModels() {
    const catalogs = await Promise.all(providers.map(async provider => {
      const catalog = await fetchLiveModels(provider, { purpose: 'chat', force: true });
      if (catalog.error) throw new Error(catalog.error);
      return (catalog.models || []).map(model => ({ ...model, provider }));
    }));
    if (alive.current) setModels(current => [
      ...current.filter(model => !providers.includes(model.provider)), ...catalogs.flat()
    ]);
  }
  function refreshRecent() {
    let cancelled = false;
    loadRecentFromServer(bookmarks.current).then(updated => {
      if (!cancelled && updated) setRecent(loadRecent(bookmarks.current));
    });
    return () => { cancelled = true; };
  }
  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      const [saved, connections] = await Promise.all([
        fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(dir)).catch(() => ({ body: {} })),
        fetchJson('/api/ai/models/providers').catch(() => ({ body: {} }))
      ]);
      if (cancelled) return;
      const ids = (connections.body.providers || []).map(provider => provider.id).filter(Boolean);
      setProviders(ids);
      setModels(saved.body.models || []);
      const catalogs = await Promise.all(ids.map(async provider => {
        const catalog = await fetchLiveModels(provider, { purpose: 'chat' }).catch(() => ({ models: [] }));
        return (catalog.models || []).map(model => ({ ...model, provider }));
      }));
      if (!cancelled) setModels([...(saved.body.models || []), ...catalogs.flat()]);
    }
    loadModels();
    return () => { cancelled = true; };
  }, [dir]);
  // Two separate lines, like every sibling row: `note` is the standing
  // description of the saved choice, `status` is transient save feedback and
  // is empty unless a save is in flight or just failed.
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [statusState, setStatusState] = useState('');   // '' | 'busy' | 'success' | 'error'
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const alive = useRef(true);
  // Authoritative config snapshot for serialized writes, so rapid mode/prompt
  // edits never overwrite each other with stale closure state.
  const configRef = useRef({ mode: 'off', providerId: '', modelId: '', prompt: '', autoAllow: true });
  const writeChainRef = useRef(Promise.resolve());
  // The debounce for the prompt's autosave. One timer, cleared on unmount, so
  // navigating away never writes a prompt the user had already abandoned.
  const promptTimer = useRef(null);
  useEffect(() => () => {
    alive.current = false;
    if (promptTimer.current) clearTimeout(promptTimer.current);
  }, []);

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
    return () => { cancelled = true; };
  }, [dir]);

  // write(next) — one complete `shellReview` object per save, serialized so
  // rapid mode/autoAllow/prompt edits never overwrite each other.
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
        const payload = {
          mode: latest.mode,
          prompt: latest.prompt || '',
          autoAllow: latest.autoAllow !== false
        };
        if (latest.providerId) payload.providerId = latest.providerId;
        if (latest.modelId) payload.modelId = latest.modelId;
        if (latest.thinkingLevel) payload.thinkingLevel = latest.thinkingLevel;
        const r = await fetchJson('/api/settings/project', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectDir: dir,
            shellReview: payload
          })
        });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        if (!alive.current) return false;
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
    const base = configRef.current || config || { mode: 'off', providerId: '', modelId: '', prompt: '', autoAllow: true };
    const merged = Object.assign({}, base, { prompt }, patch || {});
    merged.configured = merged.mode !== 'off';
    return merged;
  }

  function onModeChange(e) {
    const mode = e && e.target ? e.target.value : 'off';
    if (!config) return;
    const next = nextConfig({ mode });
    setConfig(next);
    setNote(stateFor(next));
    write(next);
  }

  function onAutoAllowChange(e) {
    const autoAllow = !!(e && e.target && e.target.checked);
    if (!config) return;
    const next = nextConfig({ autoAllow });
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

  const back = backTarget(context);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref(context), class: 'view-back', 'aria-label': back.label }, '←'),
      h('h2', { class: 'view-title' }, 'Shell review')
    ),
    h('section', { class: 'settings-project' },
      h('p', { class: 'settings-project__lede' },
        'Choose a reviewer, customize its prompt, and optionally auto-approve SAFE shell commands. CAUTION and DANGER still need your approval.'),

      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' }, 'Review model'),
        h('ul', { class: 'group__list' },
        h('li', { class: 'settings-project__item settings-project__item--col' },
        h(ModelPickerField, {
        models, extraProviders: providers, variant: 'chat',
        pinned, recent, onOpen: refreshRecent,
        onTogglePin: model => {
        togglePin(model.provider, model.id);
        setPinned(loadPinned());
        setRecent(loadRecent(bookmarks.current));
        },
        refresh: refreshModels,
        refreshEmpty: 'Refresh models',
        value: config && config.modelId ? { providerId: config.providerId, modelId: config.modelId } : null,
        allowClear: true, clearLabel: 'Same as the chat',
        ariaLabel: 'Review model', disabled: !config || busy,
              onChange: selection => {
                if (selection && selection.providerId && selection.modelId) {
                  touchRecent(bookmarks.current, selection.providerId, selection.modelId);
                  setRecent(loadRecent(bookmarks.current));
                }
                const next = nextConfig({ providerId: selection ? selection.providerId : '', modelId: selection ? selection.modelId : '' });
          setConfig(next);
          setNote(stateFor(next));
          write(next);
        }
        },
        h('div', { class: 'settings-project__item settings-project__item--col' },
        h('span', { class: 'settings-project__item-title' }, 'Thinking / reasoning'),
        h(ThinkingSelectField, {
          value: config ? config.thinkingLevel : '',
          descriptor: models.find(model => config && model.id === config.modelId && model.provider === config.providerId)?.thinking,
          inheritLabel: 'Model default',
          ariaLabel: 'Review thinking level',
          disabled: !config || busy,
          onChange: thinkingLevel => {
            const next = nextConfig({ thinkingLevel });
            setConfig(next);
            write(next);
          }
          })
          )
          )
          )
          )
          ),

      // ---- When & Auto-allow ----------------------------------------------
      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('tools'),
          h('span', null, 'When to review'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About the review modes' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'Uses your chosen reviewer, or the chat’s active model. Off never reviews. On demand reviews only from the chat’s Review a command button. Always reviews every shell command when the CLI is set to Ask and can auto-allow SAFE commands.')
            )
          )
        ),
        h('ul', { class: 'group__list' },
          h('li', { class: 'settings-project__item settings-project__item--col' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sr-mode' }, 'Mode'),
              h('div', { class: 'settings-project__item-note' }, note || 'When a proposed shell command is reviewed.'),
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
          ),
          h('li', { class: 'settings-project__item' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sr-auto-allow' }, 'Auto-allow SAFE commands when CLI is on Ask'),
              h('div', { class: 'settings-project__item-note' }, 'When a reviewed command answers SAFE, run it automatically without waiting on the Ask prompt. CAUTION and DANGER still wait for your approval.')
            ),
            h('input', {
              type: 'checkbox',
              id: 'sr-auto-allow',
              checked: config ? config.autoAllow !== false : true,
              disabled: !config || busy,
              onChange: onAutoAllowChange,
              'aria-label': 'Auto-allow SAFE commands when CLI is on Ask'
            })
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
              h('p', null, 'What the model is asked when reviewing a command. Leave it blank to use the built-in instruction: describe the effects, then answer with one verdict line — SAFE, CAUTION or DANGER.'),
              h('p', null, 'Commands that answer SAFE are auto-allowed when CLI is set to Ask (if Auto-allow is enabled above).')
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
              h('div', { class: 'settings-project__item-title' }, 'Approval & shell card'),
              h('div', { class: 'settings-project__item-note' }, 'Shows the verdict on the card; when SAFE auto-allows the command, it runs immediately and attaches the review to the shell card.')
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
