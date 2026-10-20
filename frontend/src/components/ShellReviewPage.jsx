// mouaif web — Settings → Project → Shell review (its own page)
//
// The configuration page for shell review (docs/features/shell-review.md): a
// second model reads a shell command before it is approved and reports its
// effects with a SAFE / CAUTION / DANGER verdict.
//
// It is a page rather than a section of Project settings because it has four
// real inputs (mode, provider, model id, prompt) plus a connection check, and
// the project page is a scrolling list of one-line rows — a picker alone there
// left no way to name a provider and a model id explicitly. This page gives
// both: the catalog picker for browsing, and plain provider + model id fields
// for the model you already know the id of (a live-catalog model, a local
// llama.cpp alias, an Azure deployment).
//
// Everything writes the same project value, `shellReview`, as one complete
// object per save: the server stores it as one value, so a partial write would
// be a read-modify-write with no guarantee both halves came from the same
// snapshot. Text fields debounce; the mode, provider and model-id change
// commits on blur or with the Save button, so a half-typed id is never saved.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson, fetchLiveModels, activeProject } from '../api.js';
import { ModelPickerField } from './ModelPickerField.jsx';
import { sectionIcon } from './settingsProjectUi.js';
import { settingsLink, backHref, backTarget } from './settings/projectNavigation.js';
import { SHELL_REVIEW_MODES, shellReviewFromResolved } from './chat/shellReview.js';

// statusFor(saved) -> the one-line summary under the controls. It names the
// consequence of the current choice instead of echoing the fields: "off" means
// nothing is sent, a half-configured review means nothing is sent either, and a
// complete one names the model that will be asked.
function statusFor(saved) {
  if (!saved) return '';
  if (saved.mode === 'off') return 'Off — no command is sent to another model.';
  if (!saved.configured) {
    return 'No review is sent yet: pick a provider and a model id, then save.';
  }
  const when = saved.mode === 'always'
    ? 'every shell command is reviewed before you approve it'
    : 'reviews happen only from the chat’s Review a command button';
  return 'Reviews go to ' + saved.providerId + ' · ' + saved.modelId + ' — ' + when + '.';
}

