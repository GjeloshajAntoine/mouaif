// mouaif web — Chat state hook
//
// Builds the unified `state` object and the `refs` map consumed by
// every other chat/* module. State is a flat object (not a reducer)
// because the chat view's updates are scattered across many small
// actions and a reducer would just add ceremony. Refs hold the
// things that change too fast to live in render state: DOM nodes,
// streaming flags, scroll pinning, the reconnect timer, the
// in-flight MCP toggle set.
//
// The `state` object is mutable on purpose. The other modules don't
// re-render — they read state lazily on each event. Re-render
// triggers are limited to the few values that actually drive the
// outer JSX (chat, providers, etc.) and use `useState` instead of
// living on `state`.

import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { fetchJson, loadModels, loadApp } from '../../api.js';
import { nav } from '../../router.js';
import {
  refreshActiveProvider, refreshAllProviders, activeProviderId, touchRecent,
  loadPinned, togglePin, modelsForPicker, loadRecent, loadRecentFromServer
} from './modelPicker.js';
import {
  renderSystemPromptMessage, renderTranscript, appendMessageToTranscript, appendToolCallCard, appendToolResultCard, cancelTranscriptRender
} from './transcript.js';
import { buildToolsCard, toggleTool, toggleToolGroup, toggleAgentFiles, toggleSkills } from './cards.js';
import { scrollTranscriptToBottom, isNearBottom, updateJumpButton, afterTranscriptAppend } from './scroll.js';
import { updateUsageSummary, refreshProviderCredit, updateProviderCredit, setChatStatus } from './usage.js';
import {
  updateMetaLine, refreshSystemPrompt, activeProfileId, updateSwitch, updateSetupVisibility
} from './meta.js';
import { autoresize, onComposerInput, onComposerKey, clearComposerDraft, queueComposerDraftSave } from './composer.js';
import { syncThinkingSelect } from './thinking.js';
import { send as sendTurn, retryFailedTurn, runShellCommand, runMcpCommand, runCustomAction, runRestartCommand, startStreamRecovery, stopStreamRecovery, reconcileRunningChat, loadPendingAuthorization, cancelRunningChat, loadOlderMessages } from './stream.js';
import { subscribeLive, closeLive } from './live.js';
import { addImagesFromFiles, removeImageAttachment } from './imageInput.js';
import { rebaseAnnotationStarts, toPublicImageAttachments } from './annotation.js';
import { createPager, recordInitialPage, shouldLoadOlder } from './pagination.js';
import { costSnapshot } from './costSummary.js';

