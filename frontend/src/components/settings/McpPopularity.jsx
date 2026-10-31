// mouaif web — McpPopularity: how much an MCP store server is used.
//
// A four-bar meter (log scale, see popularityLevel) plus the weekly download
// count from npm or PyPI. Renders nothing when the server has no count —
// hosted servers and other package types publish none, and the store never
// shows an invented score. `detail` spells the number out for the sheet.
// See docs/features/mcp-registry-browser.md.
import { h } from 'preact';
import { compactCount, downloadsLabel, popularityLevel } from './mcpRegistryInstall.js';

export function McpPopularity({ downloads, detail = false }) {
  if (!downloads) return null;
  const level = popularityLevel(downloads.weekly);
  const label = downloadsLabel(downloads);
  return h('span', {
    class: 'mcps-pop mcps-pop--l' + level + (detail ? ' mcps-pop--detail' : ''),
    role: 'img',
    'aria-label': label,
    title: label
  },
    h('span', { class: 'mcps-pop__bars', 'aria-hidden': 'true' },
      [1, 2, 3, 4].map((i) => h('span', { key: i, class: 'mcps-pop__bar' + (i <= level ? ' mcps-pop__bar--on' : '') }))),
    h('span', { class: 'mcps-pop__text', 'aria-hidden': 'true' },
      detail ? label : compactCount(downloads.weekly) + '/wk')
  );
}
