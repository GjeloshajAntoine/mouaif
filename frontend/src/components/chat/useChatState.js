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
import { fetchJson, loadModels } from '../../api.js';
import { nav } from '../../router.js';
import {
  renderModelPicker, refreshActiveProvider, refreshAllProviders, openModelPicker, closeModelPicker, onPickerSearch, activeProviderId, touchRecent
} from './modelPicker.js';
import {
  renderSystemPromptMessage, renderTranscript, appendMessageToTranscript, appendToolCallCard, appendToolResultCard, cancelTranscriptRender
} from './transcript.js';
import { buildToolsCard, toggleTool, toggleToolGroup, toggleAgentFiles } from './cards.js';
import { scrollTranscriptToBottom, isNearBottom, updateJumpButton, afterTranscriptAppend } from './scroll.js';
import { updateUsageSummary, refreshProviderCredit, updateProviderCredit, setChatStatus } from './usage.js';
import {
  updateMetaLine, refreshSystemPrompt, activeProfileId, updateSwitch, updateSetupVisibility
} from './meta.js';
import { autoresize, onComposerInput, onComposerKey, clearComposerDraft, queueComposerDraftSave } from './composer.js';
import { syncThinkingSelect } from './thinking.js';
import { send as sendTurn, runShellCommand, runMcpCommand, startStreamRecovery, stopStreamRecovery, reconcileRunningChat, loadPendingAuthorization, cancelRunningChat } from './stream.js';
import { subscribeLive, closeLive } from './live.js';
import { addImagesFromFiles } from './imageInput.js';

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
  const [composerText, setComposerText] = useState('');
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
  const chatSwitcherIdxRef = useRef(-1);
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

  // ---- DOM refs ----------------------------------------------
  const back = useRef(null);
  const chatName = useRef(null);
  const chatMeta = useRef(null);
  const usageSummaryRef = useRef(null);
  const providerCreditRef = useRef(null);
  const setupCard = useRef(null);
  const transcript = useRef(null);
  const modelPickerTrigger = useRef(null);
  const modelPickerPop = useRef(null);
  const modelPickerSearch = useRef(null);
  const modelPickerRefresh = useRef(null);
  const modelPickerList = useRef(null);
  const thinkingLevel = useRef(null);
  const thinkingLevelCustom = useRef(null);
  const promptInput = useRef(null);
  const imageInput = useRef(null);
  const draftSaveTimer = useRef(null);
  const sendBtn = useRef(null);
  const stopBtn = useRef(null);
  const status = useRef(null);
  const jumpBtn = useRef(null);
  const toolsCard = useRef(null);
  const agentFilesCard = useRef(null);

  // ---- High-frequency mutable state (refs, not useState) -----
  const pinnedToBottom = useRef(true);
  const pendingCount = useRef(0);
  const streaming = useRef(false);
  // Cheap change marker for the reconcile poll (see stream.js):
  // "count:latestTs" from GET /api/chats/:id/revision. Kept in sync
  // with the full transcript so the poll never re-fetches everything
  // unless the marker actually moved. (The old design also kept a
  // full JSON.stringify signature of every message for the recovery
  // poll — the revision marker replaced it.)
  const transcriptRevision = useRef('');
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
  // Stable-tick counter for the reload follow poll (reconcileRunningChat).
  // When a reloaded chat shows the server's `running` flag but the
  // transcript has stopped moving, we must settle instead of looping
  // "streaming…" forever (the SSE was cut; the server-side run may have
  // finished without clearing the marker visibly). Mirrors the backoff
  // stability logic used by stream recovery (runRecoveryTick).
  const watchingStableTicks = useRef(0);
  const watchingRun = useRef(false);
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
      get transcriptRevision() { return transcriptRevision.current; },
      set transcriptRevision(v) { transcriptRevision.current = v; },
      get _persistedModelPair() { return persistedModelPair.current; },
      set _persistedModelPair(v) { persistedModelPair.current = v; },
      get streaming() { return streaming.current; },
      set streaming(v) { streaming.current = v; },
      reconnect: reconnect.current,
      get watchingRun() { return watchingRun.current; },
      set watchingRun(v) { watchingRun.current = v; },
      get watchingStableTicks() { return watchingStableTicks.current; },
      set watchingStableTicks(v) { watchingStableTicks.current = v; },
      get runSettled() { return runSettled.current; },
      set runSettled(v) { runSettled.current = v; },
      get providerCredit() { return providerCredit.current; },
      set providerCredit(v) { providerCredit.current = v; },
      get toolAuth() { return toolAuth.current; },
      set toolAuth(v) { toolAuth.current = v instanceof Object && !Array.isArray(v) ? v : {}; },
      get mcpAuth() { return mcpAuth.current; },
      set mcpAuth(v) { mcpAuth.current = (v instanceof Object && !Array.isArray(v)) ? v : { mode: 'ask', allowlist: [], servers: {}, tools: {} }; },
      get thinkingLevel() { return thinkingLevelRef.current; },
      set thinkingLevel(v) { thinkingLevelRef.current = v; }
    };
  }
  const state = stateRef.current;
  state.props = { projectDir, chatId };

  const chatSwitcherTrigger = useRef(null);
  const chatSwitcherPop = useRef(null);

  const refs = {
    back, chatName, chatMeta, usageSummaryRef, usageSummary: usageSummaryRef, providerCreditRef,
    setupCard, transcript,
    modelPickerTrigger, modelPickerPop, modelPickerSearch, modelPickerRefresh, modelPickerList,
    thinkingLevel, thinkingLevelCustom,
    promptInput, imageInput, draftSaveTimer, sendBtn, stopBtn, status,
    jumpBtn, toolsCard, agentFilesCard,
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
  const updateChatBound = useCallback(async (patch) => {
    if (!projectDir || !chatId) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir }, patch || {}))
    });
    if (r.status !== 200) {
      if (status.current) status.current.textContent = 'HTTP ' + r.status;
      return;
    }
    state.chat = r.body.chat;
    state._persistedModelPair = (r.body.chat.providerId || '') + '|' + (r.body.chat.modelId || '');
    updateMetaLine(refs, state);
    refreshProviderCredit(state, refs);
    updateModelTriggerLocal();
  }, [projectDir, chatId]);

  function updateModelTriggerLocal() {
    const trig = modelPickerTrigger.current;
    if (!trig) return;
    const c = state.chat;
    const modelId = c && c.modelId ? c.modelId : '';
    const providerId = c && c.providerId ? c.providerId : '';
    const idEl = trig.querySelector('.chat-view__model-id');
    const provEl = trig.querySelector('.chat-view__model-provider');
    if (idEl) idEl.textContent = modelId || '(pick a model)';
    if (provEl) provEl.textContent = providerId || (state.providers.length ? '' : 'add a provider in Settings → Providers');
    trig.classList.toggle('is-empty', !modelId);
    trig.classList.toggle('no-providers', !state.providers.length);
    // Sync thinking level select — options come from the provider's
    // reported descriptor for the active model when available.
    syncThinkingSelect(refs, state);
  }

  // Wire the model-picker's onChatChanged hook so the head
  // elements re-render when updateChat fires.
  state._onChatChanged = () => updateModelTriggerLocal();
  // Re-sync the thinking dropdown when live model data arrives —
  // provider-reported descriptors replace the seeded/fallback options.
  state._onLiveModels = () => syncThinkingSelect(refs, state);
  state._openModelPicker = () => openModelPicker(state, refs);
  // The empty-state card in the picker can fire the same refresh
  // the head's ↻ button does, but it lives inside the picker
  // module (which doesn't import the hook), so we expose the
  // bound callback here.
  state._onRefreshAllProviders = () => refreshAllProviders(state, refs, (txt, st) => setChatStatus(refs, txt, st));
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
  const onToggleAgentFiles = useCallback((next) => toggleAgentFiles(next, state, refs, updateChatBound, () => refreshSystemPrompt(state, refs)), [updateChatBound]);
  const onToggleSkills = useCallback((next) => {
    state.skills = Object.assign({}, state.skills, { enabled: next });
    updateChatBound({ skills: next });
  }, [updateChatBound]);
  const onCancelRunning = useCallback(() => cancelRunningChat(state, refs), [projectDir, chatId]);
  const onPickerPickBound = useCallback((providerId, modelId) => {
    if (!providerId || !modelId) return;
    closeModelPicker(refs);
    if (state.chat && state.chat.providerId === providerId && state.chat.modelId === modelId) return;
    touchRecent(state, providerId, modelId);
    const next = Object.assign({}, state.chat, { providerId, modelId });
    state.chat = next;
    updateModelTriggerLocal();
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

  // ---- Initial load ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectDir || !chatId) return;
      try {
        const [rChat, rModels, rProviders, rMsgs, rPrompts, rSys, rTools, rMcp, rAgents] = await Promise.all([
          fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
          loadModels(projectDir),
          fetchJson('/api/ai/models/providers'),
          fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir)),
          fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)),
          fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/system-prompt?projectDir=' + encodeURIComponent(projectDir)),
          fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(projectDir)),
          fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir)),
          fetchJson('/api/agents?projectDir=' + encodeURIComponent(projectDir))
        ]);
        if (cancelled) return;
        if (rChat.status !== 200) {
          if (status.current) status.current.textContent = 'chat not found';
          renderModelPicker(state, refs);
          return;
        }
        const c = rChat.body.chat;
        state.chat = c;
        persistedModelPair.current = (c.providerId || '') + '|' + (c.modelId || '');
        messages.current = rMsgs.status === 200 ? (rMsgs.body.messages || []) : [];
        // Seed the seen-set from the freshly loaded transcript so the
        // first reconcile / recovery tick never re-adds a row that the
        // initial load already has.
        { const set = new Set(); for (const m of messages.current) { if (typeof m.seq === 'number') set.add(m.seq); } seenSeqs.current = set; }
        // Seed the reconcile marker so the first 1 s tick is a no-op
        // (no redundant full-list fetch right after load).
        const lastMsg = messages.current[messages.current.length - 1];
        transcriptRevision.current = messages.current.length + ':' + (lastMsg && lastMsg.ts ? lastMsg.ts : '');
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
        tools.current = {
          catalog: rTools.status === 200 && Array.isArray(rTools.body.tools) ? rTools.body.tools : [],
          filter: Array.isArray(c.tools) ? c.tools.slice() : null
        };
        // Seed the agent-files card from the chat record and project
        // gate. The project-level setting is the master switch: when
        // the project has it `false` the per-chat toggle cannot enable.
        const projectGate = rSys.status === 200 ? rSys.body.projectAgentFiles : null;
        const afEnabled = projectGate === false
          ? false
          : (typeof c.agentFiles === 'boolean') ? c.agentFiles : true;
        agentFiles.current = {
          files: (rSys.status === 200 && Array.isArray(rSys.body.agentFiles)) ? rSys.body.agentFiles.map(f => f.name) : [],
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
        if (chatName.current) chatName.current.textContent = c.title || chatId;
        state.thinkingLevel = c.thinkingLevel || '';
        // Sync thinking level select after initial load — options come
        // from the provider's reported descriptor when available.
        syncThinkingSelect(refs, state);
        updateMetaLine(refs, state);
        updateUsageSummary(state, null, refs);
        refreshProviderCredit(state, refs);
        updateModelTriggerLocal();

        // Render the transcript and model picker immediately with the
        // project-level model list. Then fire live model fetches in the
        // background — they update the picker when they arrive, but must
        // not block the initial render (the upstream can take up to 8 s).
        if (cancelled) return;
        // Tool catalog, MCP servers, agent files, skills, and authorization
        // live in refs for the imperative transcript renderer. Notify Preact
        // once after loading so ToolPopup receives those populated values.
        setToolDataStamp((value) => value + 1);
        renderModelPicker(state, refs);
        renderTranscriptBound();
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
          // Subscribe to the per-chat live stream so a reloaded page
          // (returning to a chat that lost its SSE socket) still renders
          // in-flight shell output and subagent activity into the tool
          // cards, instead of pinning them on "Waiting for results…"
          // until the run settles.
          subscribeLive(state, refs);
          loadPendingAuthorization(state, refs);
        } else {
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
    return { provider, ok: true, count: live.length };
  }

  // ---- Effects: outside-click, scroll pin, mcp expansion, ----
  //              stream cleanup, reconcile-running poll -------
  useEffect(() => {
    function onDocClick(e) {
      const pop = modelPickerPop.current;
      const trig = modelPickerTrigger.current;
      if (pop && !pop.hidden) {
        if (!(pop.contains(e.target) || (trig && trig.contains(e.target)))) closeModelPicker(refs);
      }
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
        if (modelPickerPop.current && !modelPickerPop.current.hidden) closeModelPicker(refs);
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
    // A ResizeObserver on the scroll container itself won't fire here:
    // its border box is fixed by the flex layout, only the *content*
    // height changes. So watch the content two ways: a MutationObserver
    // for streaming text nodes and DOM growth, and a capture-phase
    // `load` listener for images that change layout when they decode.
    // Either way, re-pin only while pinned and not during a chunked
    // render/backfill (which manages the scroll itself).
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
    let mo = null;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(repinIfPinned);
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
    };
  }, [projectDir, chatId]);

  useEffect(() => { usedTools.current = new Set(); }, [chatId]);
  // seq is chat-scoped; reset the seen-set with the chat so a stale
  // seq from a previous chat can never suppress a load.
  useEffect(() => { seenSeqs.current = new Set(); }, [chatId]);
  useEffect(() => { watchingStableTicks.current = 0; }, [chatId, projectDir]);
  useEffect(() => { runSettled.current = false; }, [chatId, projectDir]);
  useEffect(() => () => {
    stopStreamRecovery(state, refs);
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
      if (watchingRun.current) delay = 1000;
      else if (typeof document !== 'undefined' && document.visibilityState === 'hidden') delay = 6000;
      else delay = 3000;
      timer = setTimeout(tick, delay);
    }
    async function tick() {
      if (stopped) return;
      if (!streaming.current) await reconcileRunningChat(state, refs);
      schedule();
    }
    function onVisibility() {
      // Becoming visible: tick immediately instead of waiting out the
      // slow interval, then resume the fast cadence. Becoming hidden:
      // just reschedule at the slow cadence (no immediate tick).
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = null; }
      if (document.visibilityState === 'visible') tick();
      else schedule();
    }
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chatId, projectDir]);

  return {
    state, refs,
    imageAttachments, composerText, fileEditorOpen, runningVisible, authStamp, toolDataStamp,
    setImageAttachments, setFileEditorOpen,
    // Actions bound for direct use in the JSX
    send,
    updateChat: updateChatBound,
    onPickerPick: onPickerPickBound,
    onPickerSearch: () => onPickerSearch(refs, state),
    onRefreshAllProviders: () => refreshAllProviders(state, refs, (txt, st) => setChatStatus(refs, txt, st)),
    onOpenModelPicker: () => openModelPicker(state, refs),
    onCloseModelPicker: () => closeModelPicker(refs),
    onComposerKey: (e) => onComposerKey(e, send),
    onComposerInput: () => {
      setComposerText(refs.promptInput.current ? refs.promptInput.current.value : '');
      onComposerInput(refs, projectDir, chatId, updateChatBound);
    },
    onComposerPaste: (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && Array.from(files).some((f) => /^image\//i.test(f.type || ''))) {
        e.preventDefault();
        addImagesFromFiles(files, { setImageAttachments, setChatStatus: (txt, st) => setChatStatus(refs, txt, st) });
      }
    },
    onImagePickerChange: (e) => {
      addImagesFromFiles(e.currentTarget.files, { setImageAttachments, setChatStatus: (txt, st) => setChatStatus(refs, txt, st) });
    },
    onRemoveImage: (idx) => setImageAttachments((prev) => prev.filter((_, i) => i !== idx)),
    onJumpToBottom: () => scrollTranscriptToBottom(refs),
    onCancelRunning,
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