// useChatState(props) -> { state, refs, actions, ui }
//
// The big hook. Returns:
//
//   - state:    mutable bag used by imperative modules
//   - refs:     stable DOM + hot-path refs
//   - actions:  bound action creators (closures over state/refs)
//   - ui:       useState values that drive re-renders
export function useChatState(props) {
  const { projectDir, chatId } = props;

  // ---- useState values that drive re-renders -----------------
  // `imageAttachments` and `composerText` are the reference reactive
  // state for the composer. `chat` / `providers` / `loading` used to be
  // useState too, but nothing rendered from them (ChatView never reads
  // them) — they only existed to force pointless re-renders of the whole
  // view. They now live purely on the imperative `state` bag below.
  const [imageAttachments, setImageAttachmentsState] = useState([]);
  const [composerText, setComposerTextState] = useState('');
  const [fileEditorOpen, setFileEditorOpen] = useState(false);
  const [runningVisible, setRunningVisible] = useState(false);
  // Bumped after every successful tool/MCP authorization save. ChatView
  // passes it to the ToolPopup so the popup re-renders with fresh auth
  // segments (the chat tools card re-renders imperatively instead).
  const [authStamp, setAuthStamp] = useState(0);
  const [toolDataStamp, setToolDataStamp] = useState(0);
  const [chatSwitcherOpen, setChatSwitcherOpen] = useState(false);
  const [chatSwitcherList, setChatSwitcherList] = useState([]);
  const [chatSwitcherLoading, setChatSwitcherLoading] = useState(false);
const [customActions, setCustomActions] = useState([]);
const chatSwitcherIdxRef = useRef(-1);
  // One React state value is the model picker's source of truth for the
  // rendered UI. The imperative chat bag still feeds streaming helpers,
  // but a sync produces one atomic props snapshot instead of six mirrors
  // that can briefly describe different picker states.
  const [picker, setPicker] = useState(() => ({
    models: [],
    value: null,
    pinned: new Set(),
    recent: [],
    open: false,
    providers: []
  }));
  // Every requested close invalidates any in-flight Recent fetch so a late
  // response cannot reveal a picker the user has already dismissed.
  const pickerOpenRequest = useRef(0);
  const setPickerOpen = useCallback((open) => {
    if (!open) pickerOpenRequest.current += 1;
    setPicker((current) => current.open === open ? current : { ...current, open });
  }, []);
  // Pagination state for the chat switcher, shared by the preload
  // effect and the scroll handler so they advance ONE footer. `offset`
  // is how many rows have been fetched so far; `total` is the server's
  // reported chat count (started at Infinity until the first fetch
  // returns). These used to live in DOM data-attributes that the JSX
  // initialized statically (`data-total="0"`), which the scroll guard
  // misread as "all loaded" — and the fetch always started at page 0,
  // so rows beyond the first 100 could never be reached.
  const chatSwitcherPager = useRef({ projectDir: '', offset: 0, total: Infinity, loading: false });

  // imageAttachments gets a ref mirror so the imperative `state`
  // bag can read the live value on demand (stream.js:send reads
  // `state.imageAttachments` without a re-render). Functional
  // updater form is supported: both the ref and the useState mirror
  // are updated together.
  const imageAttachmentsRef = useRef([]);
  function setImageAttachments(v) {
    imageAttachmentsRef.current = typeof v === 'function' ? v(imageAttachmentsRef.current) : v;
    setImageAttachmentsState(imageAttachmentsRef.current);
  }
  const composerTextRef = useRef('');
  function setComposerText(value) {
    composerTextRef.current = typeof value === 'string' ? value : '';
    setComposerTextState(composerTextRef.current);
  }

  // ---- DOM refs ----------------------------------------------
  const back = useRef(null);
  const chatName = useRef(null);
  const chatMeta = useRef(null);
  const usageSummaryRef = useRef(null);
  const providerCreditRef = useRef(null);
  const setupCard = useRef(null);
  const transcript = useRef(null);
  const thinkingLevel = useRef(null);
  const thinkingLevelCustom = useRef(null);
  const maxOutputTokens = useRef(null);
  const promptInput = useRef(null);
  const imageInput = useRef(null);
  const draftSaveTimer = useRef(null);
  const sendBtn = useRef(null);
  const stopBtn = useRef(null);
  const status = useRef(null);
  const jumpBtn = useRef(null);
  const toolsCard = useRef(null);
  const agentFilesCard = useRef(null);
  const skillsCard = useRef(null);

  // ---- High-frequency mutable state (refs, not useState) -----
  const pinnedToBottom = useRef(true);
  const pendingCount = useRef(0);
  const streaming = useRef(false);
  // Append-only cursor for the reconcile/recovery poll (see stream.js):
// the next persisted message seq the client has merged.
const transcriptNextSeq = useRef(0);
// Transient live-tool cursor (`/live?fromLiveSeq=`), separate from
// persisted message seq because shell/subagent/progress chunks are not
// transcript rows.
const nextLiveSeq = useRef(0);
// "providerId|modelId" of the pair last persisted on the server
  // (from the load response or a successful PATCH). Lets send() skip
  // the redundant per-turn PATCH when the record is already current.
  const persistedModelPair = useRef('');
const messages = useRef([]);
const models = useRef([]);
const liveByProvider = useRef({});
const prompts = useRef([]);
const pickerFilter = useRef({ q: '', provider: 'all' });
const systemPrompt = useRef(null);
const tools = useRef({ catalog: [], filter: null });
const agentFiles = useRef({ files: [], enabled: true, explicit: false });
const skills = useRef({ items: [], enabled: true, projectLocked: false });
const mcpServers = useRef([]);
// Backward-pagination cursor for the transcript scroll-up loader. A
// single object per chat (reset on chat change): only the newest page
// of a long transcript loads on open; older pages fetch on demand.
const msgPager = useRef(null);
  // Project agents (subagent delegation personas). Feeds the @-mention
  // popup's Agents section and the leading @agent <task> direct dispatch.
  const agents = useRef([]);
  // Tool authorization state — same shape as SettingsProject shellAuth etc.
  // { shell: { mode, allowlist }, file: { mode, allowlist }, subagent: { mode, allowlist }, ask_user: { mode } }
  const toolAuth = useRef({});
  // MCP authorization (layered, decisions §18): the shared gate plus the
  // persisted per-server / per-tool override maps from GET
  // /api/tools/authorization. Feeds the MCP Off/Ask/Allow segments in
  // the tools card; writes go through state._saveMcpAuth.
  // { mode, allowlist, servers: { <slug>: { mode, allowlist? } }, tools: { <composed>: { mode } } }
  const mcpAuth = useRef({ mode: 'ask', allowlist: [], servers: {}, tools: {} });
  // Track the current thinking level (survives re-renders, unlike
  // a plain state property that resets on every render cycle).
  const thinkingLevelRef = useRef('');
  // Track the current per-chat max output tokens (empty = provider default).
  const maxOutputTokensRef = useRef('');
// Composer keyboard default (app-level Chat defaults). When true, Enter
// inserts a newline; Ctrl/Cmd+Enter sends. Ref-backed so the hot-path
// key handler reads the live value without re-rendering.
const enterForNewlineRef = useRef(true);
// App-level "auto-retry failed sends" default (on by default). Read
// on the send hot path so failed turns can re-run without a render.
const autoRetryRef = useRef(true);
  // Track which tools have been called in this chat session.
  // Used to auto-check tools in the visibility tree.
  const usedTools = useRef(new Set());
  // Stable per-row identity set. Populated from the server's `seq`
  // (both storage backends now emit it). Merging incoming rows keyed
  // by this set — NOT by array length or role+ts — is what prevents
  // the optimistic user message / live assistant bubble from being
  // re-added when the server's persisted copy crosses the wire on the
  // next reconcile, and prevents a reconnect from re-fetching rows it
  // already merged. Reset per chat: seq is chat-scoped.
  const seenSeqs = useRef(new Set());
  const reconnect = useRef({ active: false, attempts: 0, timer: null, stopped: false, partialText: '' });
// Ref the single poll effect populates so stream recovery (which is
// folded into that same poll) can kick it immediately when the SSE
// drops mid-turn, instead of waiting out the idle 3 s/6 s interval.
const kickPoll = useRef(null);
  // Stable-tick counter for the reload follow poll (reconcileRunningChat).
  // When a reloaded chat shows the server's `running` flag but the
  // transcript has stopped moving, we must settle instead of looping
  // "streaming…" forever (the SSE was cut; the server-side run may have
  // finished without clearing the marker visibly). Mirrors the backoff
  // stability logic used by the stream-recovery path (recoverFromDisk).
  const watchingStableTicks = useRef(0);
  const watchingRun = useRef(false);
  // State for the follower live-replay socket (`/api/chats/:id/live`).
  // The reconcile poll uses this to distinguish a genuinely active but
  // quiet run (live socket connected, no transcript movement yet) from a
  // stale/torn running flag. Keep it outside Preact render state: it is a
  // hot-path transport marker, not view data.
  const liveRun = useRef({ key: '', active: false, connected: false, ended: false, failed: false });
  // Latch for a settled "torn" run. When a chat's server `running`
  // flag is stale (the run finished while we were away, or its SSE
  // socket died without clearing the flag), reconcileRunningChat
  // settles it as done — but the server flag never clears, so the
  // NEXT poll sees `running: true` and flips back to "streaming…"
  // with the stop button, forever oscillating done/streaming. Once we
  // settle a torn run, this latch keeps it settled UNTIL a genuinely
  // new turn lands on disk (a revision change moves the latch to
  // false), which is the only real signal that a fresh run started.
  const runSettled = useRef(false);
  // Chat + provider WILL data. These were formerly dual (ref + useState)
  // to drive whole-view re-renders; nothing renders from them, so they
  // live only here and are exposed on `state` as plain accessors.
  const chat = useRef(null);
  const providers = useRef([]);
  const providerCredit = useRef(null);

  // ---- The mutable `state` bag for the imperative modules ----
  // The chat is imperative by design (DOM writes for the stream, transcript,
  // model picker, tool cards). `state` is the single data bag those modules
  // share. It is created ONCE per mount (lazily below) with accessor
  // properties backed by the refs above, so:
  //   - `state.<field>` reads the live value on demand (no re-render);
  //   - `state.<field> = v` writes it in place (no re-render);
  //   - ad-hoc dynamic props helpers assign (state.recentModels,
  //     state.providerCredit, …) PERSIST across renders instead of being
  //     wiped when the object used to be rebuilt every render.
  // Only `state.props` is refreshed each render below so a chat/project
  // change without remount keeps the new identity. The few values that
  // actually drive JSX (imageAttachments, composerText, runningVisible, …)
  // live in useState and are returned separately — `state` never triggers
  // a render.
  const stateRef = useRef(null);
  if (!stateRef.current) {
    stateRef.current = {
      props: { projectDir, chatId },
      _setRunningVisible: setRunningVisible,
      _kickPoll: () => { if (kickPoll.current) kickPoll.current(); },
      get chat() { return chat.current; },
      set chat(v) { chat.current = v; },
      get providers() { return providers.current; },
      set providers(v) { providers.current = Array.isArray(v) ? v : []; },
      get imageAttachments() { return imageAttachmentsRef.current; },
      set imageAttachments(v) { imageAttachmentsRef.current = v; },
      get messages() { return messages.current; },
      set messages(v) { messages.current = v; },
      get models() { return models.current; },
      set models(v) { models.current = v; },
      get liveByProvider() { return liveByProvider.current; },
      set liveByProvider(v) { liveByProvider.current = v; },
      get prompts() { return prompts.current; },
      set prompts(v) { prompts.current = v; },
      get pickerFilter() { return pickerFilter.current; },
      set pickerFilter(v) { pickerFilter.current = v; },
      get systemPrompt() { return systemPrompt.current; },
      set systemPrompt(v) { systemPrompt.current = v; },
      get tools() { return tools.current; },
      set tools(v) { tools.current = v; },
      get agentFiles() { return agentFiles.current; },
      set agentFiles(v) { agentFiles.current = v; },
      get skills() { return skills.current; },
      set skills(v) { skills.current = v; },
      get mcpServers() { return mcpServers.current; },
      set mcpServers(v) { mcpServers.current = v; },
      get agents() { return agents.current; },
      set agents(v) { agents.current = Array.isArray(v) ? v : []; },
      get usedTools() { return usedTools.current; },
      set usedTools(v) { usedTools.current = v instanceof Set ? v : new Set(v || []); },
      get seenSeqs() { return seenSeqs.current; },
      set seenSeqs(v) { seenSeqs.current = v instanceof Set ? v : new Set(v || []); },
      get transcriptNextSeq() { return transcriptNextSeq.current; },
      set transcriptNextSeq(v) { transcriptNextSeq.current = v; },
      get nextLiveSeq() { return nextLiveSeq.current; },
      set nextLiveSeq(v) { nextLiveSeq.current = v; },
      get _persistedModelPair() { return persistedModelPair.current; },
      set _persistedModelPair(v) { persistedModelPair.current = v; },
      get streaming() { return streaming.current; },
      set streaming(v) { streaming.current = v; },
      reconnect: reconnect.current,
      get watchingRun() { return watchingRun.current; },
      set watchingRun(v) { watchingRun.current = v; },
      get watchingStableTicks() { return watchingStableTicks.current; },
      set watchingStableTicks(v) { watchingStableTicks.current = v; },
      get liveRun() { return liveRun.current; },
      set liveRun(v) { liveRun.current = v && typeof v === 'object' ? v : { key: '', active: false, connected: false, ended: false, failed: false }; },
      get runSettled() { return runSettled.current; },
      set runSettled(v) { runSettled.current = v; },
      get providerCredit() { return providerCredit.current; },
      set providerCredit(v) { providerCredit.current = v; },
      get toolAuth() { return toolAuth.current; },
      set toolAuth(v) { toolAuth.current = v instanceof Object && !Array.isArray(v) ? v : {}; },
      get mcpAuth() { return mcpAuth.current; },
      set mcpAuth(v) { mcpAuth.current = (v instanceof Object && !Array.isArray(v)) ? v : { mode: 'ask', allowlist: [], servers: {}, tools: {} }; },
      get thinkingLevel() { return thinkingLevelRef.current; },
      set thinkingLevel(v) { thinkingLevelRef.current = v; },
      get maxOutputTokens() { return maxOutputTokensRef.current; },
      set maxOutputTokens(v) { maxOutputTokensRef.current = v; },
get enterForNewline() { return enterForNewlineRef.current; },
set enterForNewline(v) { enterForNewlineRef.current = !!v; },
get autoRetry() { return autoRetryRef.current; },
set autoRetry(v) { autoRetryRef.current = !!v; }
};
}
const state = stateRef.current;
state.props = { projectDir, chatId };
state.customActions = customActions;
state._setCustomActions = (actions) => {
const next = Array.isArray(actions) ? actions : [];
if (JSON.stringify(state.customActions || []) === JSON.stringify(next)) return;
state.customActions = next;
setCustomActions(next);
};

  const chatSwitcherTrigger = useRef(null);
  const chatSwitcherPop = useRef(null);

  const refs = {
    back, chatName, chatMeta, usageSummaryRef, usageSummary: usageSummaryRef, providerCreditRef,
    setupCard, transcript,
    thinkingLevel, thinkingLevelCustom, maxOutputTokens,
    promptInput, imageInput, draftSaveTimer, sendBtn, stopBtn, status,
    jumpBtn, toolsCard, agentFilesCard, skillsCard,
    pinnedToBottom, pendingCount,
    chatSwitcherTrigger, chatSwitcherPop,
    _autoresize: () => autoresize({ promptInput })
  };

  // ---- Bound action creators --------------------------------
  // Most actions need to be stable (so the same identity is
  // passed to the JSX on every render). They only close over
  // refs, `state`, `refs`, and `updateChatBound`, so their
  // useCallback deps shrink to the props/identities that can
  // actually change: projectDir/chatId and updateChatBound.

  const refreshCustomActions = useCallback(async () => {
    if (!projectDir) return;
    try {
      const response = await fetchJson('/api/actions?projectDir=' + encodeURIComponent(projectDir));
if (response.status === 200 && Array.isArray(response.body && response.body.actions)) {
state.customActions = response.body.actions;
setCustomActions(response.body.actions);
}
} catch { /* keep the last known action list */ }
  }, [projectDir]);
  const updateChatBound = useCallback(async (patch) => {
    if (!projectDir || !chatId) return;
    const safePatch = Object.assign({}, patch || {});
    if (Object.prototype.hasOwnProperty.call(safePatch, 'draftAttachments') && Array.isArray(safePatch.draftAttachments)) {
      safePatch.draftAttachments = toPublicImageAttachments(safePatch.draftAttachments);
    }
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir }, safePatch))
    });
    if (r.status !== 200) {
      if (status.current) status.current.textContent = 'HTTP ' + r.status;
      return false;
    }
    state.chat = r.body.chat;
    state._persistedModelPair = (r.body.chat.providerId || '') + '|' + (r.body.chat.modelId || '');
    updateMetaLine(refs, state);
    refreshProviderCredit(state, refs);
    syncPickerState();
    return true;
  }, [projectDir, chatId]);

  function updateModelTriggerLocal() {
    // The trigger is now rendered declaratively by ModelPickerField, so
    // there is no imperative DOM to patch. Keep the thinking-level select
    // in sync with the active provider/model descriptor instead.
    syncThinkingSelect(refs, state);
  }
  // Rebuild the atomic props snapshot rendered by ModelPickerField.
  function syncPickerState() {
    const c = state.chat;
    setPicker((current) => ({
      models: modelsForPicker(state),
      providers: state.providers.map((p) => p && p.id).filter(Boolean),
      value: (c && c.providerId && c.modelId)
        ? { providerId: c.providerId, modelId: c.modelId }
        : null,
      pinned: loadPinned(state),
      recent: loadRecent(state),
      open: current.open
    }));
  }

