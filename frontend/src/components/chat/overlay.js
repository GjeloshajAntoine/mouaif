// mouaif web — transient chat overlay cards
//
// Authorization and ask_user cards are not transcript rows: they are
// mounted beside the transcript while a run is paused. This helper is
// shared by the owner SSE stream, the follower live-replay stream, and
// the pending-auth poll so every path de-dupes and waits for transcript
// rendering the same way.
import { whenTranscriptSettled } from './transcript.js';
import { cssEscape } from './utils.js';

// authCardGuard(refs, callId) -> bool
//
// De-dupe authorization / ask_user cards. The live SSE stream, live
// replay stream, and reconcile poll can all see the same pending request.
// Both card types stamp `data-auth-call-id` on the card; if a card for
// this callId is already on screen, skip it.
//
// The standing card does not have to be another prompt: a `tool_call` /
// `tool_result` row card for the same call id counts too (`data-tool-id`
// on every tool card). That card is already the answer to "one call, one
// card" — appending the prompt beside it would show the same call twice,
// which is exactly what the user sees when the question keeps its own
// card after the call frames have landed (answer submitted from another
// tab or the OS notification, a tail sync that re-rendered the call row,
// or a `tool_call` frame that reached the transcript before the pending
// poll's deferred mount ran).
export function authCardGuard(refs, callId) {
if (!callId || !refs.transcript || !refs.transcript.current) return true;
const id = cssEscape(String(callId));
const existing = refs.transcript.current.querySelector(
'.tool-card--authorization[data-auth-call-id="' + id + '"],' +
'.tool-card--ask-user[data-auth-call-id="' + id + '"],' +
'[data-tool-id="' + id + '"]'
);
return !existing;
}

// mountOverlayCard(refs, callId, mountFn)
//
// Mount an ask_user / authorization overlay card so it actually lands
// on screen: wait for any in-flight chunked transcript render, skip the
// mount while the transcript is still empty (a rebuild would wipe the
// card), de-dupe by auth-call-id, and let the card scroll itself into
// view. Used by SSE events, live replay, nested subagent events, and the
// pending-auth poll.
export function removeOverlayCardByCallId(refs, callId) {
if (!callId || !refs.transcript || !refs.transcript.current) return;
const selector = '.tool-card--authorization[data-auth-call-id="' + cssEscape(String(callId)) + '"],' +
'.tool-card--ask-user[data-auth-call-id="' + cssEscape(String(callId)) + '"]';
for (const card of refs.transcript.current.querySelectorAll(selector)) card.remove();
}

export function removeOverlayCards(refs) {
if (!refs || !refs.transcript || !refs.transcript.current) return;
for (const card of refs.transcript.current.querySelectorAll('.tool-card--authorization[data-auth-call-id], .tool-card--ask-user[data-auth-call-id]')) {
card.remove();
}
}

export function mountOverlayCard(refs, callId, mountFn) {
whenTranscriptSettled(refs).then(() => {
if (!refs.transcript || !refs.transcript.current) return;
if (!authCardGuard(refs, callId)) return;
const t = refs.transcript.current;
const hasContent = t.children.length > 0
&& !(t.children.length === 1 && t.querySelector(':scope > .chat-view__empty'));
if (!hasContent) {
// The transcript hasn't painted yet (chat still loading, or a rebuild
// is about to wipe it). Mounting now would lose the card; the
// pending-auth poll re-mounts it once the transcript is up.
return;
}
mountFn();
});
}
