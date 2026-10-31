// Shared text for hooks (docs/features/hooks.md): labels and one-line
// summaries used by Settings → Hooks and the chat's hooks panel.
import { h } from 'preact';

export const EVENT_LABELS = {
  'prompt.submit': 'Prompt sent',
  'tool.before': 'Before a tool runs',
  'tool.after': 'After a tool ran',
  'turn.start': 'Turn starts',
  'turn.end': 'Turn finished',
  'turn.error': 'Turn failed or stopped',
  attention: 'Before a notification'
};
export const TOOL_EVENTS = ['tool.before', 'tool.after'];
// Events where a block (or a failure with "block on failure") stops something.
export const BLOCKING_EVENTS = ['prompt.submit', 'tool.before'];
export const ORIGIN_LABELS = { user: 'You', webhook: 'Webhook', schedule: 'Recurring task', app: 'MCP App', hook: 'Hook follow-up' };
export const DECISION_LABELS = { continue: 'ran', block: 'blocked', ask: 'asked', error: 'failed', skipped: 'skipped' };
// Tool families, as the authorization gates group them (src/hooks.js FAMILIES).
export const FAMILY_LABELS = { shell: 'Shell', file: 'Files', subagent: 'Subagents', chats: 'Chat tools', mouaif: 'mouaif app', mcp: 'MCP servers' };

export function matchSummary(hook) {
  const m = hook.match || {};
  const bits = [];
  if (m.tool) bits.push(m.tool.join(', '));
  if (m.family) bits.push(m.family.map((x) => FAMILY_LABELS[x] || x).join(', ') + ' tools');
  if (m.argText) bits.push('/' + m.argText + '/');
  if (m.origin) bits.push('from ' + m.origin.map((o) => ORIGIN_LABELS[o] || o).join(', '));
  if (bits.length) return bits.join(' · ');
  if (hook.event === 'prompt.submit') return 'every prompt';
  if (hook.event === 'attention') return 'every notification';
  return TOOL_EVENTS.includes(hook.event) ? 'every tool' : 'every turn';
}

export function handlerSummary(hook) {
  const handler = hook.handler || {};
  if (handler.kind === 'http') return 'POST ' + handler.url;
  if (handler.kind === 'module') return 'module · ' + ((handler.source || '').split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) || '').trim();
  if (handler.command) return handler.command;
  const first = (handler.script || '').split('\n').find((line) => line.trim() && !line.startsWith('#!')) || '';
  return handler.shell + ' script · ' + first.trim();
}

export function timeAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return s + ' s ago';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(at).toLocaleDateString();
}

export function RunRow({ run }) {
  const tone = run.decision === 'block' || run.decision === 'error' ? 'bad' : (run.decision === 'ask' || run.decision === 'skipped' ? 'warn' : '');
  return h('li', { class: 'hook-run' },
    h('div', { class: 'hook-run__head' },
      h('span', { class: 'hook-run__name' }, run.name || run.hook),
      h('span', { class: 'hook-chip' + (tone === 'bad' ? ' hook-chip--bad' : tone === 'warn' ? ' hook-chip--warn' : '') }, DECISION_LABELS[run.decision] || run.decision)),
    h('div', { class: 'hook-run__meta' },
      [EVENT_LABELS[run.event] || run.event, Number.isFinite(run.ms) ? run.ms + ' ms' : '', timeAgo(run.at)].filter(Boolean).join(' · ')),
    run.detail ? h('div', { class: 'hook-run__detail' }, run.detail) : null,
    run.error ? h('div', { class: 'hook-run__detail hook-run__detail--error' }, run.error) : null);
}