export function ShellReviewPageView({ projectDir = '', from = '', chatId = '' } = {}) {
  const dir = projectDir || (activeProject.value && activeProject.value.dir) || '';
  const context = { projectDir: dir, chatId, from };
  const [config, setConfig] = useState(null);
  const [providers, setProviders] = useState([]);      // configured connection ids
  const [catalog, setCatalog] = useState([]);          // live rows for the picked provider
  const [projectModels, setProjectModels] = useState([]);
  const [status, setStatus] = useState('Loading…');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  // The three text/number-free inputs are edited locally and committed on
  // blur / Save, so the page never persists a half-typed model id.
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dirty, setDirty] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!dir) { setStatus('Open this page from a project’s settings.'); return; }
      setStatus('Loading…');
      try {
        const query = '?projectDir=' + encodeURIComponent(dir);
        const [resolved, connections, saved] = await Promise.all([
          fetchJson('/api/settings/resolved' + query),
          fetchJson('/api/ai/models/providers').catch(() => ({ body: {} })),
          fetchJson('/api/ai/models' + query).catch(() => ({ body: {} }))
        ]);
        if (cancelled) return;
        const next = shellReviewFromResolved(resolved.status === 200 ? resolved.body.resolved : null);
        setConfig(next);
        setProviderId(next.providerId || '');
        setModelId(next.modelId || '');
        setPrompt(next.prompt || '');
        setDirty(false);
        setStatus(statusFor(next));
        setProviders(((connections.body && connections.body.providers) || []).map((p) => p && p.id).filter(Boolean));
        setProjectModels((saved.body && saved.body.models) || []);
      } catch (error) {
        if (!cancelled) setStatus('Cannot load: ' + (error && error.message ? error.message : String(error)));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [dir]);

  // The live catalog for the chosen provider, so the model-id field can
  // suggest real ids. A provider that cannot answer contributes nothing — the
  // free-text field still works, which is the point of having one.
  useEffect(() => {
    let cancelled = false;
    setCatalog([]);
    if (!providerId) return () => { cancelled = true; };
    fetchLiveModels(providerId, { purpose: 'chat' })
      .then((result) => { if (!cancelled && result && Array.isArray(result.models)) setCatalog(result.models); })
      .catch(() => { /* the field stays free-text */ });
    return () => { cancelled = true; };
  }, [providerId]);

  // write(next) — one complete `shellReview` object per save.
  async function write(next) {
    if (!dir) { setStatus('Open this page from a project’s settings.'); return false; }
    setBusy(true);
    setStatus('Saving…');
    try {
      const r = await fetchJson('/api/settings/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectDir: dir,
          shellReview: {
            mode: next.mode,
            providerId: next.providerId || '',
            modelId: next.modelId || '',
            prompt: next.prompt || ''
          }
        })
      });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      if (!alive.current) return false;
      // Re-derive from the server's echo rather than the local object: a
      // server-side clamp (an unknown mode) then shows up here, not only after
      // a reload.
      const saved = shellReviewFromResolved(r.body && r.body.project);
      setConfig(saved);
      setPrompt(saved.prompt || '');
      setDirty(false);
      setStatus(statusFor(saved));
      return true;
    } catch (error) {
      if (alive.current) setStatus('Not saved: ' + (error && error.message ? error.message : String(error)));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function nextConfig(patch) {
    const base = config || { mode: 'off', providerId: '', modelId: '', prompt: '' };
    return Object.assign({}, base, { providerId, modelId, prompt }, patch || {});
  }

  function onModeChange(e) {
    const mode = e && e.target ? e.target.value : 'off';
    if (!config) return;
    // The mode is the one control that is safe to commit immediately: it is a
    // closed choice, and leaving it unsaved would misreport whether reviews
    // happen at all.
    setConfig(Object.assign({}, config, { mode }));
    write(nextConfig({ mode }));
  }

  function commitFields() {
    if (!config) return Promise.resolve(false);
    return write(nextConfig());
  }

  // The catalog picker sets both halves at once (a live row carries its
  // provider), which is the fast path; the two fields below are the explicit
  // path for an id the catalog does not list.
  function onPickerPick(selection) {
    if (!selection) {
      setProviderId('');
      setModelId('');
      setDirty(true);
      setCheckResult(null);
      return;
    }
    setProviderId(selection.providerId || '');
    setModelId(selection.modelId || '');
    setDirty(true);
    setCheckResult(null);
    if (config) {
      write(nextConfig({ providerId: selection.providerId || '', modelId: selection.modelId || '' }));
    }
  }

  // checkModel() — POST /api/ai/test against the named model. A second model is
  // a second account: "is this connection actually usable?" is worth one cheap
  // request before every command in the project starts paying for reviews.
  async function checkModel() {
    if (!providerId || !modelId || checking) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await fetchJson('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: dir, modelId, providerId })
      });
      const ok = r.status === 200 && r.body && r.body.ok === true;
      setCheckResult({
        ok,
        text: ok ? 'Model answered.' : ('No answer: ' + ((r.body && (r.body.error || r.body.code)) || ('HTTP ' + r.status)))
      });
    } catch (error) {
      setCheckResult({ ok: false, text: 'No answer: ' + (error && error.message ? error.message : String(error)) });
    } finally {
      if (alive.current) setChecking(false);
    }
  }

  const pickerModels = projectModels.concat(catalog.map((m) => Object.assign({}, m, { provider: providerId })));
  const selection = modelId ? { providerId, modelId } : null;
  const providerUnknown = !!providerId && providers.length > 0 && !providers.includes(providerId);
  const back = backTarget(context);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: backHref(context), class: 'view-back', 'aria-label': back.label }, '←'),
      h('h2', { class: 'view-title' }, 'Shell review')
    ),
    h('section', { class: 'settings-project settings-project--shell-review' },
      h('p', { class: 'settings-project__lede' },
        'A second model reads a shell command before you approve it and reports what it would do. It never runs, approves or changes anything — the normal approval card still decides whether a command runs.'),

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
        h('div', { class: 'settings-project__shell-review' },
          h('div', { class: 'row' },
            h('label', { class: 'label', for: 'sr-mode' }, 'Mode'),
            h('select', {
              class: 'input settings-project__select',
              id: 'sr-mode',
              value: config ? config.mode : 'off',
              disabled: !config || busy,
              onChange: onModeChange
            }, SHELL_REVIEW_MODES.map((m) => h('option', { key: m.value, value: m.value }, m.label)))
          ),
          h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, status)
        )
      ),

      h('div', { class: 'group settings-project__section' },
        h('div', { class: 'group__title settings-project__section-title' },
          sectionIcon('general'),
          h('span', null, 'Review model'),
          h('details', { class: 'settings-project__info' },
            h('summary', { 'aria-label': 'About the review model' }, '?'),
            h('div', { class: 'settings-project__info-body' },
              h('p', null, 'The model that reviews. It is independent of the chat’s model: pick a cheaper or a stricter one. There is no default — a review is a request on your account, so nothing is sent until you name a provider and a model id here.'),
              h('p', null, 'A model that is not in the project’s list still works when its provider connection is configured: type its id, or pick it from the provider’s live catalog.')
            )
          )
        ),
        h('div', { class: 'settings-project__shell-review' },
          h('div', { class: 'row' },
            h('span', { class: 'label' }, 'Browse catalog'),
            h(ModelPickerField, {
              models: pickerModels,
              extraProviders: providers,
              variant: 'sheet',
              value: selection,
              allowClear: true,
              clearLabel: 'No reviewer',
              placeholder: 'Pick a model',
              ariaLabel: 'Pick the model that reviews shell commands',
              disabled: !config || busy,
              onChange: onPickerPick
            })
          ),
          h('div', { class: 'row' },
            h('label', { class: 'label', for: 'sr-provider' }, 'Provider'),
            h('select', {
              class: 'input settings-project__select',
              id: 'sr-provider',
              value: providerId,
              disabled: !config || busy,
              onChange: (e) => { setProviderId(e.currentTarget.value); setDirty(true); setCheckResult(null); }
            },
              h('option', { value: '' }, '— pick a provider —'),
              // A provider the connection list no longer carries stays
              // selectable so the page never silently rewrites the stored id.
              providerId && !providers.includes(providerId)
                ? h('option', { key: providerId, value: providerId }, providerId + ' (not configured)')
                : null,
              providers.map((id) => h('option', { key: id, value: id }, id))
            )
          ),
          h('div', { class: 'row' },
            h('label', { class: 'label', for: 'sr-model' }, 'Model id'),
            h('input', {
              class: 'input settings-project__mono',
              id: 'sr-model',
              type: 'text',
              autocomplete: 'off',
              autocapitalize: 'off',
              spellcheck: false,
              enterkeyhint: 'done',
              placeholder: catalog.length ? 'e.g. ' + catalog[0].id : 'the provider’s model id',
              value: modelId,
              list: 'sr-model-suggestions',
              disabled: !config || busy,
              onInput: (e) => { setModelId(e.currentTarget.value); setDirty(true); setCheckResult(null); },
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } },
              onBlur: () => { if (dirty) commitFields(); }
            }),
            // The id field suggests this provider's live catalog. A provider
            // that could not answer leaves the field free-text rather than
            // empty-looking.
            h('datalist', { id: 'sr-model-suggestions' },
              catalog.slice(0, 500).map((m) => h('option', { key: m.id, value: m.id }))
            )
          ),
          providerUnknown
            ? h('p', { class: 'hint hint--compact settings-project__shell-review-warn', role: 'status' },
              'No connection is configured for “' + providerId + '”, so reviews will fail until one is added in Settings → Providers.')
            : null,
          h('div', { class: 'row row--actions' },
            h('button', {
              class: 'btn btn--primary',
              type: 'button',
              onClick: () => commitFields(),
              disabled: !config || busy || !dirty
            }, busy ? 'Saving…' : 'Save model'),
            h('button', {
              class: 'btn',
              type: 'button',
              onClick: checkModel,
              disabled: !config || checking || !providerId || !modelId,
              'aria-busy': checking ? 'true' : 'false'
            }, checking ? 'Checking…' : 'Check model'),
            checkResult
              ? h('span', {
                class: 'settings-project__item-status',
                'data-state': checkResult.ok ? 'success' : 'error',
                role: 'status'
              }, checkResult.text)
              : null
          )
        )
      ),

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
        h('div', { class: 'settings-project__shell-review' },
          h('textarea', {
            class: 'input settings-project__mono',
            id: 'sr-prompt',
            rows: 6,
            spellcheck: false,
            placeholder: 'Built-in prompt: describe the effects, then answer SAFE, CAUTION or DANGER. Leave blank to use it.',
            value: prompt,
            disabled: !config || busy,
            onInput: (e) => { setPrompt(e.currentTarget.value); setDirty(true); },
            'aria-label': 'Prompt the reviewer receives'
          }),
          h('div', { class: 'row row--actions' },
            h('button', {
              class: 'btn',
              type: 'button',
              onClick: () => commitFields(),
              disabled: !config || busy || !dirty
            }, 'Save prompt'),
            h('span', { class: 'hint hint--compact' }, 'Saved with the mode and model: one project value, one write.')
          )
        )
      ),

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
