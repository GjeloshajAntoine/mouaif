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
export function ensureChatSession(current, projectDir, chatId) {
  const key = chatSessionKey(projectDir, chatId);
  return current && current.key === key ? current : newChatSession(projectDir, chatId);
}
