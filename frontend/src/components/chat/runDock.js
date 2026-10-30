// Pure helpers for the run dock (RunDock.jsx): what to say about a run.
// The longest prompt a recurring task accepts (src/schedules.js MAX_MESSAGE_CHARS).
export const PROMPT_MAX = 4000;
export const ATTENTION = ['stalled', 'exhausted'];
export const STATUS_TEXT = { running: 'Running', paused: 'Paused', stalled: 'Stalled', exhausted: 'Budget reached' };

export function isActive(run) {
  return !!run && (run.status === 'running' || run.status === 'paused');
}

export function formatLeft(minutes) {
  if (minutes == null) return '';
  if (minutes >= 120) return Math.round(minutes / 60) + 'h left';
  if (minutes >= 60) return '1h ' + (minutes - 60) + 'm left';
  return minutes + 'm left';
}

export function formatNext(iso, nowMs = Date.now()) {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - nowMs) / 60000));
  if (minutes < 1) return 'next now';
  if (minutes < 60) return 'next in ' + minutes + 'm';
  if (minutes < 48 * 60) return 'next in ' + (minutes % 60 ? Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm' : minutes / 60 + 'h');
  return 'next in ' + Math.round(minutes / 1440) + 'd';
}

function costParts(run) {
  if (run.maxCost != null) return ['$' + run.costUsed.toFixed(2) + ' of $' + run.maxCost];
  return run.costUsed > 0 ? ['$' + run.costUsed.toFixed(2)] : [];
}

// A recurring task has no turn budget worth showing unless it was given a count.
const OPEN_ENDED_TURNS = 100000;

export function runLine(run, nowMs = Date.now()) {
  if (run.kind === 'recurring') {
    const parts = [run.schedule ? run.schedule.text : ''];
    if (run.status === 'running' && run.schedule) parts.push(formatNext(run.schedule.nextAt, nowMs));
    parts.push(run.maxTurns < OPEN_ENDED_TURNS ? run.turnsUsed + '/' + run.maxTurns + ' runs' : run.turnsUsed + ' runs');
    parts.push(...costParts(run));
    if (run.endReason && !isActive(run)) parts.push(run.endReason);
    return parts.filter(Boolean).join(' · ');
  }
  const parts = [run.turnsUsed + '/' + run.maxTurns + ' turns', ...costParts(run)];
  if (isActive(run)) parts.push(formatLeft(run.minutesLeft));
  if (run.endReason && !isActive(run)) parts.push(run.endReason);
  return parts.filter(Boolean).join(' · ');
}

// runListItems(runs) -> [{ seq, run, scheduleId, ts, newTask }] newest first.
// `newTask` marks the oldest run of a task, where a replaced recurring task
// started over (its run numbers begin again at 1).
export function runListItems(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const items = list.map((r, i) => ({ seq: r.seq, run: r.run, scheduleId: r.scheduleId, ts: r.ts,
    newTask: i === 0 || list[i - 1].scheduleId !== r.scheduleId }));
  return items.reverse();
}

export function runWhen(ts, locale) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function runsLabel(count) {
  return count === 1 ? '1 scheduled run' : count + ' scheduled runs';
}
