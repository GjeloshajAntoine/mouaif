// Extension tool renderers (docs/features/extensions.md, slot `tool.renderer`).
//
// An extension can show a matching tool call's result as its own view: the
// card's ordinary result body moves under a "Raw result" fold and the view
// mounts above it, receiving the call's arguments and result through the
// standard MCP Apps notifications (an existing MCP App works unchanged).
// Renderers count toward the live-view budget (appHostContext.js); an
// evicted one leaves a "Show view" button.
import { mountMcpApp } from './McpAppFrame.jsx';
import { claimSurface, touchSurface } from './appHostContext.js';

const byProject = new Map(); // projectDir -> [surface]

export function setToolRenderers(projectDir, list) {
  byProject.set(projectDir, Array.isArray(list) ? list : []);
}

function globToRegExp(glob) {
  return new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

// findToolRenderer(projectDir, toolName) -> surface | null (the first match).
export function findToolRenderer(projectDir, toolName) {
  const list = byProject.get(projectDir) || [];
  const name = String(toolName || '');
  for (const s of list) {
    const tools = (s.match && s.match.tool) || [];
    if (tools.some((p) => (p.includes('*') ? globToRegExp(p).test(name) : p === name))) return s;
  }
  return null;
}

// mountToolRenderer(body, { projectDir, chatId, callId, renderer, onAuthorize })
export function mountToolRenderer(body, { projectDir, chatId, callId, renderer, onAuthorize }) {
  const raw = document.createElement('details');
  raw.className = 'ext-renderer__raw';
  const summary = document.createElement('summary');
  summary.textContent = 'Raw result';
  raw.appendChild(summary);
  while (body.firstChild) raw.appendChild(body.firstChild);
  const host = document.createElement('div');
  host.className = 'ext-renderer';
  host.addEventListener('pointerdown', () => touchSurface(key));
  body.append(host, raw);
  const key = 'renderer:' + callId;
  const title = renderer.extensionName === renderer.title ? renderer.title : renderer.extensionName + ' · ' + renderer.title;
  function evict() {
    host.textContent = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ext-renderer__show';
    btn.textContent = 'Show ' + title;
    btn.addEventListener('click', (e) => { e.stopPropagation(); mount(); });
    host.appendChild(btn);
  }
  function mount() {
    host.textContent = '';
    const slot = document.createElement('div');
    host.appendChild(slot);
    claimSurface(key, evict, () => host.isConnected);
    mountMcpApp(slot, { projectDir, chatId, callId,
      surface: { extensionId: renderer.extensionId, surfaceId: renderer.surfaceId, slot: 'tool.renderer' },
      onAuthorize });
  }
  mount();
}
