// mouaif web — per-chat session bag
//
// ChatView is reused across chat navigation: only its props change, it is
// never remounted. Everything that belongs to ONE chat therefore has to be
// thrown away when the chat changes, or the next chat inherits it: a stale
// pager drives the scroll-up loader against the wrong chat, a stale cursor
// skews the reconcile poll, a stale run latch keeps a finished run settled.
//
// Those values used to live in separate refs, each reset by its own effect,
// and the effects did not agree on when a chat changed (some keyed on
// `chatId` alone, others on `chatId` + `projectDir`). They now live in one
// object created by newChatSession(); useChatState replaces the whole object
// when the chat key changes, so a new chat always starts from one known
// shape and nothing can be forgotten.
//
// Pure module (no Preact, no DOM) so tests can import it directly.

import { createPager } from './pagination.js';

// ---- Types (JSDoc only; no runtime effect) --------------------------------

/**
  * One transcript row, as the server sends it (`rowToMessage` in
  * src/chatdb.js) or as the client builds it before the server has saved it.
  * Only `role`, `content` and `ts` are always present; the rest depend on the
  * role. Unsaved rows have no `seq` until the saved copy replaces them.
  *
  * @typedef {Object} Message
  * @property {'user'|'assistant'|'tool'|'system'} role
  * @property {string} content  Text. For a `tool` result row, the result body.
  * @property {string} ts  ISO timestamp (client clock on unsaved rows).
  * @property {number} [seq]  Stable per-chat position, set once the row is saved.
  * @property {string} [clientId]  Id minted by this client for an unsaved row;
  *   the saved copy echoes it (docs/agent/features/chat-client-row-ids.md).
  * @property {Array<Object>} [attachments]  `user` only: image attachments.
  * @property {string} [reasoning]  `assistant` only: thinking text.
  * @property {{promptTokens?: number, completionTokens?: number,
  *   cacheReadTokens?: number, cacheCreationTokens?: number}} [usage]
  *   `assistant` only.
  * @property {{input?: number, output?: number, total?: number,
  *   currency?: string, known?: boolean}} [cost]  `assistant` only.
  * @property {number} [streamingMs]  `assistant` only: server-measured
  *   streaming window, used for tok/s.
  * @property {string} [modelId]  `assistant` only.
  * @property {string} [toolCallId]  `tool` only.
  * @property {string} [name]  `tool` only: tool name.
  * @property {Object} [args]  `tool` only: call arguments (on the call row).
  * @property {boolean} [ok]  `tool` only: result status.
  * @property {'call'|'result'} [phase]  `tool` only.
  * @property {number} [liveRate]  Client only, never sent or saved: tok/s the
  *   live counter measured for the final assistant row of a run.
  */

/**
  * Everything that belongs to one chat. Replaced as a whole on chat change.
  *
  * @typedef {Object} ChatSession
  * @property {string} key  chatSessionKey() of the owning chat.
  * @property {Message[]} messages  Transcript rows held client-side (saved and
  *   unsaved). Always replaced, never mutated in place: toolCallArgsIndex
  *   (transcript.js) caches by array identity.
  * @property {ReturnType<typeof createPager>} pager  Backward-pagination cursor.
  * @property {number} transcriptNextSeq  Next saved-row seq the reconcile poll expects.
  * @property {number} nextLiveSeq  `/live?fromLiveSeq=` replay cursor.
  * @property {{key: string, active: boolean, connected: boolean,
  *   ended: boolean, failed: boolean}} liveRun  Follower live-socket marker.
  * @property {boolean} runSettled  Latch for a torn run settled as done.
  * @property {number} watchingStableTicks  Stable-tick counter for the reload follow poll.
  * @property {Set<string>} usedTools  Tool names called in this chat (tools card).
  */

// chatSessionKey(projectDir, chatId) -> string
//
// Identity of the chat a session belongs to. The same format live.js and
// transcript.js use for their per-chat keys.
export function chatSessionKey(projectDir, chatId) {
  return (projectDir || '') + '::' + (chatId || '');
}

// emptyLiveRun() -> object
//
// The follower live-socket marker for a chat with no subscription yet.
export function emptyLiveRun() {
  return { key: '', active: false, connected: false, ended: false, failed: false };
}

// newChatSession(projectDir, chatId) -> ChatSession
//
//   key                  chatSessionKey() of the owning chat
//   messages             transcript rows held client-side (saved + unsaved)
//   pager                backward-pagination cursor (pagination.js)
//   transcriptNextSeq    next saved-row seq the reconcile poll expects
//   nextLiveSeq          `/live?fromLiveSeq=` replay cursor
//   liveRun              follower live-socket marker
//   runSettled           latch for a torn run settled as done
//   watchingStableTicks  stable-tick counter for the reload follow poll
//   usedTools            tool names called in this chat (tools card)
/** @returns {ChatSession} */
export function newChatSession(projectDir, chatId) {
  return {
    key: chatSessionKey(projectDir, chatId),
    messages: [],
    pager: createPager(),
    transcriptNextSeq: 0,
    nextLiveSeq: 0,
    liveRun: emptyLiveRun(),
    runSettled: false,
    watchingStableTicks: 0,
    usedTools: new Set()
  };
}

// ensureChatSession(current, projectDir, chatId) -> ChatSession
//
// `current` when it already belongs to this chat, else a fresh session.
// Idempotent, so it is safe to call on every render.
/** @returns {ChatSession} */
export function ensureChatSession(current, projectDir, chatId) {
  const key = chatSessionKey(projectDir, chatId);
  return current && current.key === key ? current : newChatSession(projectDir, chatId);
}
