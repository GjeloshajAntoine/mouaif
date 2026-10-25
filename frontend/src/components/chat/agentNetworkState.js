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

const listeners = new Set();
let chatKey = '';
let net = createAgentNetwork();
let emittedVersion = -1;

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
  ingestMessages(net, state.messages);
  emit();
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
