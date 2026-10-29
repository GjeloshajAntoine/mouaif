// mouaif web — run dock
//
// The user's controls over a long-running run (docs/features/long-running-runs.md).
// A compact bar in the bottom stack, above the composer, shown while the chat
// has an active run (running or paused) and when a run needs attention
// (stalled or out of budget). It shows the goal and what is left, and gives the
// user Pause / Resume and Stop. Stop takes two taps so a stray touch cannot end
// a day of work. State comes from GET /api/chats/:id/run, polled while visible.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { runLine, STATUS_TEXT, ATTENTION, isActive } from './runDock.js';

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

export function RunDock({ projectDir, chatId }) {
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState('');

  useEffect(() => {
    if (!projectDir || !chatId) return undefined;
    let stopped = false;
    let timer = null;
    setRun(null);
    setError('');
    setDismissed(readDismissed(chatId));
    const load = async () => {
      let next = null;
      try {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/run?projectDir=' + encodeURIComponent(projectDir));
          if (!stopped && r.status === 200) { next = r.body.run || null; setRun(next); }
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

  if (!run) return null;
  const active = isActive(run);
  const attention = ATTENTION.includes(run.status) && dismissed !== run.startedAt;
  if (!active && !attention) return null;

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

  return h('div', { class: 'run-dock run-dock--' + run.status, role: 'group', 'aria-label': run.kind === 'recurring' ? 'Recurring task' : 'Long-running run' },
    h('span', { class: 'run-dock__dot', 'aria-hidden': 'true' }),
    h('div', { class: 'run-dock__text' },
      h('div', { class: 'run-dock__goal', title: run.goal }, h('strong', null, run.kind === 'recurring' && run.status === 'running' ? 'Recurring' : STATUS_TEXT[run.status] || run.status), ' · ', run.goal),
      h('div', { class: 'run-dock__meta' }, error || runLine(run))
    ),
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
  );
}