// Open the picker synchronously so a tap never waits on the network —
// the recent-model fetch would otherwise hold the popover behind a DB
// round-trip on the slow path. Surface the sheet with whatever models we
// already have (project slugs + any live catalog already fetched), then
// refresh the Recent section in the background and land it in one render
// once the request resolves. Only reveal a fresh Recent row if this open
// is still the latest one (the user may have closed / reopened meanwhile).
function openPickerWithFreshRecent() {
const request = ++pickerOpenRequest.current;
const projectAtRequest = state.props && state.props.projectDir;
const c = state.chat;
setPicker({
models: modelsForPicker(state),
providers: state.providers.map((p) => p && p.id).filter(Boolean),
value: (c && c.providerId && c.modelId)
? { providerId: c.providerId, modelId: c.modelId }
: null,
pinned: loadPinned(state),
recent: loadRecent(state),
open: true
});
// Fire-and-forget the server-backed Recent refresh. It lands in a later
// render only if the picker is still open for the same project.
loadRecentFromServer(state).then((refreshed) => {
if (!refreshed || request !== pickerOpenRequest.current || !state.props || state.props.projectDir !== projectAtRequest) return;
const c2 = state.chat;
setPicker((current) => {
if (!current.open) return current;
return {
...current,
models: modelsForPicker(state),
providers: state.providers.map((p) => p && p.id).filter(Boolean),
value: (c2 && c2.providerId && c2.modelId)
? { providerId: c2.providerId, modelId: c2.modelId }
: current.value,
recent: loadRecent(state)
};
});
});
}

  // Wire the model-picker's onChatChanged hook so the head
  // elements re-render when updateChat fires.
  state._onChatChanged = () => updateModelTriggerLocal();
  // Re-sync the thinking dropdown when live model data arrives —
  // provider-reported descriptors replace the seeded/fallback options.
  state._onLiveModels = () => { syncThinkingSelect(refs, state); syncPickerState(); };
  state._openModelPicker = () => { openPickerWithFreshRecent(); };
  // The empty-state card in the picker can fire the same refresh
  // the head's ↻ button does, but it lives inside the picker
  // module (which doesn't import the hook), so we expose the
  // bound callback here.
  state._onRefreshAllProviders = () => refreshAllProviders(state, refs);
  // Re-render the tools card when a tool is marked as used (called
  // from the SSE stream handler). This swaps the DOM subtree in
  // place so the "used" badge appears without a full transcript
  // rebuild.
  state._updateToolsCard = () => {
    if (refs.toolsCard.current && refs.toolsCard.current.parentNode) {
      const fresh = buildToolsCard(state);
      refs.toolsCard.current.parentNode.replaceChild(fresh, refs.toolsCard.current);
      refs.toolsCard.current = fresh;
    }
  };

  state._runCustomAction = (action) => runCustomAction(action, state, refs);
