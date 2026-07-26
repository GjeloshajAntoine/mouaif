// Per-project tool authorization helpers.
// Shared by the project settings page and the chat view's tools card.

import { h } from 'preact';
import { fetchJson } from '../../api.js';

// Build a segmented control (Off/Ask/Allow) for a tool's permission mode.
// Segments are radio inputs for keyboard and screen-reader accessibility.
export function toolModeSegs(name, activeMode, onPick, modes) {
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name },
    modes.map((m) =>
      h('label', { key: m.value, class: 'seg__item' + (activeMode === m.value ? ' seg__item--on' : '') },
        h('input', {
          type: 'radio',
          name: 'sp-' + name.replace(/\s+/g, '-').toLowerCase(),
          value: m.value,
          checked: activeMode === m.value,
          onChange: () => onPick(m.value)
        }),
        h('span', { class: 'seg__pill' }, m.label)
      )
    )
  );
}

// The three standard modes shown for most tools.
export const TOOL_MODE_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Allow' }
];

// Binary mode for ask_user (only Off/Ask).
export const ASK_USER_MODE_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask' }
];

// Seg mode: map "allowlist" to "ask" for display (the segment never shows a fourth option).
export function segMode(mode) {
  return mode === 'allowlist' ? 'ask' : mode;
}

// Save tool authorization for one tool to the server.
export async function saveToolAuthorization(projectDir, tool, mode, allowlist) {
  const r = await fetchJson('/api/tools/authorization', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, tools: { [tool]: { mode, allowlist } } })
  });
  return r.status === 200;
}

// Save MCP server authorization.
export async function saveServerMcpAuth(projectDir, slug, newMode) {
  const patch = {};
  if (newMode === 'inherit') {
    patch[slug] = null;
  } else {
    patch[slug] = { mode: newMode };
  }
  return await fetchJson('/api/tools/authorization', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, mcp: { servers: patch } })
  });
}

// Build a debounced allowlist saver for a tool's auto-approve patterns textarea.
export function makeAllowlistSaver(projectDir, tool, getAuth, setAuth, setStatusMsg) {
  let t = null;
  return (text) => {
    if (t) clearTimeout(t);
    setStatusMsg('…');
    t = setTimeout(async () => {
      const allowlist = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const mode = allowlist.length ? 'allowlist' : 'ask';
      setAuth({ mode, allowlist });
      const ok = await saveToolAuthorization(projectDir, tool, mode, allowlist);
      setStatusMsg(ok ? 'saved' : 'failed');
    }, 350);
  };
}