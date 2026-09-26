// mouaif web — Chat-level metadata actions
//
// Actions that touch the chat record itself (rename, delete, prompt
// size, system-prompt refresh, status pill) but are not part of
// the message stream. Each function takes `state` and `refs`
// explicitly so it can be called from a useEffect or an event
// handler without re-creating closures on every render.

import { fetchJson, projectsReload } from '../../api.js';
import { nav } from '../../router.js';
import { renderSystemPromptMessage } from './transcript.js';
import { setChatStatus } from './usage.js';

// updateMetaLine(refs, state)
//
// The meta line is intentionally minimal. The prompt-size profile
// is no longer shown here (it lives in the settings popover and is
// surfaced in full as the first transcript message); only the
// trace state, which has no other on-screen indicator, is shown.
export function updateMetaLine(refs, state) {
  if (!refs.chatMeta.current) return;
  const c = state.chat;
  if (!c) return;
  refs.chatMeta.current.textContent = c.trace ? 'trace on' : '';
}

// activeProfileId(state) -> string
export function activeProfileId(state) {
  const c = state.chat;
  if (c && ['very-small', 'average', 'extensive', 'chat'].indexOf(c.promptSize) >= 0) return c.promptSize;
  return 'average';
}

// updateChat(patch, state, refs)
//
// PATCH the chat record and sync state.chat from the response.
// Refresh the head elements that mirror the record (meta line,
// model trigger, provider credit).
export async function updateChat(patch, state, refs) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ projectDir }, patch || {}))
  });
  if (r.status !== 200) {
    if (refs.status.current) refs.status.current.textContent = 'HTTP ' + r.status;
    return false;
  }
  state.chat = r.body.chat;
  updateMetaLine(refs, state);
  // Trigger / credit refresh are done in the main view because
  // they need the modelPicker module — we just notify via a
  // callback hook so the main view can re-render them.
  if (state._onChatChanged) state._onChatChanged();
  return true;
}

// refreshSystemPrompt(state, refs)
//
// Re-fetch the resolved system prompt (after a prompt-size or
// custom prompt change) and re-render the first message.
export async function refreshSystemPrompt(state, refs) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  const r = await fetchJson(
    '/api/chats/' + encodeURIComponent(chatId) +
    '/system-prompt?projectDir=' + encodeURIComponent(projectDir)
  );
  state.systemPrompt = r.status === 200 ? r.body : null;
  renderSystemPromptMessage(refs, state.systemPrompt);
}

// refreshChatTitle(state, refs)
export async function refreshChatTitle(state, refs) {
  const { projectDir, chatId } = state.props;
  if (!projectDir || !chatId) return;
  try {
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir));
    if (r.status === 200 && r.body && r.body.chat) {
      state.chat = r.body.chat;
      if (refs.chatName.current) refs.chatName.current.textContent = state.chat.title || chatId;
    }
  } catch { /* non-fatal */ }
}

// renameChat(state, refs)
export function renameChat(state, refs) {
  if (!state.chat) return;
  const next = prompt('Rename chat', state.chat.title || state.props.chatId);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === state.chat.title) return;
  updateChat({ title: trimmed }, state, refs).then(() => {
    if (state.chat && refs.chatName.current) refs.chatName.current.textContent = state.chat.title || state.props.chatId;
  });
}

// deleteThisChat(state, refs)
export function deleteThisChat(state, refs) {
  if (!state.chat) return;
  if (!confirm('Delete this chat? Its messages will be removed; any exported trace file will be kept.')) return;
  const { projectDir, chatId } = state.props;
  fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' })
    .then((r) => {
      if (r.status === 200) { projectsReload.value++; nav('projects'); }
      else if (refs.status.current) refs.status.current.textContent = 'delete failed: HTTP ' + r.status;
    })
    .catch(() => { if (refs.status.current) refs.status.current.textContent = 'network error'; });
}

// setPromptSize(v, state, refs, updateChatFn)
//
// Shared setter for the in-transcript setup control. The prompt
// size is chosen once, while the chat is still empty; the control
// is not a permanent fixture (see updateSetupVisibility below).
export function setPromptSize(v, state, refs) {
  if (['very-small', 'average', 'extensive', 'chat'].indexOf(v) < 0) return;
  updateSwitch(v, refs);
  updateChat({ promptSize: v }, state, refs).then(() => { refreshSystemPrompt(state, refs); });
}

// updateSwitch(id, refs)
//
// Reflect the active profile in the in-transcript <select>. The
// select is updated by toggling `selected` on the matching
// <option> — not by setting `value` on the <select>.
export function updateSwitch(id, refs) {
  const host = refs.setupCard.current;
  if (!host) return;
  const opts = host.querySelectorAll('option');
  for (const o of opts) {
    if (o.value === id) o.setAttribute('selected', '');
    else o.removeAttribute('selected');
  }
}

// updateSetupVisibility(state, refs)
//
// The setup control is a CREATION-TIME widget: it is only mounted
// while the chat has no messages yet. Once any message exists the
// control is removed and never comes back — the prompt size is
// fixed for the life of the chat. Removing it (instead of hiding
// it) keeps the transcript clean: no empty shape behind later
// messages.
export function updateSetupVisibility(state, refs) {
  const empty = !state.messages || state.messages.length === 0;
  const host = refs.setupCard.current;
  if (empty) return; // already on screen; nothing to do
  if (host && host.parentNode) host.parentNode.removeChild(host);
  refs.setupCard.current = null;
}

export { setChatStatus };