state._runRestartCommand = (reason) => runRestartCommand(reason, state, refs, {
clearComposerDraft: () => clearComposerDraft(projectDir, chatId, refs, updateChatBound),
setImageAttachments
});
const send = useCallback(async () => {
try {
await sendTurn(state, refs, {
        clearComposerDraft: () => clearComposerDraft(projectDir, chatId, refs, updateChatBound),
        setImageAttachments
      });
    } finally {
      // sendTurn clears the textarea on success, restores it on 409, and
      // clears it for direct tool runs. Re-read after it settles so the
      // send button's disabled state matches the actual composer content.
      setComposerText(refs.promptInput.current ? refs.promptInput.current.value : '');
    }
  }, [projectDir, chatId, updateChatBound]);

  const onToggleTool = useCallback((name, next) => {
    toggleTool(name, next, state, refs, updateChatBound);
    // The composer ToolPopup renders its tree from `state.tools`, which is
    // a mutable bag value — toggling a tool rewrites `state.tools` but does
    // not itself re-render ChatView, so the popup would keep showing a stale
    // tree (stale half-check / expanded groups). Bump the stamp so the popup
    // re-renders and recomputes its groups from the new filter.
    setToolDataStamp((v) => v + 1);
  }, [updateChatBound]);
  const onToggleToolGroup = useCallback((names, next) => {
    toggleToolGroup(names, next, state, refs, updateChatBound);
    setToolDataStamp((v) => v + 1);
  }, [updateChatBound]);
  const onToggleAgentFiles = useCallback((next) => {
    toggleAgentFiles(next, state, refs, updateChatBound, () => refreshSystemPrompt(state, refs));
    // Agent files live in the ref-backed state bag, so changing them
    // needs an explicit render stamp for the composer ToolPopup.
    setToolDataStamp((v) => v + 1);
  }, [updateChatBound]);
  const onToggleSkills = useCallback((next) => {
    toggleSkills(next, state, refs, updateChatBound, () => refreshSystemPrompt(state, refs));
    setToolDataStamp((v) => v + 1);
  }, [updateChatBound]);
  const onCancelRunning = useCallback(() => cancelRunningChat(state, refs), [projectDir, chatId]);
  const onPickerPickBound = useCallback((selection, legacyModelId) => {
    const providerId = selection && typeof selection === 'object' ? selection.providerId : selection;
    const modelId = selection && typeof selection === 'object' ? selection.modelId : legacyModelId;
    if (!providerId || !modelId) return;
    setPickerOpen(false);
    if (state.chat && state.chat.providerId === providerId && state.chat.modelId === modelId) return;
    touchRecent(state, providerId, modelId);
    const next = Object.assign({}, state.chat, { providerId, modelId });
    state.chat = next;
    setPicker((current) => ({
      ...current,
      value: { providerId, modelId },
      recent: loadRecent(state),
      open: false
    }));
    syncThinkingSelect(refs, state);
    refreshProviderCredit(state, refs);
    updateChatBound({ providerId, modelId });
  }, [updateChatBound]);
  state._onPickerPick = onPickerPickBound;
  state._updateChat = updateChatBound;

  // Imperative-to-declarative bridge: the modules in this folder
  // call `state._renderTranscript()` to ask the main view to
  // rebuild the transcript. This wraps renderTranscript from
  // transcript.js so it always uses fresh values.
  const renderTranscriptBound = useCallback(() => {
    renderTranscript(state, refs);
    updateSwitch(activeProfileId(state), refs);
  }, []);
  state._renderTranscript = renderTranscriptBound;
  state._retryFailedTurn = (payload) => retryFailedTurn(state, refs, payload);
  state._updateSetupVisibility = () => updateSetupVisibility(state, refs);
  state._toggleTool = onToggleTool;
  state._toggleToolGroup = onToggleToolGroup;
  state._toggleAgentFiles = onToggleAgentFiles;
  state._toggleSkills = onToggleSkills;

  // Save tool authorization (Off/Ask/Allow) directly to the server.
  // Used by the inline segment control in the chat tools card.
  // On success, re-render the tools card so the segment reflects the new mode.
  state._saveToolAuth = async (tool, mode, allowlist) => {
    const d = projectDir;
    if (!d) return;
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: d, tools: { [tool]: { mode, allowlist: allowlist || [] } } })
    });
    if (r.status === 200) {
      // Sync local auth state.
      const prev = toolAuth.current;
      toolAuth.current = Object.assign({}, prev, { [tool]: { mode, allowlist: allowlist || [] } });
      // Re-render the tools card so the segment reflects the new mode.
      if (state._updateToolsCard) state._updateToolsCard();
      // Re-render the composer ToolPopup (it reads the same auth state).
      setAuthStamp((n) => n + 1);
    }
  };

  // Save MCP authorization ({ mode?, servers?, tools? }) from the tools
  // card's MCP segments. Mirrors _saveToolAuth: PUT, merge the echoed
  // state, re-render the card in place.
  state._saveMcpAuth = async (patch) => {
    const d = projectDir;
    if (!d || !patch || typeof patch !== 'object') return;
    const r = await fetchJson('/api/tools/authorization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: d, mcp: patch })
    });
    if (r.status === 200 && r.body && r.body.mcp) {
      const m = r.body.mcp;
      const prev = mcpAuth.current;
      mcpAuth.current = {
        mode: (m && m.mode) || prev.mode,
        allowlist: m && Array.isArray(m.allowlist) ? m.allowlist : prev.allowlist,
        servers: (m && m.servers && typeof m.servers === 'object') ? m.servers : prev.servers,
        tools: (m && m.tools && typeof m.tools === 'object') ? m.tools : prev.tools
      };
      if (state._updateToolsCard) state._updateToolsCard();
      // Re-render the composer ToolPopup (it reads the same auth state).
      setAuthStamp((n) => n + 1);
    }
  };

  // Start an MCP server on demand from the chat tools tree's reload
  // control, then refresh both the servers list (status flips to ready)
  // and the tool catalog (its tools become live) and re-render the card
  // in place. A disabled (auth `off`) server is skipped — callTool would
  // refuse it; the reload control is only shown for enabled-but-stopped
  // servers anyway. Returns a boolean so the caller can show busy state.
  state._reloadMcpServer = async (serverId) => {
    const d = projectDir;
    if (!d || !serverId) return false;
    try {
      const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(serverId) + '/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: d })
      });
      if (r.status !== 200) return false;
      return true;
    } catch {
      return false;
    }
  };
  state._reloadMcpServerRefresh = async () => {
    const d = projectDir;
    if (!d) return;
    // Fresh servers list (status ready/stopped) + fresh catalog so the
    // tree reflects the started server's live tools.
    const [rSrv, rTools] = await Promise.all([
      fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(d)),
      fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(d))
    ]);
    if (rSrv.status === 200 && Array.isArray(rSrv.body.servers)) mcpServers.current = rSrv.body.servers;
    if (rTools.status === 200 && Array.isArray(rTools.body.tools)) {
      tools.current = Object.assign({}, tools.current, { catalog: rTools.body.tools });
    }
    setToolDataStamp((v) => v + 1);
    if (state._updateToolsCard) state._updateToolsCard();
  };

  // ---- Initial load ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectDir || !chatId) return;
      try {
        const [rChat, rModels, rProviders, rMsgs, rPrompts, rSys, rMcp, rAgents, rActions, app] = await Promise.all([
fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
loadModels(projectDir),
fetchJson('/api/ai/models/providers'),
fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir) + '&limit=100'),
fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)),
fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/system-prompt?projectDir=' + encodeURIComponent(projectDir)),
fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir)),
fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir)),
fetchJson('/api/actions?projectDir=' + encodeURIComponent(projectDir)),
loadApp({ force: true }).catch(() => null)
]);
        // The tool catalog is the ONE chat-load request that is not fast
        // to resolve: GET /api/tools/list auto-starts every configured MCP
        // server that isn't already running (see docs/features/mcp.md), which
        // on a cold start spawns child processes and can take seconds on the
        // first chat open after a restart. Awaiting it inside the Promise.all
        // above would hold back the transcript + model picker (which only need
        // the fast requests) behind a blank chat on every cold open. So the
        // catalog is fetched in the background: the chat renders immediately
        // with the fast data, then the tools card swaps in once the (slow)
        // catalog resolves below.
        if (cancelled) return;
        if (rChat.status !== 200) {
          if (status.current) status.current.textContent = 'chat not found';
          syncPickerState();
          return;
        }
        const c = rChat.body.chat;
        state.chat = c;
        // Composer keyboard default comes from the app-level Chat defaults
        // setting (default true = Enter inserts a newline). Falls back to true
        // when the app settings fetch failed or the key is absent.
