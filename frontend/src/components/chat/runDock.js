// Pure helpers for the run dock (RunDock.jsx): what to say about a run.
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

export function runLine(run) {
  const parts = [run.turnsUsed + '/' + run.maxTurns + ' turns'];
  if (run.maxCost != null) parts.push('$' + run.costUsed.toFixed(2) + ' of $' + run.maxCost);
  else if (run.costUsed > 0) parts.push('$' + run.costUsed.toFixed(2));
  if (isActive(run)) parts.push(formatLeft(run.minutesLeft));
  if (run.endReason && !isActive(run)) parts.push(run.endReason);
  return parts.filter(Boolean).join(' · ');
}

