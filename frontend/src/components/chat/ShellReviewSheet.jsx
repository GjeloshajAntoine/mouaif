// mouaif web — Shell review sheet
//
// A full-screen sheet (shared .gm__overlay / .gm__sheet idiom) that asks a
// SECOND model what a command does before it runs. It opens from the composer
// tool popup's "Review a command" row, or from the File toolbar's CLI entry
// explains nothing — the review is a chat-side action, so the popup is home.
//
// What it is for: the shell tool's authorization card asks *the user* whether
// a command may run. On a phone a short `rm -rf dist .env` is easy to approve
// and hard to read. This sheet sends one command to a model the user picked and
// shows the answer — nothing else:
//
//   * the command field is a draft. Typing in it never sends anything; the
//     Review button is the only request, and the reviewed command is never
//     run by this sheet;
//   * the model is the project's configured reviewer (Settings → Project →
//     Shell review). When no reviewer is configured the sheet says so and
//     links straight to that page instead of silently using the chat's model;
//   * the prompt is the project's review prompt, editable here. Saving it
//     writes `shellReview.prompt` to the project (one small PUT), so a wording
//     that works on your codebase is reused next time;
//   * the verdict renders in the same block the approval card uses
//     (./shellReview.js buildReviewBlock), so a review reads identically
//     whether it came from this sheet or from an automatic one.
//
// Mobile-first: one column, the command area grows to about a third of the
// viewport, the verdict scrolls under it, and every control is a 44 px target
// inside the safe area (the sheet shell provides the whole-viewport layout and
// Escape/Tab handling through useModal).
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { settingsLink } from '../settings/projectNavigation.js';
import { shellReviewFromResolved, buildReviewBlock } from './shellReview.js';

// reviewStatusLine(result) -> the one-line summary under the verdict.
//
// A failed review says why; a successful one says which model answered and
// what it cost, because a second model is a second bill. Costs stay hidden
// when the provider reports no token counts (known: false) rather than
// pretending the run was free.
function reviewStatusLine(result) {
  if (!result) return '';
  if (result.ok === false) return 'No review: ' + (result.error || result.code || 'the reviewer could not answer');
  const model = result.model ? [result.model.provider, result.model.id].filter(Boolean).join(' · ') : '';
  const parts = [model || 'reviewer'];
  if (result.durationMs != null) parts.push(result.durationMs + 'ms');
  if (result.cost && result.cost.known && Number(result.cost.total) > 0) {
    parts.push('cost ' + Number(result.cost.total).toFixed(4) + ' ' + (result.cost.currency || 'USD'));
  }
  return parts.join(' · ');
}