const appSettings = (app && app.app) || {};
state.enterForNewline = typeof appSettings.enterForNewline === 'boolean' ? appSettings.enterForNewline : true;
state.autoRetry = typeof c.autoRetry === 'boolean'
? c.autoRetry
: (typeof appSettings.autoRetry === 'boolean' ? appSettings.autoRetry : true);
persistedModelPair.current = (c.providerId || '') + '|' + (c.modelId || '');
messages.current = rMsgs.status === 200 ? (rMsgs.body.messages || []) : [];
state.costSnapshot = rMsgs.status === 200 ? costSnapshot(rMsgs.body) : null;
// Seed the backward-pagination cursor from the windowed first page.
// Only the newest PAGE is in memory; older pages load on scroll-up.
msgPager.current = createPager();
recordInitialPage(msgPager.current, rMsgs.status === 200
? { messages: messages.current, total: rMsgs.body.total, hasMore: rMsgs.body.hasMore, beforeSeq: rMsgs.body.beforeSeq }
: { messages: [], total: 0, hasMore: false });
// Seed the seen-set from the freshly loaded transcript so the
// first reconcile / recovery tick never re-adds a row that the
// initial load already has.
{ const set = new Set(); for (const m of messages.current) { if (typeof m.seq === 'number') set.add(m.seq); } seenSeqs.current = set; }
// Seed the append cursor so the first 1 s tick is a no-op. The
// windowed first page still carries nextSeq (the authoritative total),
// so tail syncs continue to work unchanged.
transcriptNextSeq.current = rMsgs.status === 200 && rMsgs.body && typeof rMsgs.body.nextSeq === 'number'
? rMsgs.body.nextSeq
: (seenSeqs.current.size ? Math.max(...seenSeqs.current) + 1 : 0);
nextLiveSeq.current = 0;
models.current = (rModels && Array.isArray(rModels.models)) ? rModels.models : [];
        state.providers = rProviders.status === 200 ? (rProviders.body.providers || []) : [];
        // Seed the per-provider live cache with the project-level
        // records. Live fetches overwrite these.
        liveByProvider.current = {};
        for (const m of models.current) {
          if (!m || !m.id || !m.provider) continue;
          const arr = liveByProvider.current[m.provider] || (liveByProvider.current[m.provider] = []);
          const rec = { id: m.id, label: m.label, contextWindow: m.contextWindow };
          if (m.thinking) rec.thinking = m.thinking;
          arr.push(rec);
        }
        pickerFilter.current = { q: '', provider: 'all' };
        prompts.current = rPrompts.status === 200 ? (rPrompts.body.prompts || []) : [];
        systemPrompt.current = rSys.status === 200 ? rSys.body : null;
        // Tool catalog starts empty; the background fetch below fills it
        // in so the initial transcript render (which happens below) is
        // never blocked on MCP cold-start. filter comes straight off the
        // chat.
        tools.current = {
          catalog: [],
          filter: Array.isArray(c.tools) ? c.tools.slice() : null
        };
        // Seed the agent-files card from the chat record and project
        // gate. The project-level setting is the master switch: when
        // the project has it `false` the per-chat toggle cannot enable.
        const projectGate = rSys.status === 200 ? rSys.body.projectAgentFiles : null;
        const afEnabled = rSys.status === 200 && typeof rSys.body.agentFilesEnabled === 'boolean'
          ? rSys.body.agentFilesEnabled
          : (projectGate === false ? false : (typeof c.agentFiles === 'boolean') ? c.agentFiles : true);
        const afAvailable = rSys.status === 200 && Array.isArray(rSys.body.agentFilesAvailable)
          ? rSys.body.agentFilesAvailable
          : (Array.isArray(rSys.body && rSys.body.agentFiles) ? rSys.body.agentFiles : []);
        agentFiles.current = {
          files: afAvailable.map(f => f.name),
          enabled: afEnabled,
          explicit: typeof c.agentFiles === 'boolean',
          projectLocked: projectGate === false  // project has it off → toggle locked
        };
        const skillGate = rSys.status === 200 ? rSys.body.projectSkills : true;
        skills.current = {
          items: (rSys.status === 200 && Array.isArray(rSys.body.skills)) ? rSys.body.skills : [],
          enabled: skillGate !== false && c.skills !== false,
          projectLocked: skillGate === false
        };
        mcpServers.current = rMcp.status === 200 && Array.isArray(rMcp.body.servers) ? rMcp.body.servers : [];
        agents.current = rAgents.status === 200 && Array.isArray(rAgents.body.agents) ? rAgents.body.agents : [];
