// Boot-time prefetch of the chat a page opens on.
//
// On a cold open of `#/chat/<id>?projectDir=…` the app mounts only after
// AccessGate's `/api/access/status` round trip, and the chat load runs only
// after that mount — so the two requests the transcript needs sat idle for
// most of a second while the bundle was already ready. main.jsx calls
// `prefetchChatFromHash` before the first render, which starts those two
// requests in parallel with the gate. The chat load then claims them with
// `takePrefetchedChat`.
//
// The server enforces access on both endpoints anyway, so starting them
// early leaks nothing. A prefetch that came back non-200 (signed out at boot,
// signed in through the gate since) is not trusted: the claim re-fetches.

import { fetchJson } from './api.js';
import { parseHash } from './routes.js';

// A prefetch is a cold-open shortcut, not a cache: past this age the chat
// load fetches fresh data instead.
const MAX_AGE_MS = 15000;

let pending = null;

export function chatUrl(projectDir, chatId) {
  return '/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir);
}

export function chatMessagesUrl(projectDir, chatId) {
  return '/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir) + '&limit=100';
}

export function prefetchChatFromHash(hash) {
  const route = parseHash(hash);
  if (!route || route.name !== 'chat' || !route.chatId || !route.projectDir) return;
  const { projectDir, chatId } = route;
  const swallow = (p) => { p.catch(() => {}); return p; };
  pending = {
    projectDir, chatId, at: Date.now(),
    chat: swallow(fetchJson(chatUrl(projectDir, chatId))),
    messages: swallow(fetchJson(chatMessagesUrl(projectDir, chatId)))
  };
}

// takePrefetchedChat(projectDir, chatId) -> { chat, messages } | null
//
// One-shot: the first load of the matching chat gets the prefetched
// promises, any later load (a reopen, a retained view) fetches fresh.
export function takePrefetchedChat(projectDir, chatId) {
  const p = pending;
  pending = null;
  if (!p || p.projectDir !== projectDir || p.chatId !== chatId) return null;
  if (Date.now() - p.at > MAX_AGE_MS) return null;
  const orFetch = (promise, url) => promise
    .then((r) => (r && r.status === 200 ? r : fetchJson(url)), () => fetchJson(url));
  return {
    chat: orFetch(p.chat, chatUrl(projectDir, chatId)),
    messages: orFetch(p.messages, chatMessagesUrl(projectDir, chatId))
  };
}