export function ShellReviewSheet({ projectDir, chatId, initialCommand = '', onClose }) {
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
  const [config, setConfig] = useState(null);      // shellReviewFromResolved(...)
  const [status, setStatus] = useState('Loading reviewer…');
  const [command, setCommand] = useState(initialCommand || '');
  const [prompt, setPrompt] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptStatus, setPromptStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const verdictRef = useRef(null);
  const commandRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetchJson('/api/settings/resolved?projectDir=' + encodeURIComponent(projectDir || ''));
        if (cancelled) return;
        const next = shellReviewFromResolved(r.status === 200 ? r.body.resolved : null);
        setConfig(next);
        setPrompt(next.prompt || '');
        const modelLabel = next.providerId && next.modelId
          ? (next.providerId + ' · ' + next.modelId)
          : 'the chat’s current model';
        setStatus(next.mode === 'off'
          ? 'Shell review is off — open Shell review to turn it on.'
          : 'Reviewed by ' + modelLabel);
      } catch (err) {
        if (!cancelled) setStatus('Cannot load settings: ' + (err && err.message ? err.message : String(err)));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [projectDir]);

  // Render the verdict through the shared block renderer so this sheet and the
  // approval card cannot drift. Imperative DOM (buildReviewBlock) into a host
  // node is the same pattern the transcript cards use.
  useEffect(() => {
    const host = verdictRef.current;
    if (!host) return;
    host.textContent = '';
    const block = result ? buildReviewBlock(result) : null;
    if (block) host.appendChild(block);
  }, [result]);

  const canReview = !!(config && config.configured && String(command).trim() && !busy);
  // Straight to the reviewer's page, not the project page root.
  const settingsHref = useMemo(
    () => settingsLink('settings/project/shell-review', { projectDir, chatId }),
    [projectDir, chatId]
  );

  async function savePrompt() {
    if (!projectDir || !config) return;
    setPromptStatus('saving…');
    try {
      const payload = {
        mode: config.mode === 'off' ? 'always' : (config.mode || 'always'),
        prompt,
        autoAllow: config.autoAllow !== false
      };
      if (config.providerId) payload.providerId = config.providerId;
      if (config.modelId) payload.modelId = config.modelId;
      if (config.thinkingLevel) payload.thinkingLevel = config.thinkingLevel;
      const r = await fetchJson('/api/settings/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectDir,
          shellReview: payload
        })
      });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const saved = shellReviewFromResolved(r.body && r.body.project);
      setConfig(saved);
      setPromptDirty(false);
      setPromptStatus('prompt saved');
    } catch (err) {
      setPromptStatus('not saved: ' + (err && err.message ? err.message : String(err)));
    }
  }

  async function onReview() {
    if (!canReview) return;
    setBusy(true);
    setResult(null);
    setStatus('Reviewing…');
    try {
      const r = await fetchJson('/api/tools/shell/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectDir,
          chatId: chatId || '',
          cmd: command
        })
      });
      // The endpoint answers 200 for a review and a typed status for a
      // misconfigured one; both carry the same body shape, so the verdict block
      // renders the failure the same way the success renders the answer.
      setResult(r.body || { ok: false, error: 'HTTP ' + r.status });
      setStatus(reviewStatusLine(r.body || { ok: false, error: 'HTTP ' + r.status }));
    } catch (err) {
      const failure = { ok: false, error: (err && err.message) || String(err) };
      setResult(failure);
      setStatus(reviewStatusLine(failure));
    } finally {
      setBusy(false);
    }
  }

  function onBackdropClick(e) {
    // Only a tap on the backdrop itself closes the sheet; a tap inside it must
    // not. Same rule as every other sheet in the app.
    if (e.target === e.currentTarget && onClose) onClose();
  }

  const ready = !!(config && config.configured && config.mode !== 'off');

  return h('div', {
    class: 'gm__overlay sr__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Review a shell command',
    onClick: onBackdropClick
  },
    h('div', { class: 'gm__sheet sr__sheet', ref: sheetRef },
      h('div', { class: 'gm__head sr__head' },
      h('div', { class: 'sr__head-text' },
      h('div', { class: 'sr__title' }, 'Review a command'),
      h('div', { class: 'sr__sub' }, 'Uses the chat’s model — nothing is run')
      ),
        h('button', {
          class: 'gm__close sr__close',
          type: 'button',
          'aria-label': 'Close',
          title: 'Close',
          onClick: () => onClose && onClose()
        }, '\u00D7')
      ),
      h('div', { class: 'sr__body' },
        h('p', { class: 'hint hint--compact sr__status', 'aria-live': 'polite' }, status),
        !ready && config ? h('a', { class: 'btn sr__settings-link', href: settingsHref },
          'Open Shell review settings') : null,
        h('label', { class: 'label sr__label', for: 'sr-command' }, 'Command'),
        h('textarea', {
          ref: commandRef,
          id: 'sr-command',
          class: 'input mono sr__command',
          rows: 4,
          spellcheck: false,
          autocapitalize: 'off',
          autocomplete: 'off',
          autocorrect: 'off',
          placeholder: 'rm -rf dist .env',
          value: command,
          onInput: (e) => setCommand(e.currentTarget.value),
          'aria-label': 'Command to review'
        }),
        h('div', { class: 'sr__row' },
          h('button', {
            class: 'btn btn--primary sr__review',
            type: 'button',
            onClick: onReview,
            disabled: !canReview,
            'aria-busy': busy ? 'true' : 'false',
            title: canReview ? 'Ask the reviewer about this command' : (ready ? 'Type a command first' : 'Configure a reviewer in project settings')
          }, busy ? 'Reviewing…' : 'Review'),
          h('span', { class: 'sr__row-hint' }, 'Sends the text above only. The command is not run.')
        ),
        h('label', { class: 'label sr__label', for: 'sr-prompt' }, 'Review prompt'),
        h('textarea', {
          id: 'sr-prompt',
          class: 'input mono sr__prompt',
          rows: 5,
          spellcheck: false,
          value: prompt,
          onInput: (e) => {
            setPrompt(e.currentTarget.value);
            setPromptDirty(true);
            if (promptStatus) setPromptStatus('');
          },
          'aria-label': 'Prompt the reviewer receives'
        }),
        h('div', { class: 'sr__row sr__row--prompt' },
          h('button', {
          class: 'btn sr__save-prompt',
          type: 'button',
          onClick: savePrompt,
          disabled: !projectDir || !config || !promptDirty
          }, 'Save prompt'),
          h('span', { class: 'status', 'aria-live': 'polite' }, promptStatus)
        ),
        h('div', { ref: verdictRef, class: 'sr__verdict' })
      )
    )
  );
}
