// mouaif web — one kind per transcript row
//
// A transcript row's kind was spread across role/phase/content tests in
// several places (renderMessageRow, isRenderableMessage, retry.js). This
// derives it in one place. It is computed on read: nothing is stored on the
// row and the wire format does not change.
//
// Only top-level transcript rows (`Message`, session.js) are covered. Subagent
// transcripts use the provider shape (`tool_calls` / `tool_call_id`) and are
// classified where they are rendered.
//
// Pure module (no Preact, no DOM) so tests can import it directly.

/** @typedef {import('./session.js').Message} Message */
/** @typedef {'user'|'assistant'|'tool_call'|'tool_result'|'error'|'system'} MessageKind */

// A saved stream failure is a system row whose content starts with the
// warning marker (see retry.js).
const TURN_ERROR_RE = /^⚠(?:\s|$)/;

// messageKind(m) -> MessageKind
//
//   user / assistant     the matching role
//   tool_call            role `tool`, phase `call`
//   tool_result          role `tool`, phase `result`
//   error                role `system`, content starts with the ⚠ marker
//   system               any other system row, and the fallback for any row
//                        without a more specific kind (a tool row with no
//                        phase, an unknown role, a missing row). The transcript
//                        draws those as a plain bubble, as it always has.
/**
 * @param {Message|null|undefined} m
 * @returns {MessageKind}
 */
export function messageKind(m) {
  if (!m) return 'system';
  switch (m.role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'tool':
      if (m.phase === 'call') return 'tool_call';
      if (m.phase === 'result') return 'tool_result';
      return 'system';
    case 'system':
      return TURN_ERROR_RE.test(String(m.content || '')) ? 'error' : 'system';
    default:
      return 'system';
  }
}
