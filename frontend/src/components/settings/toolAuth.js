// Per-project tool authorization helpers.
// Shared by the project settings page and the chat view's tools card.

import { h } from 'preact';
import { fetchJson } from '../../api.js';

// The ONE per-tool authorization control (Off / Ask / Allow, or
// Off / Ask for binary tools). Every surface that shows a tool's
// permission mode renders this component — the chat tools card, the
// composer tool popup, and project settings — so no single tool can
// drift from the others. `subagent` is not special-cased anywhere:
// it is one entry in the same loop as `shell`, `file`, MCP, …
//
// Props:
//   tool        — authorization key ('shell' | 'subagent' | 'file' | …).
//                 Used for the radio group name so each row is its own
//                 group.
//   name        — aria-label / readable label; defaults to `tool`.
//   mode        — the current raw mode ('off' | 'ask' | 'allowlist' | 'allow').
//                 `allowlist` displays as Ask (the segment never shows a
//                 fourth option).
//   allowlist   — current patterns, preserved across mode changes so an
//                 ask → off → ask round-trip never loses them.
//   modes       — TOOL_MODE_CHOICES (default) or ASK_USER_MODE_CHOICES.
//   namePrefix  — surface-specific radio-name prefix, so two cards on one
//                 page never share a radio group.
//   onPick      — (mode, allowlist) => void.
export function ToolAuthSeg({
  tool,
  name,
  mode,
  allowlist,
  modes = TOOL_MODE_CHOICES,
  namePrefix = 'auth',
  onPick
}) {
  const active = segMode(mode || 'ask');
  const list = Array.isArray(allowlist) ? allowlist : [];
  const label = name || tool || 'tool';
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label + ' authorization' },
    modes.map((m) =>
      h('label', { key: m.value, class: 'seg__item' + (active === m.value ? ' seg__item--on' : '') },
        h('input', {
          type: 'radio',
          name: namePrefix + '-' + String(tool || label).replace(/\s+/g, '-').toLowerCase(),
          value: m.value,
          checked: active === m.value,
          onChange: () => {
            if (onPick) onPick(m.value, m.value === 'allow' ? [] : list);
          }
        }),
        h('span', { class: 'seg__pill' }, m.label)
      )
    )
  );
}

// Thin wrapper kept for the settings call sites, which pass a display
// name and a one-argument picker. It renders the shared ToolAuthSeg.
export function toolModeSegs(name, activeMode, onPick, modes) {
  return h(ToolAuthSeg, {
    tool: name,
    name,
    mode: activeMode,
    namePrefix: 'sp',
    modes: modes || TOOL_MODE_CHOICES,
    onPick: (mode) => onPick(mode)
  });
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

// Save an MCP authorization patch ({ mode?, servers?, tools? }) to the
// server. Returns the fetchJson result so callers can read the merged
// response (GET /api/tools/authorization returns the persisted maps).
export async function saveMcpAuthorization(projectDir, patch) {
  return await fetchJson('/api/tools/authorization', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, mcp: patch })
  });
}

// Effective MCP authorization for one server (decisions §18 layering):
// the per-server override under `servers.<slug>` wins when it carries a
// mode; otherwise the shared gate applies. `shared` is the project's
// `mcp` block ({ mode, allowlist, ... }) from GET /api/tools/authorization.
export function mcpEffective(servers, slug, shared) {
  const entry = servers && typeof servers === 'object' ? servers[slug] : null;
  const overridden = !!(entry && typeof entry.mode === 'string' && entry.mode);
  const mode = overridden ? entry.mode : ((shared && shared.mode) || 'ask');
  const allowlist = overridden
    ? (Array.isArray(entry.allowlist) ? entry.allowlist : [])
    : (Array.isArray(shared && shared.allowlist) ? shared.allowlist : []);
  return { overridden, mode, allowlist };
}

// One Off/Ask/Allow segmented control for MCP authorization, shared by
// the chat tools card and the settings tool tree so the two surfaces
// never drift. Two flavours, driven by `slug`:
//   - slug set   → per-server override row. The segment shows the
//     effective mode (override or shared gate); picking a mode writes
//     `servers.<slug>`.
//   - slug null  → the shared gate itself (project or app default).
//     Picking a mode writes `{ mode, allowlist }`.
// Picking "Ask" while allowlist patterns exist persists `allowlist`
// mode so the patterns survive the round-trip.
export function McpAuthSeg({ name, slug, servers, shared, namePrefix = 'mcp', onSave }) {
  const eff = slug ? mcpEffective(servers, slug, shared) : { overridden: false, mode: (shared && shared.mode) || 'ask', allowlist: (shared && shared.allowlist) || [] };
  const active = segMode(eff.mode);
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name + ' authorization' },
    TOOL_MODE_CHOICES.map((m) =>
      h('label', { key: m.value, class: 'seg__item' + (active === m.value ? ' seg__item--on' : '') },
        h('input', {
          type: 'radio',
          name: namePrefix + '-' + name.replace(/\s+/g, '-').toLowerCase(),
          value: m.value,
          checked: active === m.value,
          onChange: () => {
            if (!onSave) return;
            let mode = m.value;
            let list = Array.isArray(eff.allowlist) ? eff.allowlist : [];
            if (mode === 'allow') list = [];
            else if (mode === 'ask' && list.length) mode = 'allowlist';
            onSave(slug
              ? { servers: { [slug]: { mode, allowlist: list } } }
              : { mode, allowlist: list });
          }
        }),
        h('span', { class: 'seg__pill' }, m.label)
      )
    )
  );
  return seg;
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