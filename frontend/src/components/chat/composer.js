// mouaif web — Chat composer (textarea + buttons)
//
// The bottom-of-the-screen input row: image attach, prompt
// textarea, send button, status pill. Autosize keeps the row at
// one line and grows to a max of ~140px before the textarea
// scrolls. Drafts are persisted on the chat record with a
// 250ms debounce so a chat re-opened in another tab picks up
// the in-progress text.

// autoresize(refs)
//
// 32px floor matches the CSS min-height on .chat-view__textarea
// and the send button's 32px square, so the single-line composer
// row lines up. 120px ceiling is the max multi-line height
// before the textarea scrolls.
export function autoresize(refs) {
  const el = refs.promptInput.current;
  if (!el) return;
  el.style.height = 'auto';
  const next = Math.min(120, Math.max(32, el.scrollHeight));
  el.style.height = next + 'px';
  // overflow-y is `hidden` in CSS so no scrollbar ever overlaps the
  // text while the box exactly fits the content. Once the content
  // exceeds the 120px ceiling the box stops growing, so scrolling
  // must come back or the tail of a long draft would be unreachable.
  el.style.overflowY = el.scrollHeight > 120 ? 'auto' : '';
}

// queueComposerDraftSave(value, projectDir, chatId, refs, updateChat)
//
// Debounce 250ms before persisting the draft. A re-entrant save
// clears the previous timer so typing fast doesn't queue up
// redundant PATCHes.
export function queueComposerDraftSave(value, projectDir, chatId, refs, updateChat) {
  if (!projectDir || !chatId) return;
  if (refs.draftSaveTimer.current) clearTimeout(refs.draftSaveTimer.current);
  refs.draftSaveTimer.current = setTimeout(() => {
    refs.draftSaveTimer.current = null;
    updateChat({ draft: value || '' }).catch(() => {});
  }, 250);
}

export function saveComposerDraftNow(value, refs, updateChat, extraPatch = {}) {
  if (refs.draftSaveTimer.current) {
    clearTimeout(refs.draftSaveTimer.current);
    refs.draftSaveTimer.current = null;
  }
  return updateChat(Object.assign({}, extraPatch, { draft: value || '' }));
}

// clearComposerDraft(projectDir, chatId, refs, updateChat)
//
// Cancel any pending debounce and persist an empty draft.
export function clearComposerDraft(projectDir, chatId, refs, updateChat) {
  return saveComposerDraftNow('', refs, updateChat, { draftAttachments: null });
}

// onComposerInput(refs, projectDir, chatId, updateChat)
export function onComposerInput(refs, projectDir, chatId, updateChat) {
  queueComposerDraftSave(refs.promptInput.current ? refs.promptInput.current.value : '', projectDir, chatId, refs, updateChat);
  autoresize(refs);
}

import { isAtMentionActive } from './atMention.js';

// onComposerKey(e, send, opts)
//
// Enter / Shift-Enter behavior is governed by `enterForNewline`
// (the app-level Chat defaults toggle, default true). When true,
// Enter inserts a newline and Ctrl/Cmd+Enter sends. When false,
// Enter sends and Shift-Enter inserts a newline. `isComposing` is
// checked so the IME's own Enter (which is also `key: Enter`)
// doesn't fire send mid-composition. When the @-mention popup is
// open, Enter is consumed by that popup and does not send.
export function onComposerKey(e, send, opts = {}) {
  const enterForNewline = opts.enterForNewline !== false;
  const isEnter = e.key === 'Enter';
  const cmdEnter = isEnter && (e.ctrlKey || e.metaKey);
  const shiftEnter = isEnter && e.shiftKey;
  // Always block Enter from submitting the composer while the IME is
  // composing or the @-mention popup owns the key.
  if (isEnter && !e.isComposing && !isAtMentionActive()) {
    if (cmdEnter) {
      // Ctrl/Cmd+Enter always sends, in either mode.
      e.preventDefault();
      send();
    } else if (enterForNewline) {
      // Enter = newline (default). Let the textarea insert it. Shift+Enter
      // already inserts a newline too, so nothing to do here.
    } else {
      // Enter = send; Shift+Enter = newline.
      if (!shiftEnter) {
        e.preventDefault();
        send();
      }
    }
  }
}