setCustomActions(rActions.status === 200 && Array.isArray(rActions.body.actions) ? rActions.body.actions : []);

        // Fetch tool authorization settings for the tools card segments.
        try {
          const authRes = await fetchJson('/api/tools/authorization?projectDir=' + encodeURIComponent(projectDir));
          if (authRes.status === 200 && authRes.body && authRes.body.tools) {
            const t = authRes.body.tools;
            const auth = {};
            if (t.shell) auth.shell = { mode: t.shell.mode || 'ask', allowlist: Array.isArray(t.shell.allowlist) ? t.shell.allowlist : [] };
            if (t.file) auth.file = { mode: t.file.mode || 'ask', allowlist: Array.isArray(t.file.allowlist) ? t.file.allowlist : [] };
            if (t.subagent) auth.subagent = { mode: t.subagent.mode || 'ask', allowlist: Array.isArray(t.subagent.allowlist) ? t.subagent.allowlist : [] };
            if (t.task) auth.task = { mode: t.task.mode || 'ask', allowlist: Array.isArray(t.task.allowlist) ? t.task.allowlist : [] };
if (t.webpreview) auth.webpreview = { mode: t.webpreview.mode || 'ask', allowlist: Array.isArray(t.webpreview.allowlist) ? t.webpreview.allowlist : [] };
if (t.restart_app) auth.restart_app = { mode: t.restart_app.mode || 'ask', allowlist: Array.isArray(t.restart_app.allowlist) ? t.restart_app.allowlist : [] };
if (t.report_progress) auth.report_progress = { mode: t.report_progress.mode || 'ask', allowlist: Array.isArray(t.report_progress.allowlist) ? t.report_progress.allowlist : [] };

            if (t.ask_user) auth.ask_user = { mode: t.ask_user.mode === 'off' ? 'off' : 'ask' };
            toolAuth.current = auth;
          }
          // MCP authorization: shared gate + per-server/per-tool maps.
          if (authRes.status === 200 && authRes.body && authRes.body.mcp) {
            const m = authRes.body.mcp;
            mcpAuth.current = {
              mode: (m && m.mode) || 'ask',
              allowlist: m && Array.isArray(m.allowlist) ? m.allowlist : [],
              servers: (m && m.servers && typeof m.servers === 'object') ? m.servers : {},
              tools: (m && m.tools && typeof m.tools === 'object') ? m.tools : {}
            };
          }
        } catch { /* keep empty auth */ }

        if (promptInput.current && !promptInput.current.value && typeof c.draft === 'string' && c.draft) {
          promptInput.current.value = c.draft;
          autoresize(refs);
        }
        if (promptInput.current) setComposerText(promptInput.current.value);
// Restore any pending image draft from the chat record.
if (Array.isArray(c.draftAttachments) && c.draftAttachments.length) {
  setImageAttachments(c.draftAttachments);
}
        if (chatName.current) chatName.current.textContent = c.title || chatId;
        state.thinkingLevel = c.thinkingLevel || '';
        state.maxOutputTokens = c.maxOutputTokens || '';
        // Sync thinking level select after initial load — options come
        // from the provider's reported descriptor when available.
        syncThinkingSelect(refs, state);
        updateMetaLine(refs, state);
        updateUsageSummary(state, null, refs);
        refreshProviderCredit(state, refs);
        syncPickerState();

        // Render the transcript and model picker immediately with the
        // project-level model list. Then fire live model fetches in the
        // background — they update the picker when they arrive, but must
        // not block the initial render (the upstream can take up to 8 s).
        if (cancelled) return;
        // Tool catalog, MCP servers, agent files, skills, and authorization
        // live in refs for the imperative transcript renderer. Notify Preact
        // once after loading so ToolPopup receives those populated values.
        setToolDataStamp((value) => value + 1);
        renderTranscriptBound();
        // Fetch the tool catalog in the background. The transcript just
        // painted with the fast data; the MCP cold-start inside
        // /api/tools/list may take seconds, so don't let it hold up
        // anything the user is already looking at. When it resolves,
        // swap the tools card in place (MCP server groups + authorization
        // segments appear) and bump the stamp so the ToolPopup sees the
        // populated catalog. Fire-and-forget: a failure leaves the
        // empty-catalog card, as it would if the request had raced load.
        (function fetchToolsCatalogBackground() {
          if (cancelled) return;
          fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(projectDir)).then((rTools) => {
            if (cancelled) return;
            tools.current = {
              catalog: rTools.status === 200 && Array.isArray(rTools.body.tools) ? rTools.body.tools : [],
              filter: Array.isArray(c.tools) ? c.tools.slice() : null
            };
            setToolDataStamp((value) => value + 1);
            if (state._updateToolsCard) state._updateToolsCard();
          }).catch(() => { /* keep empty catalog */ });
        })();
        // Fire live model fetches in the background (no await).
        (function fireLiveFetches() {
          if (activeProviderId(state)) {
            refreshActiveProvider(state, refs).catch(() => {});
          } else {
            const ps = state.providers.map((p) => p && p.id).filter(Boolean);
            if (ps.length) {
              Promise.all(ps.map((p) => fetchLiveForProviderLocal(p).catch(() => {}))).catch(() => {});
            }
          }
        })();
