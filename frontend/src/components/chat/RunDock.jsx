// mouaif web — run dock
//
// The user's controls over a long-running run (docs/features/long-running-runs.md).
// A compact bar in the bottom stack, above the composer, shown while the chat
// has an active run (running or paused) and when a run needs attention
// (stalled or out of budget). It shows the goal and what is left, and gives the
// user Pause / Resume and Stop. Stop takes two taps so a stray touch cannot end
// a day of work. State comes from GET /api/chats/:id/run, polled while visible.
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { runLine, STATUS_TEXT, ATTENTION, isActive, runListItems, runWhen, runsLabel, PROMPT_MAX } from './runDock.js';

const POLL_ACTIVE_MS = 5000;
const POLL_IDLE_MS = 30000;
const CONFIRM_MS = 4000;

function dismissKey(chatId) { return 'mouaif.runDock.dismissed.' + chatId; }
function readDismissed(chatId) {
  try { return localStorage.getItem(dismissKey(chatId)) || ''; } catch { return ''; }
}
function writeDismissed(chatId, value) {
  try { localStorage.setItem(dismissKey(chatId), value); } catch { /* storage unavailable */ }
}

export function RunDock({ projectDir, chatId, onJumpToSeq }) {
  const [run, setRun] = useState(null);
  const [scheduledRuns, setScheduledRuns] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [runList, setRunList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState('');
  const [promptOpen, setPromptOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [promptError, setPromptError] = useState('');

  useEffect(() => {
    if (!projectDir || !chatId) return undefined;
    let stopped = false;
    let timer = null;
    setRun(null);
    setScheduledRuns(0);
    setListOpen(false);
    setRunList(null);
    setPromptOpen(false);
    setDraft(null);
    setPromptError('');
    setError('');
    setDismissed(readDismissed(chatId));
    const load = async () => {
      let next = null;
      try {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/run?projectDir=' + encodeURIComponent(projectDir));
          if (!stopped && r.status === 200) { next = r.body.run || null; setRun(next); setScheduledRuns(r.body.scheduledRuns || 0); }
        }
      } catch { /* offline: keep the last state */ }
      if (!stopped) timer = setTimeout(load, next && isActive(next) ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [projectDir, chatId]);

  useEffect(() => {
    if (!confirmStop) return undefined;
    const timer = setTimeout(() => setConfirmStop(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmStop]);

  // Every prompt the recurring task started stays in the chat; the list is the
  // way back to any of them.
  useEffect(() => {
    if (!listOpen || !projectDir || !chatId) return undefined;
    let cancelled = false;
    fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/runs?projectDir=' + encodeURIComponent(projectDir))
      .then((r) => { if (!cancelled && r.status === 200) setRunList(runListItems(r.body.runs)); })
      .catch(() => { if (!cancelled) setRunList([]); });
    return () => { cancelled = true; };
  }, [listOpen, projectDir, chatId, scheduledRuns]);

  const active = !!run && isActive(run);
  const attention = !!run && ATTENTION.includes(run.status) && dismissed !== run.startedAt;
  const showDock = active || attention;
  if (!showDock && !scheduledRuns) return null;

  const prompt = run && run.kind === 'recurring' && run.schedule && typeof run.schedule.prompt === 'string' ? run.schedule.prompt : null;
  const toggleList = () => setListOpen((open) => !open);
  const togglePrompt = () => { setPromptOpen((open) => !open); setDraft(null); setPromptError(''); };
  const savePrompt = async () => {
    const text = draft.trim();
    if (saving || !text) return;
    if (text === prompt) { setDraft(null); return; }
    setSaving(true);
    setPromptError('');
    try {
      const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/recurring', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, prompt: text })
      });
      if (r.status === 200 && r.body.run) { setRun(r.body.run); setDraft(null); }
      else setPromptError((r.body && r.body.error) || 'Could not save the prompt');
    } catch { setPromptError('Could not reach mouaif'); }
    setSaving(false);
  };
  const jump = (seq) => { setListOpen(false); if (onJumpToSeq) onJumpToSeq(seq); };
  const runsButton = h('button', { class: 'run-dock__btn', type: 'button', onClick: toggleList, 'aria-expanded': listOpen ? 'true' : 'false',
    'aria-label': 'Show the scheduled runs in this chat' }, 'Runs');
  const panel = listOpen ? h('div', { class: 'run-list', role: 'group', 'aria-label': 'Scheduled runs' },
    runList === null ? h('div', { class: 'run-list__empty' }, 'Loading…')
      : runList.length ? runList.map((item) => h(Fragment, { key: item.seq },
        h('button', { class: 'run-list__item', type: 'button', onClick: () => jump(item.seq) },
          h('strong', null, 'Run ' + item.run), h('span', null, runWhen(item.ts))),
        item.newTask && item !== runList[runList.length - 1] ? h('div', { class: 'run-list__divider' }, 'Earlier task') : null))
        : h('div', { class: 'run-list__empty' }, 'No scheduled runs yet')) : null;
  const promptPanel = promptOpen && prompt !== null ? h('div', { class: 'run-prompt', role: 'group', 'aria-label': 'Recurring task prompt' },
    draft === null ? h(Fragment, null,
      h('pre', { class: 'run-prompt__text' }, prompt),
      h('div', { class: 'run-prompt__hint' }, 'Sent at the start of every run. A change applies from the next run.'),
      h('div', { class: 'run-prompt__actions' },
        h('button', { class: 'run-dock__btn', type: 'button', onClick: () => { setDraft(prompt); setPromptError(''); } }, 'Edit prompt')))
      : h(Fragment, null,
        h('textarea', { class: 'run-prompt__input', value: draft, rows: 8, maxLength: PROMPT_MAX, autofocus: true, disabled: saving,
          'aria-label': 'Recurring task prompt', onInput: (e) => setDraft(e.target.value) }),
        h('div', { class: 'run-prompt__hint' }, promptError || (draft.length + ' / ' + PROMPT_MAX + ' · applies from the next run')),
        h('div', { class: 'run-prompt__actions' },
          h('button', { class: 'run-dock__btn', type: 'button', disabled: saving, onClick: () => { setDraft(null); setPromptError(''); } }, 'Cancel'),
          h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', disabled: saving || !draft.trim(), onClick: savePrompt }, saving ? 'Saving…' : 'Save')))) : null;
  const promptButton = prompt !== null ? h('button', { class: 'run-dock__btn', type: 'button', onClick: togglePrompt, 'aria-expanded': promptOpen ? 'true' : 'false',
    'aria-label': 'Show or edit the recurring task prompt' }, 'Prompt') : null;
  if (!showDock) {
    return h(Fragment, null, panel,
      h('div', { class: 'run-dock run-dock--idle', role: 'group', 'aria-label': 'Scheduled runs' },
        h('div', { class: 'run-dock__text' }, h('div', { class: 'run-dock__goal' }, runsLabel(scheduledRuns), ' in this chat')),
        runsButton));
  }

  const act = async (action) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, action })
      });
      if (r.status === 200 && r.body.run) setRun(r.body.run);
      else setError((r.body && r.body.error) || 'Could not ' + action + ' the run');
    } catch (e) { setError('Could not reach mouaif'); }
    setBusy(false);
    setConfirmStop(false);
  };
  const onStop = () => {
    if (!confirmStop) { setConfirmStop(true); return; }
    act('stop');
  };
  const dismiss = () => { writeDismissed(chatId, run.startedAt); setDismissed(run.startedAt); };

  return h(Fragment, null, promptPanel, panel, h('div', { class: 'run-dock run-dock--' + run.status, role: 'group', 'aria-label': run.kind === 'recurring' ? 'Recurring task' : 'Long-running run' },
    h('span', { class: 'run-dock__dot', 'aria-hidden': 'true' }),
    h('div', { class: 'run-dock__text' },
      h('div', { class: 'run-dock__goal', title: run.goal }, h('strong', null, run.kind === 'recurring' && run.status === 'running' ? 'Recurring' : STATUS_TEXT[run.status] || run.status), ' · ', run.goal),
      h('div', { class: 'run-dock__meta' }, error || runLine(run))
    ),
    promptButton,
    scheduledRuns ? runsButton : null,
    run.status === 'running'
      ? h('button', { class: 'run-dock__btn', type: 'button', disabled: busy, onClick: () => act('pause') }, 'Pause')
      : null,
    run.status === 'paused'
      ? h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', disabled: busy, onClick: () => act('resume') }, 'Resume')
      : null,
    active
      ? h('button', { class: 'run-dock__btn run-dock__btn--danger' + (confirmStop ? ' is-armed' : ''), type: 'button', disabled: busy, onClick: onStop,
        'aria-label': confirmStop ? 'Tap again to stop the run' : 'Stop the run' }, confirmStop ? 'Tap to stop' : 'Stop')
      : h('button', { class: 'run-dock__btn', type: 'button', onClick: dismiss, 'aria-label': 'Dismiss' }, 'Dismiss')
  ));
}
