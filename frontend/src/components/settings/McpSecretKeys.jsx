import { h } from 'preact';

// The configured-keys line under the MCP editor's Environment / HTTP headers
// field. Values are write-only, so the editor only knows key names.
//
// A PATCH that carries `env` / `headers` replaces the whole map
// (src/mcp.js updateServer), so this row states what Save will do:
//   * nothing typed, not cleared → keys kept;
//   * values typed               → the typed values replace every key;
//   * Clear all, nothing typed   → every key is removed.
// Clear all is a pending change with an Undo, never an instant wipe.
export function McpSecretKeys({ keys, noun, typed, cleared, onClear, onUndo }) {
  if (!keys.length) return null;
  const list = keys.join(', ');
  const note = typed
    ? 'Saving replaces the configured ' + noun + ' (' + list + ') with the values above.'
    : cleared
      ? 'All configured ' + noun + ' (' + list + ') will be removed when you save.'
      : 'Configured ' + noun + ': ' + list;
  const warn = typed || cleared;
  return h('div', { class: 'row row--inline mcp__keys' + (warn ? ' mcp__keys--pending' : '') },
    h('span', { class: 'mcp__keys-text', role: warn ? 'status' : undefined }, note),
    cleared
      ? h('button', { class: 'btn btn--small', type: 'button', onClick: onUndo }, 'Undo')
      : typed
        ? null
        : h('button', { class: 'btn btn--small btn--danger', type: 'button', onClick: onClear }, 'Clear all')
  );
}