if (c.running) {
setRunningVisible(true);
// A retained ChatView may have settled an earlier torn-run snapshot while
// the user was on another page. Reopening a server-running chat must clear
// that latch before subscribing/polling, otherwise a pending approval that
// arrived while away is skipped as already done.
state.runSettled = false;
state.watchingStableTicks = 0;
state.pendingAuthCount = await loadPendingAuthorization(state, refs);
if (cancelled || state.props.projectDir !== projectDir || state.props.chatId !== chatId) return;
if (state.pendingAuthCount > 0) {
state.watchingRun = true;
setChatStatus(refs, 'waiting for you…', 'busy');
}
// Subscribe after the pending snapshot is mounted. Live replay still
// supplies output that happened while away, and call-id de-duping prevents
// the same authorization card from being shown twice.
subscribeLive(state, refs);
} else {
state.pendingAuthCount = 0;
setRunningVisible(false);
}
        updateSetupVisibility(state, refs);
        updateSwitch(activeProfileId(state), refs);
      } catch (err) {
        if (status.current) status.current.textContent = 'load failed';
      }
    }
    load();
    return () => { cancelled = true; };
  }, [projectDir, chatId]);

  // fetchLiveForProviderLocal — direct write into liveByProvider
  // without going through modelPicker.fetchLiveForProvider (which
  // expects the state to be passed by ref).
  async function fetchLiveForProviderLocal(provider) {
    const r = await fetchJson('/api/ai/models/live?provider=' + encodeURIComponent(provider));
    if (r.status !== 200) return { provider, ok: false, body: r.body, status: r.status };
    const live = Array.isArray(r.body && r.body.models) ? r.body.models : [];
    liveByProvider.current = Object.assign({}, liveByProvider.current, { [provider]: live });
    // Live data may carry per-model thinking descriptors that the
    // seeded project-level records lack — rebuild the dropdown options.
    syncThinkingSelect(refs, state);
    // The picker renders from modelsForPicker(state), which unions the
    // live cache — reflect the freshly fetched catalog in the sheet.
    syncPickerState();
    return { provider, ok: true, count: live.length };
  }

  // ---- Effects: outside-click, scroll pin, mcp expansion, ----
  //              stream cleanup, reconcile-running poll -------
  useEffect(() => {
    function onDocClick(e) {
      // The shared ModelPickerField closes itself on outside click and
      // Escape (see its own effect); nothing to do here for the picker.
      // Close chat switcher on outside click
      const swPop = refs.chatSwitcherPop && refs.chatSwitcherPop.current;
      const swTrig = refs.chatSwitcherTrigger && refs.chatSwitcherTrigger.current;
      if (swPop && !swPop.hidden && swTrig) {
        if (!swPop.contains(e.target) && !swTrig.contains(e.target)) {
          setChatSwitcherOpen(false);
        }
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        if (fileEditorOpen) { setFileEditorOpen(false); return; }
        setPickerOpen(false);
      }
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    autoresize(refs);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [fileEditorOpen]);

  useEffect(() => {
    const el = transcript.current;
    if (!el) return undefined;
    // Distinguish user scrolls from programmatic pin scrolls: a
    // programmatic `scrollTop = scrollHeight` in the rAF re-pin fires a
    // scroll event that would otherwise be indistinguishable from the
    // user dragging. We only ever set pinned=false from a *user* scroll,
    // so ignore the synthetic one we just caused.
let ignoreNextScroll = false;
function onScroll() {
if (ignoreNextScroll) { ignoreNextScroll = false; return; }
const near = isNearBottom(el);
if (near && !pinnedToBottom.current) {
pinnedToBottom.current = true;
pendingCount.current = 0;
updateJumpButton(refs);
} else if (!near && pinnedToBottom.current) {
pinnedToBottom.current = false;
updateJumpButton(refs);
}
// Backward pagination: reaching the top of a long transcript is the
// signal to load the next older page. Defer to the loader so it can
// latch its own in-flight flag; the loader preserves scroll position.
if (msgPager.current && shouldLoadOlder(msgPager.current, el.scrollTop)) {
loadOlderMessages(state, refs, msgPager.current).catch(() => {});
}
}
    el.addEventListener('scroll', onScroll, { passive: true });

    // Keep a pinned transcript glued to the bottom when its content
    // grows AFTER the append that triggered it: streaming token nodes,
    // late-decoding images, and markdown/tool-card DOM that reflows a
    // frame later all change scrollHeight without a new
    // afterTranscriptAppend call. The single-rAF re-pin in
    // scrollTranscriptToBottom missed all of these, so the view drifted
    // a few (or many) pixels above the newest content — the "scroll
    // issues" the user reported.
    //
    // Watch both sides of the scroll geometry. Mutations catch newly
    // appended text and nodes, while ResizeObserver catches changes that
    // do not mutate the transcript: the composer/header taking more room
    // from the viewport, or an existing message/tool card growing after
    // asynchronous layout. Observe each direct transcript row because the
    // container's own border box only reports viewport-size changes.
    // Re-pin only while pinned and not during a chunked render/backfill
    // (which manages the scroll itself).
    let repinScheduled = false;
    function repinIfPinned() {
      if (repinScheduled) return;
      repinScheduled = true;
      requestAnimationFrame(() => {
        repinScheduled = false;
        if (!pinnedToBottom.current) return;
        if (refs._suspendScrollPin || refs._insertAnchor) return;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return; // already at bottom
        ignoreNextScroll = true;
        el.scrollTop = el.scrollHeight;
      });
    }
    let ro = null;
    let observedRows = new Set();
    function observeTranscriptGeometry() {
      if (!ro) return;
      const nextRows = new Set(el.children);
      for (const row of observedRows) {
        if (!nextRows.has(row)) ro.unobserve(row);
      }
      for (const row of nextRows) {
        if (!observedRows.has(row)) ro.observe(row);
      }
      observedRows = nextRows;
    }
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(repinIfPinned);
      ro.observe(el);
      observeTranscriptGeometry();
    }
    let mo = null;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(() => {
        observeTranscriptGeometry();
        repinIfPinned();
      });
      mo.observe(el, { childList: true, subtree: true, characterData: true });
    }
    function onLoadCapture(e) {
      if (e && e.target && e.target.tagName === 'IMG') repinIfPinned();
    }
    el.addEventListener('load', onLoadCapture, true);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', onLoadCapture, true);
      if (mo) mo.disconnect();
      if (ro) ro.disconnect();
      observedRows.clear();
    };
  }, [projectDir, chatId]);

  useEffect(() => { usedTools.current = new Set(); }, [chatId]);
// seq is chat-scoped; reset the seen-set with the chat so a stale
  // seq from a previous chat can never suppress a load.
  useEffect(() => { seenSeqs.current = new Set(); }, [chatId]);
  // Scroll pinning is per-chat. ChatView is reused across chat
  // navigation (only props change, no remount), so a `pinnedToBottom`
  // left `false` by scrolling up in the previous chat would carry over
  // and make the next chat open scrolled up — its latest messages
  // hidden until the user scrolls manually. Reset to pinned on every
  // chat change so a newly opened chat always pins to the bottom.
  useEffect(() => {
    pinnedToBottom.current = true;
    pendingCount.current = 0;
    updateJumpButton(refs);
  }, [chatId, projectDir]);
  useEffect(() => { watchingStableTicks.current = 0; }, [chatId, projectDir]);
