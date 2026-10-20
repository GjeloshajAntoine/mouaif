// mouaif web — Settings → Project → Shell review
//
// The configuration half of shell review (docs/features/shell-review.md): pick
// the second model, choose when it is asked, and write the prompt it receives.
// The behaviour half lives on the server (src/shellReview.js) and in the chat
// (the tool popup's review sheet and the approval card's verdict block).
//
// Three controls, in the order a user needs them:
//
//   1. **When** — off / on demand / always. `on demand` is the safe way to try
//      it: a review costs a request, so nothing is sent until the user taps the
//      Review button in the chat. `always` reviews every shell command before
//      its approval card is answered.
//   2. **Model** — the same provider-qualified picker the subagent defaults use
//      (`ModelPickerField`), over the project models plus every configured
//      provider's live catalog. There is no default reviewer: silently using the
//      chat's model would spend a budget the user did not choose, so the
//      section says so until one is picked.
//   3. **Prompt** — what the reviewer is asked, saved with the same control. The
//      default is spelled out in the placeholder so an empty field still reads
//      as "the built-in instruction", and the chat's review sheet can edit it
//      for one run without saving.
//
// Everything auto-saves on change, like the rest of project settings. The whole
// block is written as one `shellReview` object each time, because the server
// stores it as one value: a partial write would be a read-modify-write on the
// client with no guarantee the two halves came from the same snapshot.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, fetchLiveModels } from '../../api.js';
import { ModelPickerField } from '../ModelPickerField.jsx';
import { SHELL_REVIEW_MODES, shellReviewFromResolved } from '../chat/shellReview.js';

export function ShellReviewSettings({ projectDir, onProjectSaved }) {
  const [config, setConfig] = useState(null);
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const [status, setStatus] = useState('Loading…');
  const [saving, setSaving] = useState(false);
  // The prompt is edited locally and saved on blur / with its own button: a
  // PUT per keystroke would rewrite .mouaif.json dozens of times for one
  // sentence, and a debounce would still race the mode/model writes.
  const [prompt, setPrompt] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setConfig(null);
      const query = '?projectDir=' + encodeURIComponent(projectDir || '');
      try {
        const [resolved, saved, connections] = await Promise.all([
          fetchJson('/api/settings/resolved' + query),
          fetchJson('/api/ai/models' + query).catch(() => ({ body: {} })),
          fetchJson('/api/ai/models/providers').catch(() => ({ body: {} }))
        ]);
        if (cancelled) return;
        const next = shellReviewFromResolved(resolved.status === 200 ? resolved.body.resolved : null);
        setConfig(next);
        setPrompt(next.prompt || '');
        setPromptDirty(false);
        setStatus(next.mode === 'off'
          ? 'Off — no command is sent to another model.'
          : (next.configured
            ? 'Reviews go to ' + next.providerId + ' · ' + next.modelId
            : 'Pick a model below — until then no review is sent.'));
        const ids = (connections.body.providers || []).map((p) => p && p.id).filter(Boolean);
        setProviders(ids);
        setModels(saved.body.models || []);
        const catalogs = await Promise.all(ids.map(async (provider) => {
          const groups = await Promise.all(['chat'].map((purpose) =>
            fetchLiveModels(provider, { purpose }).catch(() => ({ models: [] }))));
          return groups.flatMap((group) => (group.models || []).map((model) => ({ ...model, provider })));
        }));
        if (!cancelled) setModels([...(saved.body.models || []), ...catalogs.flat()]);
      } catch (error) {
        if (!cancelled) setStatus('Cannot load: ' + (error.message || String(error)));
      }
    }
    if (projectDir) load();
    return () => { cancelled = true; };
  }, [projectDir]);

  // write(next) — save the whole `shellReview` block. `next` is the complete
  // object; callers merge the field they changed into the loaded config, so the
  // three controls can never clear each other.
  async function write(next) {
    if (!projectDir || !next) return;
    setSaving(true);
    setStatus('Saving…');
    try {
      const r = await fetchJson('/api/settings/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectDir,
          shellReview: {
            mode: next.mode,
            providerId: next.providerId || '',
            modelId: next.modelId || '',
            prompt: next.prompt || ''
          }
        })
      });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      if (!alive.current) return;
      const saved = shellReviewFromResolved(r.body && r.body.project);
      // The response echoes the saved project; re-derive rather than trusting
      // the local object, so a server-side clamp (an unknown mode) shows up.
      setConfig(saved);
      setStatus(saved.mode === 'off'
        ? 'Off — no command is sent to another model.'
        : (saved.configured ? 'Saved. Reviews go to ' + saved.providerId + ' · ' + saved.modelId : 'Saved — pick a model to start reviewing.'));
      if (onProjectSaved && r.body && r.body.project) onProjectSaved(r.body.project);
    } catch (error) {
      if (alive.current) setStatus('Not saved: ' + (error.message || String(error)));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  function pickMode(e) {
    const mode = e && e.target ? e.target.value : 'off';
    if (!config) return;
    write(Object.assign({}, config, { mode }));
  }

  function pickModel(selection) {
    if (!config) return;
    write(Object.assign({}, config, {
      providerId: selection ? selection.providerId : '',
      modelId: selection ? selection.modelId : ''
    }));
  }

  function savePrompt() {
    if (!config) return;
    write(Object.assign({}, config, { prompt })).then(() => { if (alive.current) setPromptDirty(false); });
  }

  return h('div', { class: 'settings-project__shell-review' },
    h('div', { class: 'row' },
      h('label', { class: 'label', for: 'sp-shell-review-mode' }, 'When'),
      h('select', {
        class: 'input settings-project__select',
        id: 'sp-shell-review-mode',
        value: config ? config.mode : 'off',
        disabled: !config || saving,
        onChange: pickMode
      },
        SHELL_REVIEW_MODES.map((m) => h('option', { key: m.value, value: m.value }, m.label))
      )
    ),
    h('div', { class: 'row' },
      h('span', { class: 'label' }, 'Model'),
      h(ModelPickerField, {
        models,
        extraProviders: providers,
        variant: 'sheet',
        value: config && config.modelId ? { modelId: config.modelId, providerId: config.providerId } : null,
        allowClear: true,
        clearLabel: 'No reviewer',
        ariaLabel: 'Model that reviews shell commands',
        disabled: !config || saving,
        onChange: pickModel
      })
    ),
    h('label', { class: 'label', for: 'sp-shell-review-prompt' }, 'Prompt'),
    h('textarea', {
      class: 'input settings-project__mono',
      id: 'sp-shell-review-prompt',
      rows: 4,
      spellcheck: false,
      placeholder: 'Built-in prompt: describe the effects, then answer SAFE, CAUTION or DANGER. Leave blank to use it.',
      value: prompt,
      disabled: !config || saving,
      onInput: (e) => { setPrompt(e.currentTarget.value); setPromptDirty(true); }
    }),
    h('div', { class: 'row row--actions' },
      h('button', {
        class: 'btn',
        type: 'button',
        onClick: savePrompt,
        disabled: !config || saving || !promptDirty
      }, 'Save prompt'),
      h('span', { class: 'status', 'aria-live': 'polite' }, status)
    ),
    h('p', { class: 'hint hint--compact' },
      'The reviewer only reads the command and reports what it would do. It cannot approve, run or change anything: the normal authorization prompt still decides whether a command runs.')
  );
}
