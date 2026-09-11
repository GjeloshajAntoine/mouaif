// mouaif web — MCP error modal (full-screen viewer)
//
// Shows the full typed error from a failed MCP server lifecycle action in
// Settings instead of squeezing it into the server row. Chat tool failures
// stay in their normal inline transcript cards. MCP errors carry a typed
// `code` (EMCP_RPC, EMCP_START, EMCP_TRANSPORT, EMCP_TIMEOUT,
// EMCP_NOSESSION, EMCP_NOTFOUND, ...) plus a full `message` and the
// server slug + tool name that produced it — all rendered in full here.
//
// The same full-screen overlay pattern as the Git modal: dark backdrop,
// a single sheet that fills the viewport on a phone and grows to a
// centered card on tablet/desktop. Tapping the backdrop, the close
// button, or pressing Escape dismisses it.
import { h } from 'preact';
import { useModal } from '../../hooks/useModal.js';
export function McpErrorModal({ error, onClose }) {
// Escape, the Tab cycle and focus restore come from the shared sheet hook
// (frontend/src/hooks/useModal.js).
const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
function onBackdropClick(e) {
    // Only close when the tap lands on the backdrop itself, not on
    // the sheet. Same pattern as the Git and webpreview modals.
    if (e.target === e.currentTarget && onClose) onClose();
  }
const result = (error && error.result) || {};
const err = result.error || {};
const code = err.code || 'EMCP_RPC';
const contentMessage = Array.isArray(result.content)
? result.content.find((block) => block && block.type === 'text' && block.text)
: null;
const message = err.message || (contentMessage && contentMessage.text) || 'MCP operation failed';
const tool = (error && error.name) || [result.serverSlug, result.toolName].filter(Boolean).join(' / ') || '';
// The raw block renders the full JSON result envelope (already shown to
// the model in the round) so the user sees every field, not just code/message.
const raw = result && Object.keys(result).length
    ? JSON.stringify(result, null, 2)
    : null;

  return h('div', {
    class: 'mcp-err__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'MCP error',
    onClick: onBackdropClick
  },
  h('div', { class: 'mcp-err__sheet', ref: sheetRef },
    h('div', { class: 'mcp-err__head' },
      h('span', { class: 'mcp-err__title' }, 'MCP error'),
      h('button', {
        class: 'mcp-err__close',
        type: 'button',
        onClick: onClose,
        'aria-label': 'Close error',
        title: 'Close'
      },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
        h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
      )
      )
    ),
    h('div', { class: 'mcp-err__body' },
      tool
        ? h('div', { class: 'mcp-err__tool', title: tool }, tool)
        : null,
      h('div', { class: 'mcp-err__code', 'data-code': code }, code),
      h('div', { class: 'mcp-err__message' }, message),
      raw
        ? h('pre', { class: 'mcp-err__raw' }, raw)
        : null
    ),
    h('div', { class: 'mcp-err__foot' },
      h('button', { class: 'btn', type: 'button', onClick: onClose }, 'Close')
    )
  )
  );
}