useEffect(() => { liveRun.current = { key: '', active: false, connected: false, ended: false, failed: false }; }, [chatId, projectDir]);
useEffect(() => { runSettled.current = false; }, [chatId, projectDir]);
  useEffect(() => () => {
    stopStreamRecovery(state);
    // Drop the per-chat live subscription so a backgrounded/closed tab
    // doesn't hold a socket for a chat the user left. The owner stream
    // keeps buffering regardless — returning re-subscribes and replays.
    closeLive(state);
    // Cancel any in-flight chunked transcript render so a navigate-away
    // can't write into a detached transcript.
    if (typeof cancelTranscriptRender === 'function') cancelTranscriptRender(refs);
  }, [projectDir, chatId]);

  // Preload the chat switcher list so the dropdown opens instantly
  // with cached rows (no network wait on first open). Refresh when
  // the chat changes or a run in this chat ends so the rows stay
  // current (recently auto-titled chats, stale running flags).
  // Resets the pager so the list always restarts at the top whenever
  // it is regenerated.
  useEffect(() => {
    if (!projectDir) return;
    const pager = { projectDir, offset: 0, total: Infinity, loading: false };
    chatSwitcherPager.current = pager;
    let cancelled = false;
    loadChatListForSwitcher(projectDir, pager, (rows) => {
      if (!cancelled && chatSwitcherPager.current === pager) setChatSwitcherList(rows);
    });
    return () => { cancelled = true; };
  }, [projectDir, chatId, runningVisible]);

  useEffect(() => {
    if (!chatId || !projectDir) return undefined;
    let stopped = false;
    let timer = null;
    // Poll cadence: 1 s while the tab is visible (the user is watching
    // the chat, possibly following a run from another tab); 5 s while
    // hidden — a backgrounded tab only needs eventual consistency and
    // a per-second tick is pure battery/network cost there.
    function schedule() {
      if (stopped) return;
      // Cadence:
      //  - watchingRun: 1 s — another tab is running THIS chat and the
      //    user is (or was) following it live; keep it snappy.
      //  - visible, idle: 3 s — still responsive enough to notice a
      //    run starting elsewhere, but an idle chat is no longer
      //    hammering /revision once a second forever.
      //  - hidden: 6 s — a backgrounded tab only needs eventual
      //    consistency and a slow tick is pure battery/CPU cost.
      let delay;
      // While recovering a dropped SSE turn, keep the same snappy 1 s
      // cadence as when following a run (recovery is a variant of that).
      if (reconnect.current.active || watchingRun.current) delay = 1000;
      else if (typeof document !== 'undefined' && document.visibilityState === 'hidden') delay = 6000;
      else delay = 3000;
      timer = setTimeout(tick, delay);
    }
    async function tick() {
      if (stopped) return;
      // Recovery syncs while `streaming` stays true (the local SSE died
      // but the turn is still in flight server-side); the idle reconcile
      // must NOT run over an active SSE. So: reconcile when recovering,
      // or when idle (not streaming).
      if (reconnect.current.active || !streaming.current) await reconcileRunningChat(state, refs);
      schedule();
    }
    // Expose a way for stream recovery to kick the poll immediately (it
    // may be parked at the idle 3 s/6 s interval). Reset any pending
    // timer and tick now.
    kickPoll.current = () => {
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = null; }
      tick();
    };
    function resumeNow() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      // Queue rather than calling tick directly so pageshow, focus, and
      // visibilitychange emitted in the same resume collapse to one sync.
      timer = setTimeout(tick, 0);
    }
    function onVisibility() {
      // Becoming visible: tick immediately instead of waiting out the
      // slow interval, then resume the fast cadence. Becoming hidden:
      // just reschedule at the slow cadence (no immediate tick).
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = null; }
      if (document.visibilityState === 'visible') resumeNow();
      else schedule();
    }
    function onPageShow() {
      // Installed PWAs can be restored from the page cache without a
      // visibility transition. Reconcile the retained ChatView in place.
      resumeNow();
    }
    function onWindowFocus() {
      // iOS standalone mode may foreground via focus only. The route does
      // not change, so use the same incremental revision sync as polling.
      if (document.visibilityState === 'visible') resumeNow();
    }
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [chatId, projectDir]);

  return {
    state, refs,
    imageAttachments, composerText, fileEditorOpen, runningVisible, authStamp, toolDataStamp, customActions,
setImageAttachments, setFileEditorOpen,
  setComposerText,
  // Reactive model-picker props (rendered by ModelPickerField)
  picker,
  // Actions bound for direct use in the JSX
send,
runCustomAction: (action) => runCustomAction(action, state, refs),
refreshCustomActions,
updateChat: updateChatBound,
    onPickerPick: onPickerPickBound,
    onPickerTogglePin: (m) => {
      if (!m) return;
      togglePin(state, m.provider, m.id);
      syncPickerState();
    },
    onPickerOpen: () => {
      // Seed the max-output-tokens input from the chat record when the
      // freshly populated sheet opens (the field lives in the children slot).
      if (refs.maxOutputTokens && refs.maxOutputTokens.current) {
        refs.maxOutputTokens.current.value = (state.chat && state.chat.maxOutputTokens) || state.maxOutputTokens || '';
      }
    },
    onRefreshAllProviders: () => refreshAllProviders(state, refs),
    onPickerOpenChange: (v) => {
      if (v) openPickerWithFreshRecent();
      else setPickerOpen(false);
    },
    onComposerKey: (e) => onComposerKey(e, send, {
enterForNewline: state.enterForNewline,
customActions: state.customActions
}),
    onComposerInput: () => {
const nextText = refs.promptInput.current ? refs.promptInput.current.value : '';
setImageAttachments((current) => rebaseAnnotationStarts(current, composerTextRef.current, nextText));
setComposerText(nextText);
onComposerInput(refs, projectDir, chatId, updateChatBound);
},
    onComposerPaste: (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && Array.from(files).some((f) => /^image\//i.test(f.type || ''))) {
        e.preventDefault();
        addImagesFromFiles(files, { setImageAttachments, setChatStatus: (txt, st) => setChatStatus(refs, txt, st), updateChat: updateChatBound });
      }
    },
    onImagePickerChange: (e) => {
      addImagesFromFiles(e.currentTarget.files, { setImageAttachments, setChatStatus: (txt, st) => setChatStatus(refs, txt, st), updateChat: updateChatBound });
    },
    onRemoveImage: (idx) => removeImageAttachment(idx, setImageAttachments, updateChatBound),
    onJumpToBottom: () => scrollTranscriptToBottom(refs),
onCancelRunning,
onToggleAutoRetry: () => {
state.autoRetry = !state.autoRetry;
updateChatBound({ autoRetry: state.autoRetry });
},
onBack: () => { window.location.hash = '#/projects'; },
    // ---- Chat switcher -------------------------------------------
    chatSwitcherOpen,
    setChatSwitcherOpen,
    chatSwitcherList,
    chatSwitcherLoading,
    onToggleChatSwitcher: useCallback(() => {
      setChatSwitcherOpen((prev) => !prev);
    }, []),
    // Scroll pagination: the switcher dropdown loads the first page
    // up front (preload); scrolling near the bottom fetches the next
    // page from the shared pager offset. No-op while a page is already
    // in flight or when every row is already loaded. The pagination
    // state lives in a ref (chatSwitcherPager), not DOM data-attributes
    // — the JSX can't know the server total, and DOM reads were stale,
    // so the load-more guard never fired for chats past the first page.
    onChatSwitcherScroll: useCallback((e) => {
      if (!projectDir) return;
      const pager = chatSwitcherPager.current;
      if (pager.projectDir !== projectDir) return;
      if (pager.loading) return;
      if (pager.offset >= pager.total) return;
      pager.loading = true;
      setChatSwitcherLoading(true);
      loadChatListForSwitcher(projectDir, pager, (rows) => {
        if (chatSwitcherPager.current !== pager || pager.projectDir !== projectDir) return;
        pager.loading = false;
        setChatSwitcherLoading(false);
        if (!rows.length) return;
        setChatSwitcherList((prev) => {
          const seen = new Set(prev.map((c) => c && c.id));
          return prev.concat(rows.filter((c) => c && !seen.has(c.id)));
        });
      });
    }, [projectDir]),
    onSwitchChat: useCallback((targetChatId) => {
      setChatSwitcherOpen(false);
      if (targetChatId && targetChatId !== chatId) {
        nav('chat/' + encodeURIComponent(targetChatId) + '?projectDir=' + encodeURIComponent(projectDir));
      }
    }, [projectDir, chatId])
  };
}

// Load the chat list for the chat switcher dropdown. Paginated: the
// API caps every page at 100 rows, so chat counts beyond that need
// multiple pages. `pager` ({ offset, total, loading }) is advanced so
// the preload and the scroll handler share one running offset — the
// fetch starts from `pager.offset` and records the server `total` so
// the guard knows when every row is loaded. The preload loads up to
// `opts.pages` pages at once; the scroll handler calls this once per
// page. `refresh(rows)` is called with each page as it arrives.
async function loadChatListForSwitcher(projectDir, pager, refresh, opts = {}) {
  if (!projectDir) return;
  const pageSize = 100;
  const pages = Math.max(1, Math.min(4, opts.pages || 1));
  try {
    for (let page = 0; page < pages; page++) {
      if (pager.offset >= pager.total) break;
      const r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(projectDir) + '&offset=' + pager.offset + '&limit=' + pageSize);
      const chats = r.status === 200 && r.body ? (r.body.chats || []) : [];
      if (r.status === 200 && r.body && typeof r.body.total === 'number') {
        pager.total = r.body.total;
      }
      pager.offset += chats.length;
      refresh(chats);
      if (chats.length < pageSize) break;
    }
  } catch {
    refresh([]);
  }
}
