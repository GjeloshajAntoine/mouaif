// mouaif web — agent network state bridge
//
// The transcript and the SSE handlers are imperative; the network dock is a
// Preact component. This store owns the current chat's network (see
// agentNetwork.js) and tells subscribers when its structure changed or when
// a message travels between two agents so the dock can animate it.
import {
  createAgentNetwork,
  ingestMessages,
  ingestStreamEvent,
  settleRunning
} from './agentNetwork.js';
import { fetchJson } from '../../api.js';

const listeners = new Set();
let chatKey = '';
let net = createAgentNetwork();
let emittedVersion = -1;
// Subagent rows older than the loaded page (see loadOlderAgentRows).
let olderRows = [];
let olderFetched = false;

function keyOf(state) {
  const p = (state && state.props) || {};
  return (p.projectDir || '') + '::' + (p.chatId || '');
}

function bind(state) {
  const key = keyOf(state);
  if (key === chatKey) return;
  chatKey = key;
  net = createAgentNetwork();
  emittedVersion = -1;
  olderRows = [];
  olderFetched = false;
}

function firstSeq(messages) {
  let min = Infinity;
  for (const m of messages) if (m && Number.isInteger(m.seq) && m.seq < min) min = m.seq;
  return min;
}

// A chat opens on its newest page only, so an idle chat whose delegations
// are older than that page would show no network. Fetch just the subagent
// rows (and user-row markers) below the page once per chat.
function loadOlderAgentRows(state) {
  if (olderFetched) return;
  const p = (state && state.props) || {};
  const before = firstSeq(state.messages);
  if (!p.projectDir || !p.chatId || !Number.isFinite(before) || before <= 0) return;
  olderFetched = true;
  const key = chatKey;
  const url = '/api/chats/' + encodeURIComponent(p.chatId) + '/agent-rows?projectDir=' +
    encodeURIComponent(p.projectDir) + '&beforeSeq=' + before;
  fetchJson(url).then((r) => {
    if (key !== chatKey || r.status !== 200 || !r.body || !Array.isArray(r.body.messages)) return;
    if (!r.body.messages.length) return;
    olderRows = r.body.messages;
    ingestMessages(net, rowsFor(state.messages));
    emit();
  }).catch(() => { if (key === chatKey) olderFetched = false; });
}

// The older rows not yet paged into the transcript, then the transcript.
function rowsFor(messages) {
  if (!olderRows.length) return messages;
  const before = firstSeq(messages);
  return olderRows.filter((m) => m.seq < before).concat(messages);
}

function emit(pulses) {
  if (net.version === emittedVersion && !(pulses && pulses.length)) return;
  emittedVersion = net.version;
  for (const listener of listeners) {
    try { listener(net, pulses || []); } catch { /* listener errors are isolated */ }
  }
}

// syncAgentNetwork(state) — fold the persisted transcript in. Cheap to call
// on every reconcile: rows already folded are skipped by id.
export function syncAgentNetwork(state) {
  if (!state || !Array.isArray(state.messages)) return;
  bind(state);
  ingestMessages(net, rowsFor(state.messages));
  emit();
  loadOlderAgentRows(state);
}

// agentNetworkEvent(state, parentCallId, kind, data) — one live frame.
// `parentCallId` is null for the chat's own top-level tool frames.
export function agentNetworkEvent(state, parentCallId, kind, data) {
  bind(state);
  const pulses = ingestStreamEvent(net, parentCallId, kind, data);
  emit(pulses);
}

// agentNetworkTurnEnded(state) — the parent turn finished; delegations it
// left unfinished ended with it.
export function agentNetworkTurnEnded(state) {
  bind(state);
  settleRunning(net);
  emit();
}

export function getAgentNetwork() {
  return net;
}

export function subscribeAgentNetwork(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
