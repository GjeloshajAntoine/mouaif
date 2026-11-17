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
  'tool.renderer': 'A view inside matching tool cards (it sees those calls’ arguments and results)',
  'project.card': 'A chip on the project card that opens it',
  'composer.action': 'A button in the message box tools',
  'message.action': 'An action under chat messages (it sees that message with chat.read)',
  'files.action': 'An entry in the Files menu',
  'git.action': 'An entry in the Git sheet',
  'inspector.panel': 'A button in the Inspector’s header',
  'app.panel': 'An entry in the app header’s Extensions menu',
  'app.route': 'A full page, with a tab (the first two) and an entry in the app header’s Extensions menu',
  'chat.list.action': 'A button on each chat in the Chats list (it gets that chat’s id)'
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
        server.command ? h('pre', { class: 'hooks-panel__code' }, [server.command].concat(server.args || []).join(' ')) : null,
        server.url ? h('pre', { class: 'hooks-panel__code' }, server.url) : null,
        server.cwd ? h('p', { class: 'hint hint--compact' }, 'Working directory: ', h('code', null, server.cwd)) : null,
        server.transport ? h('p', { class: 'hint hint--compact' }, 'Transport: ', h('code', null, server.transport)) : null,
        server.envKeys && server.envKeys.length ? h('p', { class: 'hint hint--compact' }, 'Environment keys: ', h('code', null, server.envKeys.join(', '))) : null,
        server.headerKeys && server.headerKeys.length ? h('p', { class: 'hint hint--compact' }, 'HTTP header keys: ', h('code', null, server.headerKeys.join(', '))) : null),
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
      ? h('ul', { class: 'ext-summary__list' }, summary.ui.map((u) => h('li', { key: u.id }, h('strong', null, u.title), ' · ', SLOT_LABELS[u.slot] || u.slot,
        // Which tool calls a renderer sees; `*` alone is every tool.
        Array.isArray(u.tools) && u.tools.length
          ? h('div', { class: 'hint hint--compact' },
            u.tools.includes('*') ? h('strong', null, 'Every tool call') : 'Tools: ',
            u.tools.includes('*') ? null : h('code', null, u.tools.join(', ')))
          : null,
        u.role ? h('div', { class: 'hint hint--compact' }, u.role === 'user' ? 'Your messages' : 'Assistant answers') : null,
        u.command ? h('div', { class: 'hint hint--compact' }, 'Command: ', h('code', null, '/' + u.command)) : null,
        u.shortcut ? h('div', { class: 'hint hint--compact' }, 'Shortcut: ', h('code', null, u.shortcut)) : null)))
      : h('p', { class: 'hint hint--compact' }, 'No UI.'));
}
