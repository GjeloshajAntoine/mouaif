// mouaif web — what an extension does, in words (docs/features/extensions.md)
//
// The permission screen shown before an extension is turned on (and in its
// details later): what its UI may do, the MCP server it uses or registers,
// every hook verbatim, and where its UI appears. Data comes from the server's
// `summary` (src/extensions.js).
import { h } from 'preact';
import { EVENT_LABELS, matchSummary } from './hookText.js';
import { handlerText } from './ProjectHooksReview.jsx';

export const SLOT_LABELS = {
  'chat.dock': 'A bar above the message box',
  'chat.sheet': 'A sheet opened from the chat’s file menu',
  'settings.page': 'A page in Settings → Extensions',
  'tool.renderer': 'A view inside matching tool cards',
  'project.card': 'A row on the project card'
};

export function ExtensionSummary({ summary }) {
  if (!summary) return null;
  const server = summary.server;
  return h('div', { class: 'ext-summary' },
    h('div', { class: 'webhook-panel__label' }, 'Its UI may'),
    summary.permissions.length
      ? h('ul', { class: 'ext-summary__list' }, summary.permissions.map((p) => h('li', { key: p.id }, p.text, ' ', h('code', null, p.id))))
      : h('p', { class: 'hint hint--compact' }, 'Nothing beyond showing itself: no access to the chat.'),
    h('div', { class: 'webhook-panel__label' }, 'MCP server'),
    !server ? h('p', { class: 'hint hint--compact' }, 'None.')
      : server.ref ? h('p', { class: 'hint hint--compact' }, 'Uses your server ', h('code', null, server.ref), '. It must be set up in Settings → MCP.')
        : h('div', null,
          h('p', { class: 'hint hint--compact' }, 'Registers a server named ', h('strong', null, server.registers), ' while it is on. mouaif starts it when needed:'),
          h('pre', { class: 'hooks-panel__code' }, server.command ? [server.command].concat(server.args || []).join(' ') : server.url)),
    h('div', { class: 'webhook-panel__label' }, 'Hooks'),
    summary.hooks.length
      ? h('ul', { class: 'hook-list ext-summary__hooks' }, summary.hooks.map((hook) => h('li', { key: hook.id, class: 'hook-card' },
        h('div', { class: 'hook-card__title' }, hook.name || hook.id),
        h('div', { class: 'hook-card__meta' },
          h('span', { class: 'hook-chip' }, EVENT_LABELS[hook.event] || hook.event),
          h('span', null, matchSummary(hook)),
          hook.handler.kind === 'http' ? h('span', { class: 'hook-chip hook-chip--warn' }, 'sends data to a URL') : null,
          hook.handler.kind === 'mcp' ? h('span', { class: 'hook-chip' }, 'calls its server') : null),
        h('pre', { class: 'hooks-panel__code' }, hook.handler.kind === 'mcp' ? 'tools/call ' + hook.handler.tool : handlerText(hook)))))
      : h('p', { class: 'hint hint--compact' }, 'None.'),
    h('div', { class: 'webhook-panel__label' }, 'Where it shows'),
    summary.ui.length
      ? h('ul', { class: 'ext-summary__list' }, summary.ui.map((u) => h('li', { key: u.id }, h('strong', null, u.title), ' · ', SLOT_LABELS[u.slot] || u.slot)))
      : h('p', { class: 'hint hint--compact' }, 'No UI.'));
}
