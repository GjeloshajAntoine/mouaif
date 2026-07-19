// mouaif web — ChatView
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, lineNumbers } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { fetchJson, parseSSEFrame, projectsReload, loadModels, invalidateModelsCache, fetchLiveModels } from '../api.js';
import { nav } from '../router.js';
import { formatCost, formatTokPerSecond, formatTokens, createCounter } from '../usage.js';
import { renderMarkdown } from '../markdown.js';
import { FileEditorView } from './FileEditor.jsx';

// mergeModelLists(projectList, liveList) — dedupes by id, project
// entries win on conflict (user-defined slugs preserve their label/
// provider). Sort is alphabetical by id. Returned shape mirrors
// /api/ai/models: { id, provider, label, auth }.
function mergeModelLists(projectList, liveList) {
  const out = new Map();
  for (const m of (projectList || [])) {
    if (m && m.id) out.set(m.id, m);
  }
  for (const m of (liveList || [])) {
    if (!m || !m.id) continue;
    if (!out.has(m.id)) out.set(m.id, m);
  }
  return Array.from(out.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// groupModelsByProvider(list) — groups a flat model list into an
// array of { provider, items: [..] } sorted alphabetically by
// provider, with each section's items sorted by id. Empty / falsy
// entries are dropped. Used by the model-picker popover to render
// one section per provider.
function groupModelsByProvider(list) {
  const map = new Map();
  for (const m of (list || [])) {
    if (!m || !m.id || !m.provider) continue;
    let bucket = map.get(m.provider);
    if (!bucket) { bucket = []; map.set(m.provider, bucket); }
    bucket.push(m);
  }
  const out = [];
  for (const [provider, items] of map) {
    items.sort((a, b) => a.id.localeCompare(b.id));
    out.push({ provider, items });
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}


export function ChatView(props) {
  const chatId = props.chatId;
  const projectDir = props.projectDir;
  const back = useRef(null);
  const chatName = useRef(null);
  const chatMeta = useRef(null);
  const usageSummaryRef = useRef(null);
  const providerCreditRef = useRef(null);
  // The creation-time setup card lives in the TRANSCRIPT (above the
  // system message) instead of the head, so the prompt-size choice is
  // part of the message area and not a permanent fixture of the top
  // bar. The card is the only child of the transcript while the chat
  // is empty; it is removed by updateSetupVisibility when the first
  // message is sent. The ref tracks the element so setPromptSize
  // updates the active-button highlight in place without rebuilding.
  const setupCardRef = useRef(null);
  const transcript = useRef(null);
  // Model picker (replaces the old provider + model <select>s +
  // refresh icon). The trigger button shows the current model id
  // and provider and opens the picker; the popover holds a search
  // input, an All/<provider> filter, one section per provider, and
  // a header refresh button. See renderModelPicker /
  // openModelPicker / onPickerRefresh.
  const modelPickerTriggerRef = useRef(null);
  const modelPickerPopRef = useRef(null);
  const modelPickerSearchRef = useRef(null);
  const modelPickerRefreshRef = useRef(null);
  const modelPickerListRef = useRef(null);
  const promptInput = useRef(null);
  const imageInputRef = useRef(null);
  const [imageAttachments, setImageAttachments] = useState([]);
  const draftSaveTimerRef = useRef(null);
  const sendBtn = useRef(null);
  const statusEl = useRef(null);
  // Jump-to-bottom FAB. The transcript auto-scrolls while the user
  // is pinned to the bottom; once they scroll up mid-stream we stop
  // hijacking the scroll and show a floating "↓ N" button instead.
  // pendingCountRef counts messages/deltas appended while unpinned.
  const jumpBtnRef = useRef(null);
  const pinnedToBottomRef = useRef(true);
  const pendingCountRef = useRef(0);
  // Stream recovery. When the SSE connection drops mid-turn we poll
  // the persisted transcript (the server keeps writing to it) and
  // surface a manual "Resume" affordance after a few failed ticks.
  // reconnectStateRef: { active, attempts, timer, stopped }.
  const reconnectStateRef = useRef({ active: false, attempts: 0, timer: null, stopped: false });
  // File editor popup (CodeMirror) — toggled by the file-icon button
  // on the composer. The popup is rendered as a full-screen overlay
  // over the chat view; mounting/unmounting it on open/close keeps
  // the CodeMirror EditorView lifecycle simple and lets the popup
  // own its own state (open file, dirty flag, etc.).
  const fileEditorOpen = useState(false);
  const setFileEditorOpen = fileEditorOpen[1];

  function setChatStatus(text, state) {
    if (!statusEl.current) return;
    statusEl.current.textContent = text;
    if (state) statusEl.current.dataset.state = state;
    else delete statusEl.current.dataset.state;
  }

  // --- Jump-to-bottom helpers -------------------------------------
  // The transcript auto-scrolls to the newest message on every append
  // while the user is "pinned" to the bottom. Once they scroll up more
  // than a threshold we treat them as reading history: appends no
  // longer yank the view down, a floating "↓" button appears, and a
  // counter tracks how many new rows arrived in the meantime. Tapping
  // the button (or scrolling back to the very bottom) re-pins.
  function isNearBottom() {
    const el = transcript.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function scrollTranscriptToBottom() {
    const el = transcript.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Some appends render markdown or expand nested tool bodies after
    // this tick. Pin again on the next frame so streaming subagent
    // output doesn't stop a few pixels above the newest content.
    requestAnimationFrame(() => {
      if (pinnedToBottomRef.current && transcript.current === el) el.scrollTop = el.scrollHeight;
    });
    pinnedToBottomRef.current = true;
    pendingCountRef.current = 0;
    updateJumpButton();
  }

  function scrollToolBodyToBottom(descendant) {
    const body = descendant && descendant.closest && descendant.closest('.tool-card__body');
    if (!body) return;
    body.scrollTop = body.scrollHeight;
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }

  function updateJumpButton() {
    const btn = jumpBtnRef.current;
    if (!btn) return;
    const show = !pinnedToBottomRef.current && pendingCountRef.current > 0;
    btn.hidden = !show;
    if (show) {
      const label = btn.querySelector('.chat-view__jump-count');
      if (label) label.textContent = pendingCountRef.current > 99 ? '99+' : String(pendingCountRef.current);
    }
  }

  // Centralised "something was appended" hook. While pinned, keep the
  // view glued to the bottom; while unpinned, bump the FAB counter
  // instead of scrolling. Replaces the raw `scrollTop = scrollHeight`
  // assignments scattered through the append helpers.
  function afterTranscriptAppend(countNew) {
    if (pinnedToBottomRef.current || isNearBottom()) {
      scrollTranscriptToBottom();
    } else if (countNew) {
      pendingCountRef.current += 1;
      updateJumpButton();
    }
  }

  const chatRef = useRef(null);
  const messagesRef = useRef([]);
  const streamingRef = useRef(false);
  const transcriptSignatureRef = useRef('');
  const modelsRef = useRef([]);
  // liveByProviderRef — per-provider live catalogs fetched from
  // /api/ai/models/live, keyed by provider id. Project entries live
  // in modelsRef; live entries here. The model-picker popover
  // renders the union, grouped by provider, with project entries
  // winning on id collision.
  const liveByProviderRef = useRef({});
  const providersRef = useRef([]);
  const promptsRef = useRef([]);
  // pickerFilterRef — current model-picker search query and the
  // provider chip selected in the filter row. Empty search +
  // 'all' provider = no filter applied.
  const pickerFilterRef = useRef({ q: '', provider: 'all' });
  // The effective system context (resolved prompt-size profile + custom
  // prompt) as it will be sent upstream. Fetched from
  // /api/chats/:id/system-prompt and rendered as the first collapsible
  // message in the transcript, so the user sees what the model is told
  // without the prompt-size picker being a permanent fixture.
  const systemPromptRef = useRef(null);
  // toolsRef — the per-project tool catalog from /api/tools/list, plus
  // the chat's current `tools` filter. The catalog is the source of
  // truth for what can be toggled; the filter is the user's choice and
  // is persisted on the chat record (see updateChat). The toggle row
  // sits below the system-prompt message and remains available after
  // chat start; changes affect the next model turn.
  const toolsRef = useRef({ catalog: [], filter: null });
  // toolsCardRef — the per-chat toggle row mounted in the transcript.
  // setToolTogglesRender / updateToolToggles rebuild it in place;
  // toggleTool mutates one chip without a full rebuild so the visual
  // feedback is instant.
  const toolsCardRef = useRef(null);
  // MCP server config shown below the per-tool toggles on a brand-new
  // chat. These switches enable/disable the configured server; running
  // lifecycle still lives in Settings → MCP.
  const mcpServersRef = useRef([]);
  const mcpToggleBusyRef = useRef(new Set());
  // User-controlled collapsed state for the MCP server/tool list inside
  // the tools card. The list can grow long once several servers are
  // configured; let the user collapse it via the header arrow without
  // re-rendering the transcript. Defaults to expanded; lives across
  // re-renders of the same chat but is reset on chat switch.
  const mcpExpandedRef = useRef(true);

  // Re-fetch the resolved system prompt (after a prompt-size or custom
  // prompt change) and re-render the first message.
  async function refreshSystemPrompt() {
    if (!projectDir || !chatId) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/system-prompt?projectDir=' + encodeURIComponent(projectDir));
    systemPromptRef.current = r.status === 200 ? r.body : null;
    renderSystemPromptMessage();
  }

  function activeProfileId() {
    const c = chatRef.current;
    if (c && ['very-small', 'average', 'extensive'].indexOf(c.promptSize) >= 0) return c.promptSize;
    return 'average';
  }

  // The meta line is intentionally minimal now. The prompt-size profile
  // is no longer shown here (it lives in the settings popover and is
  // surfaced in full as the first transcript message); only the trace
  // state, which has no other on-screen indicator, is shown.
  function updateMetaLine() {
    if (!chatMeta.current) return;
    const c = chatRef.current;
    if (!c) return;
    chatMeta.current.textContent = c.trace ? 'trace on' : '';
  }

  // The head shows conversation-wide totals while each assistant turn keeps
  // its own breakdown below the bubble. "Context" is the latest upstream
  // prompt size (not a sum: every turn already includes earlier context).
  function updateProviderCredit(text) {
    providerCreditRef.current = text || null;
    updateUsageSummary();
  }

  async function refreshProviderCredit() {
    const provider = activeProviderId();
    if (!provider) return updateProviderCredit(null);
    try {
      const r = await fetchJson('/api/ai/provider-credit?provider=' + encodeURIComponent(provider));
      if (r.status !== 200 || !r.body || !r.body.supported) return updateProviderCredit(null);
      if (typeof r.body.remaining !== 'number') return updateProviderCredit(null);
      const label = r.body.label || 'Balance';
      updateProviderCredit(label + ' ' + formatCost(r.body.remaining));
    } catch { updateProviderCredit(null); }
  }

  function updateUsageSummary(liveInfo) {
    const el = usageSummaryRef.current;
    if (!el) return;
    const assistant = messagesRef.current.filter((m) => m && m.role === 'assistant');
    let latestContext = null;
    let totalCost = 0;
    let hasKnownCost = false;
    for (const m of assistant) {
      if (m.usage && typeof m.usage.promptTokens === 'number') latestContext = m.usage.promptTokens;
      if (m.cost && m.cost.known && typeof m.cost.total === 'number') {
        totalCost += m.cost.total;
        hasKnownCost = true;
      }
    }
    if (liveInfo) {
      if (liveInfo.usage && typeof liveInfo.usage.promptTokens === 'number') latestContext = liveInfo.usage.promptTokens;
      if (liveInfo.cost && liveInfo.cost.known && typeof liveInfo.cost.total === 'number') {
        totalCost += liveInfo.cost.total;
        hasKnownCost = true;
      }
    }
    el.innerHTML = '';
    const context = document.createElement('span');
    context.textContent = 'Context ' + (latestContext == null ? '--' : formatTokens(latestContext));
    const cost = document.createElement('span');
    cost.textContent = 'Total ' + (hasKnownCost ? formatCost(totalCost) : '--');
    el.appendChild(context);
    el.appendChild(cost);
    if (providerCreditRef.current) {
      const credit = document.createElement('span');
      credit.textContent = providerCreditRef.current;
      el.appendChild(credit);
    }
  }

  async function load() {
    if (!projectDir || !chatId) return;
    const [rChat, rModels, rProviders, rMsgs, rPrompts, rSys, rTools, rMcp] = await Promise.all([
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
      loadModels(projectDir),
      fetchJson('/api/ai/models/providers'),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/system-prompt?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir))
    ]);
    if (rChat.status !== 200) { statusEl.current.textContent = 'chat not found'; renderModelPicker(); return; }
    const c = rChat.body.chat;
    chatRef.current = c;
    messagesRef.current = rMsgs.status === 200 ? (rMsgs.body.messages || []) : [];
    transcriptSignatureRef.current = JSON.stringify(messagesRef.current);
    modelsRef.current = (rModels && Array.isArray(rModels.models)) ? rModels.models : [];
    providersRef.current = rProviders.status === 200 ? (rProviders.body.providers || []) : [];
    // Seed the per-provider live cache with the project-level
    // records. Live fetches overwrite these; a project-level model
    // that no longer resolves on the upstream keeps its entry.
    liveByProviderRef.current = {};
    for (const m of modelsRef.current) {
      if (!m || !m.id || !m.provider) continue;
      const arr = liveByProviderRef.current[m.provider] || (liveByProviderRef.current[m.provider] = []);
      arr.push({ id: m.id, label: m.label, contextWindow: m.contextWindow });
    }
    pickerFilterRef.current = { q: '', provider: 'all' };
    promptsRef.current = rPrompts.status === 200 ? (rPrompts.body.prompts || []) : [];
    systemPromptRef.current = rSys.status === 200 ? rSys.body : null;
    // Tool catalog (native + MCP) + the chat's current filter. The
    // server returns the catalog even when empty so the toggle row
    // can show a "no tools" placeholder instead of disappearing.
    toolsRef.current = {
      catalog: rTools.status === 200 && Array.isArray(rTools.body.tools) ? rTools.body.tools : [],
      filter: Array.isArray(c.tools) ? c.tools.slice() : null
    };
    mcpServersRef.current = rMcp.status === 200 && Array.isArray(rMcp.body.servers) ? rMcp.body.servers : [];

    if (promptInput.current && !promptInput.current.value && typeof c.draft === 'string' && c.draft) {
      promptInput.current.value = c.draft;
      autoresize();
    }
    if (chatName.current) chatName.current.textContent = c.title || chatId;
    updateMetaLine();
    updateUsageSummary();
    refreshProviderCredit();
    updateModelTrigger();

    // Auto-fetch the live catalog before the picker renders, so a
    // brand-new chat opens with the full list (not just the
    // project hand-typed slugs). Two paths:
    //
    //   - The chat already has a providerId (e.g. it was picked
    //     earlier, or the chat was resumed). Fetch just that one
    //     provider's catalog.
    //   - The chat has no providerId yet (a brand-new chat that has
    //     never sent a message). The active-provider path is a
    //     no-op in that case, which left the picker empty. Fall
    //     back to fetching every configured provider in parallel so
    //     the user sees the full catalog from the first paint.
    //
    // Errors are silent — a stale list is still usable; the user
    // can retry via the picker ↻ or the head refresh button.
    if (activeProviderId()) {
      await refreshActiveProvider().catch(() => {});
    } else {
      const providers = providersRef.current.map((p) => p && p.id).filter(Boolean);
      if (providers.length) {
        await Promise.all(providers.map((p) => fetchLiveForProvider(p).catch(() => {})));
      }
    }

    renderModelPicker();

    renderTranscript();
    updateSetupVisibility();
    // Reflect the active profile in the setup card after it has
    // been built (renderTranscript + updateSetupVisibility run first
    // and decide whether the card is on screen at all).
    updateSwitch(activeProfileId());
  }

  // refreshAllProviders with live models — invalidate the cached
  // project models so a subsequent load() picks up any new project
  // model entries too (e.g. user just typed a slug in Settings).
  async function refreshAllProviders() {
    if (modelPickerRefreshRef.current) modelPickerRefreshRef.current.disabled = true;
    setChatStatus('refreshing models…', 'busy');
    invalidateModelsCache();
    const providers = providersRef.current.map((p) => p && p.id).filter(Boolean);
    if (!providers.length) {
      setChatStatus('add a provider in Settings \u2192 Providers', 'error');
      if (modelPickerRefreshRef.current) modelPickerRefreshRef.current.disabled = false;
      return;
    }
    const results = await Promise.all(providers.map((p) => fetchLiveForProvider(p).catch((e) => ({ provider: p, ok: false, body: { error: String(e), code: 'ELIVE' }, status: 0 }))));
    let total = 0, failed = 0, primary = null;
    for (const r of results) {
      if (r.ok) total += r.count;
      else failed++;
    }
    const active = activeProviderId();
    primary = results.find((r) => r.provider === active);
    if (primary && !primary.ok) {
      const code = primary.body && primary.body.code;
      const msg = primary.body && primary.body.error;
      let pill;
      if (code === 'ENO_APIKEY')      pill = 'add API key in Settings \u2192 Providers';
      else if (code === 'EUNREACHABLE') pill = (primary.provider === 'ollama')
        ? 'ollama not running on ' + (window.__mouaif_ollama_url || '127.0.0.1:11434')
        : (primary.provider + ' unreachable');
      else if (code === 'EABORTED')    pill = 'timeout \u2014 ' + primary.provider + ' did not respond in 8s';
      else if (code === 'EUPSTREAM')   pill = (primary.provider + ' returned ' + (primary.status || '?'));
      else if (code === 'ENO_LIST')    pill = (primary.provider + ' has no model list endpoint');
      else                              pill = 'model list failed (' + (primary.status || '?') + ')';
      setChatStatus(pill + (msg && msg !== pill ? ' \u2014 ' + msg : ''), 'error');
    } else {
      setChatStatus('models: ' + total + (failed ? ' (' + failed + ' failed)' : ''), failed ? 'error' : 'success');
    }
    renderModelPicker();
    if (modelPickerRefreshRef.current) modelPickerRefreshRef.current.disabled = false;
  }

  function activeProviderId() {
    const c = chatRef.current;
    return c && c.providerId ? c.providerId : '';
  }

  // activeContextWindow() — the token budget of the chat's current
  // model, looked up from the live catalog (project entries merged
  // in at load). Returns null when the model is unknown or the
  // provider doesn't expose a context size (e.g. Ollama).
  function activeContextWindow() {
    const c = chatRef.current;
    if (!c || !c.modelId || !c.providerId) return null;
    const live = liveByProviderRef.current || {};
    const arr = live[c.providerId] || [];
    for (const m of arr) {
      if (m && m.id === c.modelId && typeof m.contextWindow === 'number' && m.contextWindow > 0) {
        return m.contextWindow;
      }
    }
    // Fall back to the project-level model record.
    for (const m of (modelsRef.current || [])) {
      if (m && m.provider === c.providerId && m.id === c.modelId && typeof m.contextWindow === 'number' && m.contextWindow > 0) {
        return m.contextWindow;
      }
    }
    return null;
  }

  // modelsForPicker() — flat list of { id, provider, label } for the
  // model-picker popover. Built from the union of the per-provider
  // live cache and the project-level models, deduped by
  // (provider, id) with project entries winning. Empty / falsy rows
  // are dropped. The result is rendered by groupModelsByProvider.
  function modelsForPicker() {
    const out = new Map();
    for (const m of (modelsRef.current || [])) {
      if (!m || !m.id || !m.provider) continue;
      out.set(m.provider + '\u0000' + m.id, { id: m.id, provider: m.provider, label: m.label });
    }
    const live = liveByProviderRef.current || {};
    for (const provider of Object.keys(live)) {
      for (const m of (live[provider] || [])) {
        if (!m || !m.id) continue;
        const key = provider + '\u0000' + m.id;
        if (out.has(key)) continue;
        out.set(key, { id: m.id, provider, label: m.label });
      }
    }
    return Array.from(out.values());
  }

  // updateModelTrigger() — refresh the label on the picker trigger
  // button (the head element that opens the picker). Two lines:
  // the model id (or "(pick a model)") and the provider id
  // (or empty). Falls back to "no providers" when the chat has no
  // providers configured.
  function updateModelTrigger() {
    const trig = modelPickerTriggerRef.current;
    if (!trig) return;
    const c = chatRef.current;
    const modelId = c && c.modelId ? c.modelId : '';
    const providerId = c && c.providerId ? c.providerId : '';
    const idEl = trig.querySelector('.chat-view__model-id');
    const provEl = trig.querySelector('.chat-view__model-provider');
    if (idEl) idEl.textContent = modelId || '(pick a model)';
    if (provEl) provEl.textContent = providerId || (providersRef.current.length ? '' : 'add a provider in Settings \u2192 Providers');
    trig.classList.toggle('is-empty', !modelId);
    trig.classList.toggle('no-providers', !providersRef.current.length);
  }

  // renderModelPicker() — rebuild the popover list section. The
  // search input + provider filter chips are static markup; this
  // only updates the scrollable list area. Called when the picker
  // opens, when the user types, when the provider filter changes,
  // after a refresh, and after a chat save that changes the active
  // selection. Filtering is by `q` (substring, case-insensitive,
  // against id + label) and by the active provider chip.
  function renderModelPicker() {
    const list = modelPickerListRef.current;
    if (!list) return;
    list.innerHTML = '';
    const f = pickerFilterRef.current || { q: '', provider: 'all' };
    const q = (f.q || '').trim().toLowerCase();
    const providerFilter = f.provider || 'all';
    let all = modelsForPicker();
    if (providerFilter !== 'all') all = all.filter((m) => m.provider === providerFilter);
    if (q) all = all.filter((m) => (m.id || '').toLowerCase().indexOf(q) >= 0 || (m.label || '').toLowerCase().indexOf(q) >= 0);
    const groups = groupModelsByProvider(all);
    // If the active provider is not in the list (e.g. the chat
    // references a model that's no longer available) still surface
    // it as a virtual "current" section so the user can see what
    // they had and either re-pick it or clear it.
    const c = chatRef.current;
    if (c && c.providerId && c.modelId && !all.some((m) => m.id === c.modelId && m.provider === c.providerId)) {
      groups.unshift({ provider: c.providerId, items: [{ id: c.modelId, provider: c.providerId, label: '', ghost: true }] });
    }
    // Update the filter chips to show counts (so the user knows how
    // many models live behind each chip without opening it).
    updatePickerChips(all, providerFilter);
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-view__picker-empty';
      if (q) empty.textContent = 'no matches';
      else if (!providersRef.current.length) empty.textContent = 'add a provider in Settings \u2192 Providers';
      else if (providerFilter !== 'all') empty.textContent = 'no ' + providerFilter + ' models \u2014 tap \u21bb';
      else empty.textContent = 'no models \u2014 tap \u21bb';
      list.appendChild(empty);
      return;
    }
    const activeProvider = c && c.providerId ? c.providerId : '';
    const activeModel = c && c.modelId ? c.modelId : '';
    for (const g of groups) {
      const section = document.createElement('section');
      section.className = 'chat-view__picker-section';
      const header = document.createElement('div');
      header.className = 'chat-view__picker-section-head';
      const title = document.createElement('span');
      title.className = 'chat-view__picker-section-title';
      title.textContent = g.provider;
      const count = document.createElement('span');
      count.className = 'chat-view__picker-section-count';
      count.textContent = String(g.items.length);
      header.appendChild(title); header.appendChild(count);
      section.appendChild(header);
      for (const m of g.items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'chat-view__picker-row';
        if (m.provider === activeProvider && m.id === activeModel) row.classList.add('is-active');
        if (m.ghost) row.classList.add('is-ghost');
        const id = document.createElement('span');
        id.className = 'chat-view__picker-row-id';
        id.textContent = m.id;
        row.appendChild(id);
        if (m.label && m.label !== m.id) {
          const label = document.createElement('span');
          label.className = 'chat-view__picker-row-label';
          label.textContent = m.label;
          row.appendChild(label);
        }
        const meta = document.createElement('span');
        meta.className = 'chat-view__picker-row-meta';
        meta.textContent = m.ghost ? 'unavailable' : m.provider;
        row.appendChild(meta);
        row.addEventListener('click', () => onPickerPick(m.provider, m.id));
        section.appendChild(row);
      }
      list.appendChild(section);
    }
  }

  // updatePickerChips() — set the .is-active class on the right
  // filter chip and append the per-provider model count. Counts
  // reflect the unfiltered list (q is ignored) so the user can see
  // how many models each provider has regardless of the search.
  function updatePickerChips(visibleList, activeFilter) {
    const pop = modelPickerPopRef.current;
    if (!pop) return;
    const chipsHost = pop.querySelector('.chat-view__picker-chips');
    if (!chipsHost) return;
    const all = modelsForPicker();
    const counts = { all: all.length };
    for (const m of all) counts[m.provider] = (counts[m.provider] || 0) + 1;
    const providers = providersRef.current.map((p) => p && p.id).filter(Boolean);
    // Make sure every provider that already has models shows up,
    // even if it has zero live entries (so the user can still
    // refresh that section).
    for (const p of providers) if (!counts.hasOwnProperty(p)) counts[p] = 0;
    const chips = [
      { id: 'all', label: 'All' },
      ...providers.map((p) => ({ id: p, label: p }))
    ];
    chipsHost.innerHTML = '';
    for (const c of chips) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-view__picker-chip';
      if (c.id === activeFilter) chip.classList.add('is-active');
      const label = document.createElement('span');
      label.className = 'chat-view__picker-chip-label';
      label.textContent = c.label;
      const count = document.createElement('span');
      count.className = 'chat-view__picker-chip-count';
      count.textContent = String(counts[c.id] || 0);
      chip.appendChild(label); chip.appendChild(count);
      chip.addEventListener('click', (ev) => {
        // Stop the click from bubbling to the document-level
        // outside-click handler: renderModelPicker() removes the
        // chip from the DOM (chipsHost.innerHTML = ''), and once
        // the click reaches `document` e.target is no longer a
        // descendant of the popover, which the handler would read
        // as "clicked outside — close". Stopping propagation
        // short-circuits that path; the chip's effect is the
        // filter change plus a popover re-render that stays open.
        ev.stopPropagation();
        pickerFilterRef.current = { q: pickerFilterRef.current.q, provider: c.id };
        renderModelPicker();
      });
      chipsHost.appendChild(chip);
    }
  }

  // fetchLiveForProvider(provider) — single /api/ai/models/live call.
  // On success it writes the catalog into liveByProviderRef and
  // re-renders the picker. On failure it returns the typed error
  // body so the caller can surface a useful status pill. The cache
  // buster (?_=) mirrors the old behavior; the server's 1h
  // in-memory cache stays the source of truth for repeated calls.
  async function fetchLiveForProvider(provider) {
    const res = await fetchLiveModels(provider);
    if (res && res.error) return { provider, ok: false, body: res.error, status: res.status || 0 };
    const live = Array.isArray(res && res.models) ? res.models : [];
    liveByProviderRef.current = Object.assign({}, liveByProviderRef.current, { [provider]: live });
    return { provider, ok: true, count: live.length, cached: !!(res && res.cached) };
  }

  // refreshActiveProvider() — fetch the live catalog for the chat's
  // currently selected provider (so a brand-new chat opens with
  // more than just the hand-typed project slugs). Errors are
  // silent: a stale list is still usable, and the user can retry
  // via the picker \u21bb button.
  async function refreshActiveProvider() {
    const provider = activeProviderId();
    if (!provider) return;
    const res = await fetchLiveForProvider(provider);
    if (res.ok) renderModelPicker();
  }

  // openModelPicker() / closeModelPicker() — popover show/hide.
  // On open: focus the search input, render the current state.
  // On close: blur the search input. The head's outside-click
  // handler (registered in useEffect) closes the popover on any
  // click outside the popover + trigger pair.
  function openModelPicker() {
    const pop = modelPickerPopRef.current;
    const trig = modelPickerTriggerRef.current;
    if (!pop || !trig) return;
    pop.hidden = false;
    trig.setAttribute('aria-expanded', 'true');
    renderModelPicker();
    if (modelPickerSearchRef.current) {
      modelPickerSearchRef.current.value = pickerFilterRef.current.q || '';
      modelPickerSearchRef.current.focus();
      // Move the caret to the end so a previously typed query is
      // easy to extend (vs overwriting the first char).
      const v = modelPickerSearchRef.current.value;
      modelPickerSearchRef.current.setSelectionRange(v.length, v.length);
    }
  }

  function closeModelPicker() {
    const pop = modelPickerPopRef.current;
    const trig = modelPickerTriggerRef.current;
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (trig) trig.setAttribute('aria-expanded', 'false');
    if (modelPickerSearchRef.current && modelPickerSearchRef.current === document.activeElement) {
      modelPickerSearchRef.current.blur();
    }
  }

  function onPickerSearch() {
    if (!modelPickerSearchRef.current) return;
    pickerFilterRef.current = { q: modelPickerSearchRef.current.value || '', provider: pickerFilterRef.current.provider };
    renderModelPicker();
  }

  // onPickerPick(providerId, modelId) — user tapped a row. Persist
  // the pair to the chat, update the head trigger label, and close
  // the picker. A pick on the "ghost" row (an unavailable active
  // model) clears the chat's modelId so the user re-picks on the
  // next open — keeping a dead reference around just means the
  // chat sends a request to a model that no longer exists.
  async function onPickerPick(providerId, modelId) {
    if (!providerId || !modelId) return;
    closeModelPicker();
    if (chatRef.current && chatRef.current.providerId === providerId && chatRef.current.modelId === modelId) return;
    chatRef.current = Object.assign({}, chatRef.current, { providerId, modelId });
    updateModelTrigger();
    refreshProviderCredit();
    await updateChat({ providerId, modelId });
  }

  // Render (or refresh) the system prompt as the FIRST message of the
  // transcript — a normal chat bubble with the `system` role, styled
  // like the user/assistant bubbles (not a permanent widget). The user
  // asked for the resolved prompt to appear as the first message, not
  // as a permanent on-screen option. Called by renderTranscript (full
  // rebuild) and refreshSystemPrompt (after a popover change) so it
  // never duplicates.
  // The system-prompt message is inserted directly after the setup
  // card (which is the first child of the transcript on a new chat)
  // and as the first child once the setup card is gone. The lookup
  // uses [data-sys-prompt] to avoid clobbering any future .chat-msg
  // with role text "system".
  function renderSystemPromptMessage() {
    if (!transcript.current) return;
    const existing = transcript.current.querySelector('[data-sys-prompt="1"]');
    if (existing) existing.remove();
    const sys = systemPromptRef.current;
    if (!sys || !sys.text) return;
    const row = document.createElement('div');
    row.className = 'chat-msg chat-msg--system';
    row.dataset.sysPrompt = '1';
    const role = document.createElement('div');
    role.className = 'chat-msg__role';
    role.textContent = 'system';
    const body = document.createElement('div');
    body.className = 'chat-msg__body';
    body.textContent = sys.text;
    row.appendChild(role);
    row.appendChild(body);
    // Insert directly after the setup card if one is still mounted,
    // so the system message always sits under it on a new chat.
    const setup = setupCardRef.current;
    if (setup && setup.parentNode === transcript.current) {
      transcript.current.insertBefore(row, setup.nextSibling);
    } else {
      transcript.current.insertBefore(row, transcript.current.firstChild);
    }
  }

  // Build / rebuild the per-chat tool toggle card. Sits below the
  // system-prompt message. One chip per catalog entry; the chip's
  // pressed state mirrors toolsRef.filter (null = all enabled, the
  // per-chat array is the explicit selection). Changes are persisted
  // on the chat record and affect the next model turn.
  //
  // The card is built imperatively (not as Preact JSX) because
  // the rest of the transcript is built that way; mixing two
  // rendering strategies inside the same scroll region would
  // double the maintenance cost for very little benefit. See the
  // Preact-on-the-head / DOM-on-the-transcript note near the top
  // of renderTranscript.
  function buildToolsCard() {
    const t = toolsRef.current || { catalog: [], filter: null };
    const card = document.createElement('div');
    card.className = 'chat-view__tools-card';
    card.dataset.toolsCard = '1';

    const head = document.createElement('div');
    head.className = 'chat-view__tools-card-head';
    const title = document.createElement('span');
    title.className = 'chat-view__tools-card-title';
    title.textContent = 'Tools available to the model';
    const note = document.createElement('span');
    note.className = 'chat-view__tools-card-note';
    note.textContent = (t.filter == null)
      ? 'tap to disable — applies next turn'
      : 'applies next turn';
    head.appendChild(title); head.appendChild(note);
    card.appendChild(head);

    if (!t.catalog.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-view__tools-empty';
      empty.textContent = 'No tools available. Add an MCP server in Settings \u2192 MCP to expose its tools here.';
      card.appendChild(empty);
      return card;
    }

    const chips = document.createElement('div');
    chips.className = 'chat-view__tools-chips';
    for (const tool of t.catalog) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-view__tools-chip';
      chip.dataset.toolName = tool.name;
      // Effective state: filter === null means "all enabled"
      // (legacy default); an array means "exactly these enabled".
      // The chip is on when either rule says it is.
      const enabled = (t.filter == null) || t.filter.indexOf(tool.name) >= 0;
      if (enabled) chip.classList.add('is-on');
      chip.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      chip.title = tool.description || tool.name;
      const label = document.createElement('span');
      label.className = 'chat-view__tools-chip-label';
      label.textContent = tool.name;
      chip.appendChild(label);
      if (tool.kind === 'mcp' && tool.source) {
        const sub = document.createElement('span');
        sub.className = 'chat-view__tools-chip-sub';
        sub.textContent = tool.source;
        chip.appendChild(sub);
      }
      chip.addEventListener('click', () => toggleTool(tool.name, !enabled));
      chips.appendChild(chip);
    }
    card.appendChild(chips);

    const mcp = buildMcpServerToggles();
    if (mcp) card.appendChild(mcp);
    return card;
  }

  // applyMcpExpanded(wrap) — reflect mcpExpandedRef on the freshly
  // built tools-card subtree. Hides the <ul> and flips the header
  // arrow + aria-expanded. Kept as a free function so the same
  // collapse state is applied both on initial build and on toggle.
  function applyMcpExpanded(wrap) {
    if (!wrap) return;
    const expanded = mcpExpandedRef.current !== false;
    const head = wrap.querySelector('.chat-view__mcp-toggles-head');
    const list = wrap.querySelector('.chat-view__mcp-list');
    if (head) {
      head.setAttribute('aria-expanded', String(expanded));
      head.classList.toggle('is-collapsed', !expanded);
    }
    if (list) list.hidden = !expanded;
  }

  // Build the MCP enable/disable controls shown under the tool list.
  // Rendered as a nested <ul>: one row per configured MCP server
  // (parent checkbox enables the server itself, see toggleMcpServer)
  // with an indented child row per discovered tool whose checkbox
  // flips the per-chat tools filter (see toggleTool). The user can
  // still start/stop or edit servers from Settings → MCP; this widget
  // is the in-chat surface for the per-tool decision the model sees
  // on its next turn.
  function buildMcpServerToggles() {
    const servers = (mcpServersRef.current || []).filter((s) => s && s.id);
    if (!servers.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'chat-view__mcp-toggles';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'chat-view__mcp-toggles-head';
    head.setAttribute('aria-expanded', String(mcpExpandedRef.current !== false));
    head.setAttribute('aria-controls', 'chat-view__mcp-list');
    const headLabel = document.createElement('span');
    headLabel.className = 'chat-view__mcp-toggles-head-label';
    headLabel.textContent = 'MCP servers & tools';
    const headArrow = document.createElement('span');
    headArrow.className = 'chat-view__mcp-toggles-head-arrow';
    headArrow.setAttribute('aria-hidden', 'true');
    headArrow.textContent = '▸';
    head.appendChild(headLabel);
    head.appendChild(headArrow);
    head.addEventListener('click', () => {
      mcpExpandedRef.current = mcpExpandedRef.current === false;
      applyMcpExpanded(wrap);
    });
    wrap.appendChild(head);

    // Map each server to the catalog entries that belong to it, so the
    // nested list stays aligned with /api/tools/list (which the chips
    // above are built from). The server entry's own `tools` list is
    // the authoritative discovered set when the server is running;
    // the catalog's `source` field is the server slug it was wired
    // through. Both come from the same MCP session so they line up
    // on the next turn; if they ever disagree (stale cache, server
    // stopped, etc.) the catalog wins because it is what the model
    // will actually be advertised.
    const catalog = (toolsRef.current && toolsRef.current.catalog) || [];
    const bySlug = new Map();
    for (const t of catalog) {
      if (!t || t.kind !== 'mcp' || !t.source || !t.name) continue;
      let bucket = bySlug.get(t.source);
      if (!bucket) { bucket = []; bySlug.set(t.source, bucket); }
      bucket.push(t);
    }

    const list = document.createElement('ul');
    list.className = 'chat-view__mcp-list';
    list.id = 'chat-view__mcp-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'MCP servers and their tools');
    // Apply the current collapsed state to the freshly built list so
    // a re-render of the tools card (e.g. after a tool toggle) keeps
    // the user's choice instead of snapping back open.
    applyMcpExpanded(wrap);

    for (const s of servers) {
      const serverSlug = s.slug || s.id;
      const serverComposed = (n) => 'mcp__' + serverSlug + '__' + n;
      const li = document.createElement('li');
      li.className = 'chat-view__mcp-item';

      // Parent row: server enable + label + status. Toggling the
      // server checkbox goes through toggleMcpServer (PATCHes the
      // project config, stops the running session when needed, and
      // refreshes the catalog). The label is the click target so
      // tapping the row flips the checkbox the same way the chips
      // above do — the user can still start/stop from Settings → MCP.
      const parentLabel = document.createElement('label');
      parentLabel.className = 'chat-view__mcp-server';
      const parentBox = document.createElement('input');
      parentBox.type = 'checkbox';
      parentBox.className = 'checkbox';
      parentBox.checked = s.enabled !== false;
      parentBox.disabled = mcpToggleBusyRef.current.has(s.id);
      parentBox.setAttribute('aria-label', (s.name || s.id) + ' MCP server enabled');
      const parentMain = document.createElement('span');
      parentMain.className = 'chat-view__mcp-server-main';
      const parentName = document.createElement('span');
      parentName.className = 'chat-view__mcp-server-name';
      parentName.textContent = s.name || s.id;
      const parentMeta = document.createElement('span');
      parentMeta.className = 'chat-view__mcp-server-meta';
      const status = s.status || 'stopped';
      const serverTools = Array.isArray(s.tools) ? s.tools.length : 0;
      parentMeta.textContent = status + ' · ' + serverTools + ' tool' + (serverTools === 1 ? '' : 's');
      parentMain.appendChild(parentName); parentMain.appendChild(parentMeta);
      parentBox.addEventListener('change', () => toggleMcpServer(s.id, parentBox.checked));
      parentLabel.appendChild(parentBox); parentLabel.appendChild(parentMain);
      li.appendChild(parentLabel);

      // Child list: one row per discovered tool. The checkbox mirrors
      // toolsRef.filter (null = all enabled) the same way the chip
      // above does, so flipping a child row is the per-tool equivalent
      // of toggling a chip. The composed name `mcp__<slug>__<name>` is
      // the name the model actually sees in the tools array, which is
      // the key the per-chat filter is keyed on (see ai.js).
      const discovered = (s.tools && s.tools.length) ? s.tools : null;
      const catalogForServer = bySlug.get(serverSlug) || [];
      const childTools = catalogForServer.length
        ? catalogForServer.map((t) => t.name)
        : (discovered ? discovered.map((t) => t.name || t) : []);
      if (childTools.length) {
        const sub = document.createElement('ul');
        sub.className = 'chat-view__mcp-tool-list';
        sub.setAttribute('role', 'group');
        sub.setAttribute('aria-label', (s.name || s.id) + ' tools');
        for (const toolName of childTools) {
          const composed = serverComposed(toolName);
          const childLi = document.createElement('li');
          childLi.className = 'chat-view__mcp-tool';
          const childLabel = document.createElement('label');
          childLabel.className = 'chat-view__mcp-tool-label';
          const childBox = document.createElement('input');
          childBox.type = 'checkbox';
          childBox.className = 'checkbox';
          const cur = toolsRef.current || { filter: null };
          const enabled = (cur.filter == null) || cur.filter.indexOf(composed) >= 0;
          childBox.checked = enabled;
          childBox.disabled = parentBox.disabled || s.enabled === false;
          childBox.setAttribute('aria-label', (s.name || s.id) + ' — ' + toolName + ' tool enabled');
          const childMain = document.createElement('span');
          childMain.className = 'chat-view__mcp-tool-main';
          const childName = document.createElement('span');
          childName.className = 'chat-view__mcp-tool-name';
          childName.textContent = toolName;
          const childSlug = document.createElement('span');
          childSlug.className = 'chat-view__mcp-tool-slug';
          childSlug.textContent = composed;
          childSlug.setAttribute('aria-hidden', 'true');
          childMain.appendChild(childName); childMain.appendChild(childSlug);
          childBox.addEventListener('change', () => toggleTool(composed, childBox.checked));
          childLabel.appendChild(childBox); childLabel.appendChild(childMain);
          childLi.appendChild(childLabel);
          sub.appendChild(childLi);
        }
        li.appendChild(sub);
      }

      list.appendChild(li);
    }
    wrap.appendChild(list);
    return wrap;
  }

  // toggleMcpServer(id, enabled) — quick project-level MCP enable
  // switch from the chat tool card. PATCH stops any running session
  // when the server config changes; refresh the catalog after so the
  // tool chips immediately reflect enabled/ready MCP tools.
  async function toggleMcpServer(id, enabled) {
    if (!id || !projectDir || mcpToggleBusyRef.current.has(id)) return;
    mcpToggleBusyRef.current.add(id);
    const servers = mcpServersRef.current || [];
    const idx = servers.findIndex((s) => s && s.id === id);
    const prev = idx >= 0 ? servers[idx].enabled !== false : null;
    if (idx >= 0) {
      const next = servers.slice();
      next[idx] = Object.assign({}, next[idx], { enabled });
      mcpServersRef.current = next;
      updateToolsCard();
    }
    try {
      const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, enabled })
      });
      if (r.status !== 200) {
        if (idx >= 0 && prev !== null) {
          const rollback = (mcpServersRef.current || []).slice();
          rollback[idx] = Object.assign({}, rollback[idx], { enabled: prev });
          mcpServersRef.current = rollback;
        }
        setChatStatus('MCP update failed: HTTP ' + r.status, 'error');
        return;
      }
      const rr = await Promise.all([
        fetchJson('/api/mcp/servers?projectDir=' + encodeURIComponent(projectDir)),
        fetchJson('/api/tools/list?projectDir=' + encodeURIComponent(projectDir))
      ]);
      if (rr[0].status === 200 && Array.isArray(rr[0].body.servers)) mcpServersRef.current = rr[0].body.servers;
      if (rr[1].status === 200 && Array.isArray(rr[1].body.tools)) {
        toolsRef.current = Object.assign({}, toolsRef.current || {}, { catalog: rr[1].body.tools });
      }
      setChatStatus(enabled ? 'MCP enabled' : 'MCP disabled', 'success');
    } finally {
      mcpToggleBusyRef.current.delete(id);
      updateToolsCard();
    }
  }

  // Insert the tools card into the transcript in the right slot.
  // Called from renderTranscript for every chat, and from toggleTool
  // after a chip is clicked (so the active-state highlight updates in
  // place without a full rebuild).
  function mountToolsCard() {
    if (!transcript.current) return;
    const existing = transcript.current.querySelector('[data-tools-card="1"]');
    if (existing) existing.remove();
    const card = buildToolsCard();
    toolsCardRef.current = card;
    // Insert AFTER the system-prompt message so the visual order is:
    //   [setup card] [system prompt] [tools card] [messages/empty]
    // The user asked for the toggles "below the system prompt".
    const sysMsg = transcript.current.querySelector('[data-sys-prompt="1"]');
    const empty = transcript.current.querySelector('.chat-view__empty');
    if (sysMsg && sysMsg.parentNode === transcript.current) {
      transcript.current.insertBefore(card, sysMsg.nextSibling);
    } else if (empty && empty.parentNode === transcript.current) {
      transcript.current.insertBefore(card, empty);
    } else {
      transcript.current.appendChild(card);
    }
  }

  // Re-render the tools card in place after a chip toggle. Faster
  // than calling renderTranscript (no need to re-fetch messages,
  // re-render the empty state, etc.) and avoids a visible flash
  // when a chip flips its pressed state.
  function updateToolsCard() {
    if (!toolsCardRef.current || !toolsCardRef.current.parentNode) return;
    const fresh = buildToolsCard();
    toolsCardRef.current.parentNode.replaceChild(fresh, toolsCardRef.current);
    toolsCardRef.current = fresh;
  }

  // toggleTool(name, next) — flip one chip and persist the new
  // filter to the chat. The server is the source of truth for
  // which tools are advertised; the PATCH response carries the
  // new chat record, so we sync chatRef.current in place. The
  // local toolsRef.filter mirrors it so a subsequent rebuild
  // (after re-opening the chat) reads the same value.
  //
  // Filter semantics: an empty array and `null` are not the same
  // thing. `null` means "all available" (no user choice yet, or
  // the user hit Reset). `[]` means "user explicitly chose no
  // tools". The first time the user disables a tool we transition
  // from `null` to an explicit array; the next time they re-enable
  // every chip we go back to `null` so the chat record does not
  // grow stale as new tools are added to the catalog.
  async function toggleTool(name, next) {
    const cur = toolsRef.current || { catalog: [], filter: null };
    const catalog = cur.catalog || [];
    if (!catalog.find((t) => t && t.name === name)) return;
    const allNames = catalog.map((t) => t.name);
    let nextFilter;
    if (cur.filter == null) {
      // First edit: snapshot the implicit "all" set, then apply
      // the toggle. The full set minus the one the user just
      // turned off.
      nextFilter = allNames.filter((n) => n !== name);
      if (next) nextFilter = allNames.slice();
    } else {
      const set = new Set(cur.filter);
      if (next) set.add(name); else set.delete(name);
      // If the explicit set covers every catalog entry, prefer
      // `null` so the filter does not pin a chat to a stale
      // catalog snapshot. Same idea when the set is empty — keep
      // it as `[]` so "no tools" round-trips.
      if (set.size === catalog.length) nextFilter = null;
      else nextFilter = Array.from(set);
    }
    toolsRef.current = { catalog, filter: nextFilter };
    updateToolsCard();
    await updateChat({ tools: nextFilter == null ? null : nextFilter });
    // updateChat already syncs chatRef.current from the server
    // response, so the persisted value matches the local mirror.
  }  // Build (or rebuild) the creation-time setup control. The prompt-size
  // choice is a single <select> dropdown — no title, no description,
  // no tool preview. The control lives in the transcript (the message
  // area), above the system-prompt message, and is the first thing the
  // user sees on a new chat. Once any message exists it is removed
  // entirely (see updateSetupVisibility).
  function buildSetupCard() {
    const sel = document.createElement('select');
    sel.className = 'input chat-view__setup';
    sel.id = 'chatPromptSize';
    sel.setAttribute('aria-label', 'Prompt size');
    for (const opt of [
      { id: 'very-small', label: 'Very small \u2014 tool names only, no parameter schemas, smallest prompt' },
      { id: 'average',    label: 'Average \u2014 full tools, recommended' },
      { id: 'extensive',  label: 'Extensive \u2014 full tools + best-practice guidance' }
    ]) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    // Use `selected` on the <option> (not `value` on the <select>) so
    // the initial paint matches the chat's resolved profile on every
    // re-render. Preact reliably re-applies `selected` per render,
    // while a `value` on <select> can be ignored on first mount when
    // the matching <option> hasn't been attached yet.
    sel.addEventListener('change', () => setPromptSize(sel.value));
    return sel;
  }

  function renderTranscript() {
    if (!transcript.current) return;
    transcript.current.innerHTML = '';
    setupCardRef.current = null;
    // On a brand-new chat, the transcript's first child is the setup
    // card. The system-prompt message sits beneath it so the user
    // sees the resolved prompt they just configured.
    if (!messagesRef.current.length) {
      const card = buildSetupCard();
      transcript.current.appendChild(card);
      setupCardRef.current = card;
      const empty = document.createElement('div');
      empty.className = 'chat-view__empty';
      const icon = document.createElement('span');
      icon.className = 'chat-view__empty-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M4 4h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-9.586a1.5 1.5 0 0 0-1.06.44l-2.122 2.12A.5.5 0 0 1 6.4 20.146V18H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3 5a1 1 0 0 0 0 2h10a1 1 0 1 0 0-2H7Zm0 4a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H7Z"/></svg>';
      const title = document.createElement('p');
      title.className = 'chat-view__empty-title';
      title.textContent = 'Start the conversation';
      const text = document.createElement('p');
      text.className = 'chat-view__empty-text';
      text.textContent = 'Type a message below. The model streams its reply in real time; everything you send is saved to this chat\'s transcript on disk.';
      empty.appendChild(icon); empty.appendChild(title); empty.appendChild(text);
      transcript.current.appendChild(empty);
      renderSystemPromptMessage();
      // Per-chat tool toggles (decisions: chat.tools). Kept visible
      // after chat start so the next model turn can use an updated
      // tool surface without creating a new chat.
      mountToolsCard();
      return;
    }
    renderSystemPromptMessage();
    mountToolsCard();
    for (const m of messagesRef.current) {
      if (m.role === 'tool' && m.phase === 'call') {
        appendToolCallCard({ id: m.toolCallId, name: m.name, args: m.args });
      } else if (m.role === 'tool' && m.phase === 'result') {
        appendToolResultCard({ id: m.toolCallId, name: m.name, ok: m.ok, result: m.content || '' });
      } else {
        appendMessageToTranscript(m, false);
      }
    }
    // A full rebuild always lands pinned at the newest message.
    scrollTranscriptToBottom();
    updateUsageSummary();
  }

  function appendMessageToTranscript(m, isLive) {
    if (!transcript.current) return;
    const empty = transcript.current.querySelector('.chat-view__empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'chat-msg chat-msg--' + m.role;
    if (isLive) row.dataset.live = '1';
    const role = document.createElement('div');
    role.className = 'chat-msg__role';
    // For assistant turns, show the model name instead of the bare
    // "assistant" role label. The modelId is persisted on the
    // message (decision §14); fall back to the chat's currently
    // selected model when the message is missing one (e.g. an
    // older transcript saved before modelId was tracked).
    if (m.role === 'assistant') {
      const modelId = m.modelId || (chatRef.current && chatRef.current.modelId) || 'assistant';
      role.textContent = modelId;
    } else {
      role.textContent = m.role;
    }
    const body = document.createElement('div');
    body.className = 'chat-msg__body';
    if (m.role === 'assistant') {
      renderAssistantBody(body, m.content || '', m.reasoning || '', true);
    } else {
      body.textContent = m.content || '';
      if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
        renderImageAttachments(body, m.attachments);
      }
    }
    const ts = document.createElement('div');
    ts.className = 'chat-msg__ts';
    ts.textContent = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
    row.appendChild(role); row.appendChild(body); row.appendChild(ts);
    transcript.current.appendChild(row);
    if (m.role === 'assistant' && isLive) {
      row._body = body;
      row._content = m.content || '';
      row._reasoning = m.reasoning || '';
    }
    // Per-turn meta line (decision \u00a714). Lives directly under the
    // assistant bubble and shows the model id, token counts, cost,
    // and live token rate. For non-assistant messages or for
    // assistant messages without a usage block, the line is hidden
    // \u2014 the typical case is a fresh chat before any AI turn, or a
    // transcript from before this commit shipped.
    if (m.role === 'assistant') {
      const meta = document.createElement('div');
      meta.className = 'chat-msg__meta';
      if (isLive) {
        // Live turns are empty while the user is typing; hide the
        // meta line so the row doesn't reserve a phantom line of
        // height before the first delta arrives.
        meta.hidden = true;
      } else if (m.usage || m.cost || m.modelId) {
        renderUsageMeta(meta, m);
      } else {
        meta.hidden = true;
      }
      row.appendChild(meta);
    }
    afterTranscriptAppend(true);
  }

  function renderImageAttachments(host, attachments) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg__attachments';
    for (const a of attachments) {
      if (!a || !a.dataUrl) continue;
      const img = document.createElement('img');
      img.className = 'chat-msg__attachment-img';
      img.src = a.dataUrl;
      img.alt = a.name || 'attached image';
      wrap.appendChild(img);
    }
    host.appendChild(wrap);
  }

  // Render the per-turn breakdown. Pure DOM, no framework \u2014 the chat
  // view intentionally avoids Preact here so the SSE hot path stays
  // as cheap as a textContent assignment. The line is a flat row of
  // "\u2022"-separated tokens sized for a 360 px viewport.
  function renderUsageMeta(el, info) {
    el.innerHTML = '';
    el.hidden = false;
    const modelId = info.modelId || '';
    const usage = info.usage || {};
    const cost = info.cost || null;
    const tokens = [];
    if (modelId) tokens.push(modelId);
    if (typeof usage.promptTokens === 'number') {
      let label = 'context ' + formatTokens(usage.promptTokens);
      // When the model's context window is known, show how much of
      // it this turn consumed so the user can see the budget fill
      // up (e.g. "context 14.8K/200K (7%)").
      const win = activeContextWindow();
      if (win) {
        const pct = Math.round((usage.promptTokens / win) * 100);
        label += '/' + formatTokens(win) + ' (' + pct + '%)';
      }
      tokens.push(label);
    }
    if (typeof usage.completionTokens === 'number') {
      tokens.push('output ' + formatTokens(usage.completionTokens));
    }
    if (cost && cost.known) {
      tokens.push('cost ' + formatCost(cost.total));
    } else if (cost && cost.known === false) {
      tokens.push('--');
    }
    // tok/s: prefer the live counter when present (it's
    // continuously updated from the SSE message stream), fall back
    // to the final rate from the done event.
    let rate = info.liveRate;
    if (rate == null && info.streamingMs && typeof usage.completionTokens === 'number') {
      rate = info.streamingMs > 0 ? (usage.completionTokens / info.streamingMs) * 1000 : 0;
    }
    if (rate != null) tokens.push(formatTokPerSecond(rate));
    for (let i = 0; i < tokens.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'chat-msg__meta-sep';
        sep.textContent = '\u2022';
        el.appendChild(sep);
      }
      const span = document.createElement('span');
      span.textContent = tokens[i];
      el.appendChild(span);
    }
  }

  function renderAssistantBody(body, content, reasoning, final) {
    body.innerHTML = '';
    if (reasoning) {
      const details = document.createElement('details');
      details.className = 'chat-msg__reasoning';
      if (!final) details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = final ? 'Thinking' : 'Thinking…';
      const thinkBody = document.createElement('div');
      thinkBody.className = 'chat-msg__reasoning-body' + (final ? '' : ' chat-msg__reasoning-body--raw');
      if (final) thinkBody.innerHTML = renderMarkdown(reasoning);
      else thinkBody.textContent = reasoning;
      details.appendChild(summary);
      details.appendChild(thinkBody);
      body.appendChild(details);
    }
    const answer = document.createElement('div');
    answer.className = 'chat-msg__answer';
    if (final) answer.innerHTML = renderMarkdown(content || '');
    else answer.textContent = content || '';
    body.appendChild(answer);
  }

  function appendDeltaToLive(delta) {
    if (!transcript.current) return;
    let liveRow = transcript.current.querySelector('[data-live="1"]');
    // Tool calls end an assistant segment. The next upstream delta belongs
    // after the tool result, so create a new live bubble lazily instead of
    // appending it to the pre-tool bubble.
    if (!liveRow) {
      const mid = (chatRef.current && chatRef.current.modelId) || '';
      appendMessageToTranscript({ role: 'assistant', content: '', reasoning: '', ts: new Date().toISOString(), modelId: mid }, true);
      liveRow = transcript.current.querySelector('[data-live="1"]');
    }
    if (liveRow) {
      liveRow._content = (liveRow._content || '') + delta;
      renderAssistantBody(liveRow._body, liveRow._content || '', liveRow._reasoning || '', false);
      // Deltas extend the current live bubble; keep the view glued to
      // the bottom when pinned but don't bump the new-message counter.
      afterTranscriptAppend(false);
    }
  }

  function appendReasoningToLive(delta) {
    if (!transcript.current) return;
    let liveRow = transcript.current.querySelector('[data-live="1"]');
    if (!liveRow) {
      const mid = (chatRef.current && chatRef.current.modelId) || '';
      appendMessageToTranscript({ role: 'assistant', content: '', reasoning: '', ts: new Date().toISOString(), modelId: mid }, true);
      liveRow = transcript.current.querySelector('[data-live="1"]');
    }
    if (liveRow) {
      liveRow._reasoning = (liveRow._reasoning || '') + delta;
      renderAssistantBody(liveRow._body, liveRow._content || '', liveRow._reasoning || '', false);
      afterTranscriptAppend(false);
    }
  }

  // Render a tool_call event as a compact card above the live message
  // (or appended if there is no live row). The card shows the tool
  // name, a one-line argument summary, and a status pill. Tapping the
  // header row expands the card to reveal the full body. The
  // matching tool_result will replace this pill with an ok/error pill.
  function buildToolCardHead(toolName, args, pillClass, pillText) {
    const head = document.createElement('div');
    head.className = 'tool-card__head';
    const name = document.createElement('span');
    name.className = 'tool-card__name';
    name.textContent = toolName || 'tool';
    // `args` may be either a raw arg object or an already-formatted
    // string (when the caller has the display text already). Pass it
    // through formatToolArgs either way: passing a string returns
    // that string unchanged.
    const argText = args == null ? '' : (typeof args === 'string' ? args : formatToolArgs(args, toolName));
    const pill = document.createElement('span');
    pill.className = 'tool-card__pill ' + pillClass;
    pill.textContent = pillText;
    head.appendChild(name);
    if (argText) {
      const argsEl = document.createElement('pre');
      argsEl.className = 'tool-card__args';
      argsEl.textContent = argText;
      head.appendChild(argsEl);
    }
    head.appendChild(pill);
    head.addEventListener('click', () => {
      const card = head.closest('.tool-card');
      if (card) card.classList.toggle('is-expanded');
    });
    return head;
  }

  function bindToolCardToggle(card) {
    // The header row is the tap target (added by buildToolCardHead).
    // This helper is now only used to mark the card as expandable; the
    // actual click lives on the head element so the whole row reads as
    // the affordance.
    if (!card || card._toolCardToggleBound) return;
    card._toolCardToggleBound = true;
  }

  // name, a one-line argument summary, and a "running" pill. The
  // matching tool_result will replace this card.
  function appendToolCallCard(toolCall) {
    if (!transcript.current) return;
    const empty = transcript.current.querySelector('.chat-view__empty');
    if (empty) empty.remove();
    const id = toolCall.id || ('call_' + Math.random().toString(36).slice(2, 10));
    const card = document.createElement('div');
    card.className = 'tool-card tool-card--call';
    card.dataset.toolId = id;
    card.dataset.toolName = normalizeToolName(toolCall.name);
    card.appendChild(buildToolCardHead(toolCall.name, toolCall.args, 'tool-card__pill--busy', 'running'));
    if (isSubagentTool(toolCall.name)) {
      card.classList.add('tool-card--subagent');
      // A live body is added up front so the user can expand the card
      // while the subagent is still running and watch nested tool
      // activity stream in — previously the card only became
      // expandable once the final result arrived.
      const body = document.createElement('div');
      body.className = 'tool-card__body';
      const live = document.createElement('div');
      live.className = 'tool-card__subagent-live';
      const hint = document.createElement('div');
      hint.className = 'tool-card__subagent-live-hint';
      hint.textContent = 'Subagent is working\u2026';
      live.appendChild(hint);
      body.appendChild(live);
      card.appendChild(body);
      bindToolCardToggle(card);
      // Expanded by default while running so progress is visible
      // without a tap; the user can still collapse it.
      card.classList.add('is-expanded');
    }
    transcript.current.appendChild(card);
    afterTranscriptAppend(true);
  }

  // Fold a nested subagent stream event (tagged with parentTool) into
  // the parent subagent card's live container. Returns true when the
  // event was consumed and should not hit the normal handlers.
  function handleSubagentStreamEvent(ev, data) {
    if (!transcript.current) return false;
    const card = findSubagentCard(data && data.parentCallId);
    if (!card) return false;
    const live = ensureSubagentLive(card);
    if (!live) return false;
    if (ev.eventName === 'message' && typeof data.delta === 'string') {
      live._text = (live._text || '') + data.delta;
      let textEl = live.querySelector('.tool-card__subagent-live-text');
      if (!textEl) {
        textEl = document.createElement('div');
        textEl.className = 'tool-card__subagent-live-text';
        live.appendChild(textEl);
      }
      renderAssistantBody(textEl, live._text, '', false);
      scrollToolBodyToBottom(live);
      afterTranscriptAppend(false);
      return true;
    }
    if (ev.eventName === 'tool_call') {
      const hint = live.querySelector('.tool-card__subagent-live-hint');
      if (hint) hint.remove();
      const row = document.createElement('div');
      row.className = 'tool-card__subagent-tool';
      if (data.id) row.dataset.nestedToolId = data.id;
      const callName = document.createElement('span');
      callName.className = 'tool-card__subagent-tool-name';
      callName.textContent = data.name || 'tool';
      const callArgs = document.createElement('pre');
      callArgs.className = 'tool-card__subagent-text';
      callArgs.textContent = formatToolArgs(data.args, data.name);
      const status = document.createElement('span');
      status.className = 'tool-card__pill tool-card__pill--busy';
      status.textContent = 'running\u2026';
      row.appendChild(callName); row.appendChild(callArgs); row.appendChild(status);
      live.appendChild(row);
      scrollToolBodyToBottom(live);
      afterTranscriptAppend(false);
      return true;
    }
    if (ev.eventName === 'tool_result') {
      let row = data.id ? live.querySelector('[data-nested-tool-id="' + cssEscape(data.id) + '"]') : null;
      if (!row) row = live.querySelector('.tool-card__subagent-tool:last-child');
      if (row) {
        const status = row.querySelector('.tool-card__pill');
        if (status) {
          status.className = 'tool-card__pill ' + (data.ok ? 'tool-card__pill--ok' : 'tool-card__pill--err');
          status.textContent = data.ok ? 'ok' : 'error';
        }
        const oldPreview = row.querySelector('.tool-card__subagent-preview');
        if (oldPreview) oldPreview.remove();
        renderSubagentToolPreview(row, data.name, data.result);
      }
      scrollToolBodyToBottom(live);
      afterTranscriptAppend(false);
      return true;
    }
    return false;
  }

  function findSubagentCard(parentCallId) {
    if (!transcript.current) return null;
    if (parentCallId) {
      const byId = transcript.current.querySelector('[data-tool-id="' + cssEscape(parentCallId) + '"]');
      if (byId) return byId;
    }
    // Fall back to the most recent subagent card (ids can be missing
    // for providers that don't echo tool call ids).
    const cards = transcript.current.querySelectorAll('.tool-card--subagent');
    return cards.length ? cards[cards.length - 1] : null;
  }

  function ensureSubagentLive(card) {
    if (!card) return null;
    let body = card.querySelector('.tool-card__body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'tool-card__body';
      card.appendChild(body);
    }
    let live = card.querySelector('.tool-card__subagent-live');
    if (!live) {
      live = document.createElement('div');
      live.className = 'tool-card__subagent-live';
      body.appendChild(live);
    }
    return live;
  }

  // Render a tool_result event. If a matching tool_call card is on
  // screen, update it; otherwise append a fresh card so the user can
  // see the result regardless of order. Tap the header row to expand.
  function appendToolResultCard(toolResult) {
    if (!transcript.current) return;
    const id = toolResult.id;
    let card = id ? transcript.current.querySelector('[data-tool-id="' + cssEscape(id) + '"]') : null;
    const isSubagent = isSubagentTool(toolResult && toolResult.name);
    const pillClass = toolResult.ok ? 'tool-card__pill--ok' : 'tool-card__pill--err';
    const pillText = toolResult.ok ? 'ok' : 'error';
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool-card tool-card--result';
      card.dataset.toolId = id || ('call_' + Math.random().toString(36).slice(2, 10));
      card.dataset.toolName = normalizeToolName(toolResult.name);
      // No args preview on standalone result cards — the body is the
      // result. Subagent cards keep the delegated task in the args slot.
      const headArgs = isSubagent ? formatToolArgs(toolResult.args, toolResult.name) : null;
      card.appendChild(buildToolCardHead(toolResult.name, headArgs, pillClass, pillText));
      const body = document.createElement('div');
      body.className = 'tool-card__body';
      card.appendChild(body);
      bindToolCardToggle(card);
      transcript.current.appendChild(card);
    } else {
      // The call card becomes a result card. For non-subagent tools
      // the args preview is dropped (the result body is the more
      // useful preview). For subagent cards we keep the delegated
      // task — it is the most useful context for the finished run.
      card.classList.add('tool-card--result');
      card.classList.remove('tool-card--call');
      card.dataset.toolName = normalizeToolName(toolResult.name);
      const headArgs = isSubagent ? formatToolArgs(toolResult.args, toolResult.name) : null;
      rebuildToolCardHead(card, toolResult.name, headArgs, pillClass, pillText);
      let body = card.querySelector('.tool-card__body');
      if (!body) {
        body = document.createElement('div');
        body.className = 'tool-card__body';
        card.appendChild(body);
      }
      bindToolCardToggle(card);
    }
    if (isSubagent) card.classList.add('tool-card--subagent');
    const body = card.querySelector('.tool-card__body');
    if (body) renderToolResultBody(body, toolResult);
    if (isSubagent) renderSubagentChat(card, toolResult);
    // Expand errors automatically so the user sees what went wrong
    // without an extra tap. Successful results stay collapsed.
    if (!toolResult.ok) card.classList.add('is-expanded');
    afterTranscriptAppend(true);
  }

  // Replace the header row of a tool card in place. Used when the
  // call card is promoted to a result card and the args / pill need
  // to update without rebuilding the whole card.
  function rebuildToolCardHead(card, toolName, args, pillClass, pillText) {
    const oldHead = card.querySelector(':scope > .tool-card__head');
    const fresh = buildToolCardHead(toolName, args, pillClass, pillText);
    if (oldHead && oldHead.parentNode === card) {
      card.replaceChild(fresh, oldHead);
    } else {
      card.insertBefore(fresh, card.firstChild);
    }
  }

  function isSubagentTool(name) {
    return name === 'subagent' || name === 'functions.subagent';
  }

  function formatToolArgs(args, toolName) {
    if (args == null) return '';
    if (typeof args === 'string') return args;
    const name = normalizeToolName(toolName);
    if (name === 'shell') return args.cmd || '';
    if (name === 'read_file') {
      const range = args.startLine != null || args.endLine != null ? (' lines ' + (args.startLine || 1) + '-' + (args.endLine || 'end')) : '';
      return (args.path || args.file || '') + range;
    }
    if (name === 'list_files') return args.pattern || 'all text files';
    if (name === 'search_files') return [args.path, args.query].filter(Boolean).join(': ');
    if (name === 'write_file' || name === 'edit_file') return args.path || args.file || '';
    if (name === 'subagent') return args.task || '';
    try { return JSON.stringify(args, null, 2); }
    catch { return String(args); }
  }

  function renderToolResultBody(body, toolResult) {
    // For subagent cards we discard the streamed live container; the
    // post-run chat render below (renderSubagentChat) shows the same
    // activity as polished bubbles. Keeping both was duplicative and
    // mixed two visual styles.
    if (isSubagentTool(toolResult && toolResult.name)) {
      const live = body.querySelector('.tool-card__subagent-live');
      if (live) live.remove();
    }
    body.textContent = '';
    body.className = 'tool-card__body';
    const cardTool = body.closest && body.closest('.tool-card');
    const name = normalizeToolName((toolResult && toolResult.name) || (cardTool && cardTool.dataset.toolName));
    const r = coerceToolResult(toolResult && toolResult.result, name);
    if (name === 'shell') return renderShellToolResult(body, r);
    if (name === 'read_file') return renderReadFileToolResult(body, r);
    if (name === 'list_files') return renderListFilesToolResult(body, r);
    if (name === 'search_files') return renderSearchFilesToolResult(body, r);
    if (name === 'edit_file') return renderEditFileToolResult(body, r);
    if (name === 'write_file') return renderWriteFileToolResult(body, r);
    if (isSubagentTool(toolResult && toolResult.name)) {
      // The full chat (user / assistant / tool turns) is rendered
      // by renderSubagentChat, which is called by the caller right
      // after this body fill. Nothing else to add here.
      return;
    }
    if (r && Array.isArray(r.content)) {
      const lines = [];
      for (const c of r.content) {
        if (c && typeof c.text === 'string') lines.push(c.text);
        else if (c && c.type === 'image') {
          const img = imageBlockToElement(c);
          if (img) body.appendChild(img);
          else lines.push('[image]');
        } else if (c && c.type === 'resource') lines.push('[resource] ' + JSON.stringify(c.resource || c));
        else lines.push(String(c && (c.text || c.type) || c));
      }
      if (lines.length) renderPreviewPre(body, lines.join('\n'), 'tool-preview__pre');
      return;
    }
    renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
  }

  function normalizeToolName(name) {
    return String(name || '').replace(/^functions\./, '');
  }

  function coerceToolResult(r, name) {
    if (typeof r !== 'string') return r;
    const s = r.trim();
    if (!s) return r;
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return coerceToolResult(parsed, name);
      return parsed;
    } catch { /* plain text */ }
    if (['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'].includes(name)) return parsePlainFileToolResult(r);
    return r;
  }

  function formatReadableToolResult(r) {
    if (r == null) return '';
    if (typeof r === 'string') {
      const s = r.trim();
      try { return formatReadableToolResult(JSON.parse(s)); } catch { return r; }
    }
    if (r.error) return typeof r.error === 'string' ? r.error : (r.error.message || 'error');
    if (typeof r.output === 'string') return r.output;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') return [r.stdout, r.stderr].filter(Boolean).join('\n');
    const lines = [];
    for (const [k, v] of Object.entries(r)) {
      if (v == null || v === '') continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') lines.push(k + ': ' + v);
    }
    return lines.length ? lines.join('\n') : '(no preview)';
  }

  function parsePlainFileToolResult(text) {
    const s = typeof text === 'string' ? text : '';
    const parts = s.split(/\n\n/);
    const header = parts.shift() || '';
    const body = parts.join('\n\n');
    const out = { body };
    for (const line of header.split('\n')) {
      let m;
      if ((m = line.match(/^# File: (.*)$/))) out.relPath = m[1];
      else if ((m = line.match(/^# Lines: (\d+)-(\d+)(?: \/ (\d+))?/))) {
        out.startLine = Number(m[1]); out.endLine = Number(m[2]); if (m[3]) out.totalLines = Number(m[3]);
      } else if ((m = line.match(/^# Listing: (.*)$/))) out.pattern = m[1] === '<all text files>' ? '' : m[1];
      else if ((m = line.match(/^# Search: (.*)$/))) out.query = m[1];
      else if ((m = line.match(/^# Wrote: (.*)$/))) out.relPath = m[1];
    }
    return out;
  }

  function renderToolMeta(parent, items) {
    const meta = document.createElement('div');
    meta.className = 'tool-preview__meta';
    meta.textContent = items.filter(Boolean).join(' · ');
    parent.appendChild(meta);
  }

  function renderPreviewPre(parent, text, className) {
    const pre = document.createElement('pre');
    pre.className = className || 'tool-preview__pre';
    pre.textContent = text || '';
    parent.appendChild(pre);
    return pre;
  }

  function diffDecorations(view) {
    const builder = new RangeSetBuilder();
    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i);
      const text = line.text;
      const cls = text.startsWith('+') && !text.startsWith('+++')
        ? 'cm-diff-added'
        : text.startsWith('-') && !text.startsWith('---')
          ? 'cm-diff-removed'
          : text.startsWith('@@')
            ? 'cm-diff-hunk'
            : '';
      if (cls) builder.add(line.from, line.from, Decoration.line({ class: cls }));
    }
    return builder.finish();
  }

  function renderDiffPreview(parent, text) {
    const host = document.createElement('div');
    host.className = 'tool-preview__diff';
    const raw = text == null ? '' : String(text);
    const lines = raw ? raw.split('\n') : ['(edit applied)'];
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const line = document.createElement('div');
      let kind = 'ctx';
      if (lineText.startsWith('+') && !lineText.startsWith('+++')) kind = 'add';
      else if (lineText.startsWith('-') && !lineText.startsWith('---')) kind = 'del';
      else if (lineText.startsWith('@@')) kind = 'hunk';
      else if (lineText.startsWith('---') || lineText.startsWith('+++')) kind = 'meta';
      line.className = 'tool-preview__diff-line tool-preview__diff-line--' + kind;

      const gutter = document.createElement('span');
      gutter.className = 'tool-preview__diff-gutter';
      gutter.textContent = String(i + 1);
      const code = document.createElement('span');
      code.className = 'tool-preview__diff-code';
      code.textContent = lineText || ' ';
      line.appendChild(gutter);
      line.appendChild(code);
      host.appendChild(line);
    }
    parent.appendChild(host);
    return host;
  }

  function renderReadFileToolResult(body, r) {
    body.classList.add('tool-preview', 'tool-preview--file');
    if (typeof r === 'string') r = parsePlainFileToolResult(r);
    if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
    renderToolMeta(body, [
      r.relPath || r.path,
      (r.startLine != null && r.endLine != null) ? ('lines ' + r.startLine + '-' + r.endLine + (r.totalLines ? ' / ' + r.totalLines : '')) : null
    ]);
    renderPreviewPre(body, r.body || '', 'tool-preview__pre tool-preview__pre--content');
  }

  function renderListFilesToolResult(body, r) {
    body.classList.add('tool-preview', 'tool-preview--list');
    if (typeof r === 'string') r = parsePlainFileToolResult(r);
    if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
    renderToolMeta(body, [
      r.pattern ? ('pattern ' + r.pattern) : 'all text files',
      Array.isArray(r.entries) ? (r.entries.length + ' shown') : null,
      r.skipped ? (r.skipped + ' skipped') : null,
      r.truncated ? 'capped' : null
    ]);
    const lines = Array.isArray(r.entries) ? r.entries.map((e) => (e.path || '') + (e.size != null ? '\t' + e.size : '')) : String(r.body || '').split('\n');
    renderPreviewPre(body, lines.length && lines[0] ? lines.join('\n') : '(no matching files)', 'tool-preview__pre tool-preview__pre--list');
  }

  function renderSearchFilesToolResult(body, r) {
    body.classList.add('tool-preview', 'tool-preview--list');
    if (typeof r === 'string') r = parsePlainFileToolResult(r);
    if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
    renderToolMeta(body, [r.query ? ('search ' + r.query) : null, Array.isArray(r.matches) ? (r.matches.length + ' matches') : null]);
    const lines = Array.isArray(r.matches) ? r.matches.map((m) => (m.path || '') + ':' + m.line + ': ' + (m.text || '')) : String(r.body || '').split('\n');
    renderPreviewPre(body, lines.length && lines[0] ? lines.join('\n') : '(no matches)', 'tool-preview__pre tool-preview__pre--list');
  }

  function renderEditFileToolResult(body, r) {
    body.classList.add('tool-preview', 'tool-preview--diff');
    if (typeof r === 'string') r = parsePlainFileToolResult(r);
    if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
    renderToolMeta(body, [
      r.relPath || r.path
    ]);
    renderDiffPreview(body, r.diff || '(edit applied)');
  }

  function renderWriteFileToolResult(body, r) {
    body.classList.add('tool-preview', 'tool-preview--file');
    if (typeof r === 'string') r = parsePlainFileToolResult(r);
    if (!r || r.error) return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__pre');
    renderToolMeta(body, [r.relPath || r.path]);
    renderPreviewPre(body, 'write complete', 'tool-preview__pre');
  }

  function renderShellToolResult(body, r) {
    body.classList.add('tool-preview', 'tool-preview--terminal');
    if (typeof r === 'string') r = coerceToolResult(r, 'shell');
    if (!r || r.error) {
      renderToolMeta(body, [r && r.code, r && r.durationMs != null ? (r.durationMs + 'ms') : null]);
      return renderPreviewPre(body, formatReadableToolResult(r), 'tool-preview__terminal');
    }
    renderToolMeta(body, ['exit ' + (r.exitCode ?? 0), r.durationMs != null ? (r.durationMs + 'ms') : null]);
    const out = [];
    if (r.stdout) out.push('$ stdout\n' + r.stdout);
    if (r.stderr) out.push('$ stderr\n' + r.stderr);
    renderPreviewPre(body, out.length ? out.join('\n\n') : '(no output)', 'tool-preview__terminal');
  }

  function appendToolText(parent, text) {
    parent.appendChild(document.createTextNode(text));
  }

  function renderSubagentChat(card, toolResult) {
    if (!card) return;
    // Drop any prior chat render so re-runs don't stack copies.
    const old = card.querySelector('.tool-card__subagent-chat');
    if (old) old.remove();
    // If the live container already streamed nested activity in, we
    // keep it (so per-tool rows aren't lost) and render the chat
    // bubbles alongside it inside the same card body. The live
    // container stays in place until we explicitly remove it.
    const r = coerceToolResult(toolResult && toolResult.result, normalizeToolName(toolResult && toolResult.name));
    const chat = r && Array.isArray(r.chat) ? r.chat : null;
    if ((!chat || !chat.length) && !(r && typeof r.text === 'string' && r.text)) return;
    const wrap = document.createElement('div');
    wrap.className = 'tool-card__subagent-chat';
    // Don't let taps inside the nested chat bubble up to the parent
    // card's expand/collapse toggle.
    wrap.addEventListener('click', (e) => e.stopPropagation());
    const turns = chat && chat.length ? chat : [{ role: 'assistant', content: r.text }];
    for (const m of turns) {
      const role = m && m.role;
      if (role === 'tool') {
        // Tool turns are not chat bubbles — render them as compact
        // tool rows so the nested transcript shows the full loop
        // (assistant call → tool result) without breaking the
        // bubble rhythm for the user/assistant turns around them.
        const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        if (toolCalls.length) {
          for (const tc of toolCalls) appendSubagentNestedToolCall(wrap, tc);
        } else {
          appendSubagentToolResult(wrap, m);
        }
        continue;
      }
      if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
      const row = document.createElement('div');
      row.className = 'chat-msg chat-msg--' + role + ' tool-card__subagent-msg';
      const roleEl = document.createElement('div');
      roleEl.className = 'chat-msg__role';
      roleEl.textContent = role;
      const body = document.createElement('div');
      body.className = 'chat-msg__body';
      const content = typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content, null, 2) : '');
      if (role === 'assistant') {
        renderAssistantBody(body, content || '', '', true);
      } else {
        body.textContent = content || '';
      }
      row.appendChild(roleEl); row.appendChild(body);
      // Inline any tool calls attached to this assistant turn so the
      // bubble shows the full assistant→tool→assistant loop.
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of toolCalls) appendSubagentNestedToolCall(row, tc);
      wrap.appendChild(row);
    }
    // Append inside the card's body so the body's max-height,
    // overflow, and expand/collapse mask control the nested chat.
    const body = card.querySelector('.tool-card__body');
    if (body) body.appendChild(wrap);
    else card.appendChild(wrap);
  }

  // Shared helper for the compact "nested tool" row used both in the
  // live stream and in the final chat dump. Kept here so the two
  // paths stay visually identical.
  function appendSubagentNestedToolCall(parent, tc) {
    const fn = (tc && tc.function) || tc || {};
    const call = document.createElement('div');
    call.className = 'tool-card__subagent-tool';
    if (tc && tc.id) call.dataset.nestedToolId = tc.id;
    const callName = document.createElement('span');
    callName.className = 'tool-card__subagent-tool-name';
    callName.textContent = fn.name || 'tool';
    const callArgs = document.createElement('pre');
    callArgs.className = 'tool-card__subagent-text';
    const rawArgs = fn.arguments != null ? fn.arguments : (tc && tc.args);
    let parsedArgs = rawArgs;
    if (typeof rawArgs === 'string') { try { parsedArgs = JSON.parse(rawArgs); } catch { /* keep raw string */ } }
    callArgs.textContent = typeof parsedArgs === 'object' && parsedArgs !== null
      ? formatToolArgs(parsedArgs, fn.name)
      : String(rawArgs || '');
    call.appendChild(callName); call.appendChild(callArgs);
    parent.appendChild(call);
    return call;
  }

  function appendSubagentToolResult(parent, m) {
    const call = document.createElement('div');
    call.className = 'tool-card__subagent-tool';
    const callName = document.createElement('span');
    callName.className = 'tool-card__subagent-tool-name';
    callName.textContent = m.name || 'tool';
    call.appendChild(callName);
    renderSubagentToolPreview(call, m.name, m.content);
    parent.appendChild(call);
  }

  function renderSubagentToolPreview(parent, name, raw) {
    const toolName = normalizeToolName(name);
    const r = coerceToolResult(raw, toolName);
    const preview = document.createElement('div');
    preview.className = 'tool-card__subagent-preview';
    parent.appendChild(preview);
    if (toolName === 'shell') return renderShellToolResult(preview, r);
    if (toolName === 'read_file') return renderReadFileToolResult(preview, r);
    if (toolName === 'list_files') return renderListFilesToolResult(preview, r);
    if (toolName === 'search_files') return renderSearchFilesToolResult(preview, r);
    if (toolName === 'edit_file') return renderEditFileToolResult(preview, r);
    if (toolName === 'write_file') return renderWriteFileToolResult(preview, r);
    if (r && Array.isArray(r.content)) {
      const lines = [];
      for (const c of r.content) {
        if (c && typeof c.text === 'string') lines.push(c.text);
        else lines.push(String(c && (c.text || c.type) || c));
      }
      return renderPreviewPre(preview, lines.join('\n'), 'tool-preview__pre');
    }
    return renderPreviewPre(preview, formatReadableToolResult(r), 'tool-preview__pre');
  }

  function imageBlockToElement(block) {
    const data = block && (block.data || block.base64);
    const mimeType = (block && (block.mimeType || block.mime_type || block.mediaType || block.media_type)) || 'image/png';
    let src = block && (block.url || block.uri);
    if (!src && typeof data === 'string' && data) {
      src = data.startsWith('data:') ? data : ('data:' + mimeType + ';base64,' + data);
    }
    if (!src) return null;
    const img = document.createElement('img');
    img.className = 'tool-card__image';
    img.src = src;
    img.alt = 'MCP image result';
    img.loading = 'lazy';
    return img;
  }

  function formatToolResult(toolResult) {
    const r = toolResult && toolResult.result;
    if (!r) return '';
    if (Array.isArray(r.content)) {
      const parts = r.content.map((c) => {
        if (c && typeof c.text === 'string') return c.text;
        if (c && c.type === 'image') return '[image]';
        if (c && c.type === 'resource') return JSON.stringify(c.resource || c);
        return JSON.stringify(c);
      });
      return parts.join('\n');
    }
    if (r.error) return JSON.stringify(r.error, null, 2);
    try { return JSON.stringify(r, null, 2); } catch { return String(r); }
  }

  function authorizationCard(request, resume) {
    return new Promise((resolve) => {
      if (!transcript.current) return resolve('deny');
      const card = document.createElement('div');
      card.className = 'tool-card tool-card--authorization';
      const title = document.createElement('div');
      title.className = 'tool-card__role';
      title.textContent = 'authorization required';
      const name = document.createElement('div');
      name.className = 'tool-card__name';
      name.textContent = request.tool || 'tool';
      const detail = document.createElement('pre');
      detail.className = 'tool-card__body';
      detail.textContent = [request.cmd || '', request.projectDir || '', request.timeoutMs ? ('timeout: ' + request.timeoutMs + ' ms') : '']
        .filter(Boolean).join('\n');
      const actions = document.createElement('div');
      actions.className = 'tool-card__actions';
      for (const [decision, label] of [
        ['allow-once', 'Allow once'],
        ['allow-session', 'Allow for session'],
        ['allow-always', 'Always allow'],
        ['deny', 'Deny']
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn' + (decision === 'deny' ? ' btn--danger' : '');
        button.textContent = label;
        button.addEventListener('click', async () => {
          for (const child of actions.querySelectorAll('button')) child.disabled = true;
          const r = await fetchJson('/api/tools/authorization/decision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision })
          });
          if (r.status !== 200) {
            for (const child of actions.querySelectorAll('button')) child.disabled = false;
            setChatStatus('authorization failed: HTTP ' + r.status, 'error');
            return;
          }
          card.remove();
          if (decision !== 'deny' && typeof resume === 'function') await resume();
          resolve(decision);
        });
        actions.appendChild(button);
      }
      card.appendChild(title); card.appendChild(name); card.appendChild(detail); card.appendChild(actions);
      transcript.current.appendChild(card);
      afterTranscriptAppend(true);
    });
  }

  // CSS.escape polyfill for older mobile browsers; we only need to
  // escape the chars that can appear in a tool call id (alnum, _, -).
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c);
  }

  // Render an "Ask the user" card. The model has paused the chat to
  // ask a structured question with 2-4 options; the user picks one
  // and may always add a free-form "extra" note alongside their
  // pick. The selection + extra text is sent back via the
  // /api/tools/authorization/decision endpoint, and the auth gate's
  // `wait()` resolves with the payload so the runner can fold both
  // into the `tool` message the model sees.
  function askUserCard(request) {
    if (!transcript.current) return;
    const card = document.createElement('div');
    card.className = 'tool-card tool-card--ask-user';
    card.dataset.toolId = request.callId || ('ask_' + Math.random().toString(36).slice(2, 10));
    const head = document.createElement('div');
    head.className = 'tool-card__head';
    const role = document.createElement('span');
    role.className = 'tool-card__role';
    role.textContent = 'the model is asking';
    head.appendChild(role);
    const pill = document.createElement('span');
    pill.className = 'tool-card__pill';
    pill.textContent = 'waiting';
    head.appendChild(pill);
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'tool-card__body tool-card__ask-body';
    const question = document.createElement('p');
    question.className = 'tool-card__ask-question';
    question.textContent = request.question || '(no question)';
    body.appendChild(question);
    const optionsHost = document.createElement('div');
    optionsHost.className = 'tool-card__ask-options';
    body.appendChild(optionsHost);
    const options = Array.isArray(request.options) ? request.options : [];
    const multi = !!request.multiSelect;
    let selectedValues = multi ? new Set() : null;
    let lastTapped = null;
    function refreshSelectedUi() {
      for (const optEl of optionsHost.querySelectorAll('.tool-card__ask-option')) {
        const v = optEl.dataset.value || '';
        const on = multi ? selectedValues.has(v) : (v === (lastTapped && lastTapped.value));
        optEl.classList.toggle('is-selected', !!on);
        optEl.setAttribute('aria-checked', multi ? (on ? 'true' : 'false') : (on ? 'true' : 'false'));
      }
    }
    for (let i = 0; i < options.length; i++) {
      const opt = options[i] || {};
      const optEl = document.createElement('button');
      optEl.type = 'button';
      optEl.className = 'tool-card__ask-option';
      optEl.dataset.value = String(opt.value || '');
      optEl.setAttribute('role', multi ? 'checkbox' : 'radio');
      optEl.setAttribute('aria-checked', 'false');
      const label = document.createElement('span');
      label.className = 'tool-card__ask-option-label';
      label.textContent = opt.label || opt.value || ('option ' + (i + 1));
      optEl.appendChild(label);
      if (opt.description) {
        const desc = document.createElement('span');
        desc.className = 'tool-card__ask-option-desc';
        desc.textContent = opt.description;
        optEl.appendChild(desc);
      }
      optEl.addEventListener('click', () => {
        if (multi) {
          if (selectedValues.has(optEl.dataset.value)) selectedValues.delete(optEl.dataset.value);
          else selectedValues.add(optEl.dataset.value);
        } else {
          lastTapped = { value: optEl.dataset.value, label: opt.label || optEl.dataset.value };
        }
        refreshSelectedUi();
      });
      optionsHost.appendChild(optEl);
    }
    const extraLabel = document.createElement('label');
    extraLabel.className = 'tool-card__ask-extra-label';
    extraLabel.textContent = 'Add an extra answer (always optional)';
    body.appendChild(extraLabel);
    const extra = document.createElement('textarea');
    extra.className = 'input tool-card__ask-extra';
    extra.rows = 2;
    extra.spellcheck = false;
    extra.maxLength = 1000;
    extra.placeholder = 'Add context, a follow-up, or just a note for the model.';
    body.appendChild(extra);
    const actions = document.createElement('div');
    actions.className = 'tool-card__actions';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn--primary';
    submit.textContent = 'Send answer';
    submit.addEventListener('click', async () => {
      const choice = multi
        ? Array.from(selectedValues)
        : (lastTapped ? [lastTapped.value] : []);
      // No option selected: treat as a dismiss so the model gets a
      // clean `cancelled: true` result instead of an empty answer.
      if (!choice.length) {
        for (const child of actions.querySelectorAll('button')) child.disabled = true;
        const r = await fetchJson('/api/tools/authorization/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision: 'deny' })
        });
        if (r.status !== 200) {
          for (const child of actions.querySelectorAll('button')) child.disabled = false;
          setChatStatus('ask_user failed: HTTP ' + r.status, 'error');
          return;
        }
        card.remove();
        setChatStatus('question dismissed', 'success');
        return;
      }
      for (const child of actions.querySelectorAll('button')) child.disabled = true;
      const payload = {
        choice: multi ? Array.from(selectedValues) : (lastTapped ? lastTapped.value : ''),
        extra: extra.value || ''
      };
      const r = await fetchJson('/api/tools/authorization/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision: 'allow-once', payload })
      });
      if (r.status !== 200) {
        for (const child of actions.querySelectorAll('button')) child.disabled = false;
        setChatStatus('ask_user failed: HTTP ' + r.status, 'error');
        return;
      }
      card.remove();
      setChatStatus('answer sent', 'success');
    });
    actions.appendChild(submit);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', async () => {
      for (const child of actions.querySelectorAll('button')) child.disabled = true;
      const r = await fetchJson('/api/tools/authorization/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, chatId, callId: request.callId, decision: 'deny' })
      });
      if (r.status !== 200) {
        for (const child of actions.querySelectorAll('button')) child.disabled = false;
        setChatStatus('ask_user failed: HTTP ' + r.status, 'error');
        return;
      }
      card.remove();
      setChatStatus('question dismissed', 'success');
    });
    actions.appendChild(dismiss);
    body.appendChild(actions);
    card.appendChild(body);
    transcript.current.appendChild(card);
    afterTranscriptAppend(true);
    // Mobile-first: scroll the card into view and move keyboard focus
    // to the first option so the user can answer with the on-screen
    // keyboard. The `extra` textarea is below the options; tapping
    // it later is one tap away.
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* non-fatal */ }
  }

  function finalizeLiveMessage(message) {
    if (!transcript.current) return;
    const liveRow = transcript.current.querySelector('[data-live="1"]');
    if (liveRow) {
      delete liveRow.dataset.live;
      if (liveRow._body && message && typeof message.content === 'string') {
        // Render the assembled assistant turn as markdown. Non-assistant
        // roles (and the rare "stream interrupted" sentinel) stay as
        // plain text so we never inject HTML into error placeholders.
        const isAssistant = liveRow.classList.contains('chat-msg--assistant');
        if (isAssistant) {
          renderAssistantBody(liveRow._body, message.content, message.reasoning || liveRow._reasoning || '', true);
        } else {
          liveRow._body.textContent = message.content;
        }
      }
    }
  }

  async function updateChat(patch) {
    if (!projectDir || !chatId) return;
    const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectDir }, patch || {}))
    });
    if (r.status !== 200) { if (statusEl.current) statusEl.current.textContent = 'HTTP ' + r.status; return; }
    chatRef.current = r.body.chat;
    updateMetaLine();
    updateModelTrigger();
    refreshProviderCredit();
  }

  async function refreshChatTitle() {
    if (!projectDir || !chatId) return;
    try {
      const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir));
      if (r.status === 200 && r.body && r.body.chat) {
        chatRef.current = r.body.chat;
        if (chatName.current) chatName.current.textContent = chatRef.current.title || chatId;
      }
    } catch { /* non-fatal */ }
  }

  function renameChat() {
    if (!chatRef.current) return;
    const next = prompt('Rename chat', chatRef.current.title || chatId);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === chatRef.current.title) return;
    updateChat({ title: trimmed }).then(() => {
      if (chatRef.current && chatName.current) chatName.current.textContent = chatRef.current.title || chatId;
    });
  }

  // Shared setter for the in-transcript setup control. The prompt
  // size is chosen once, while the chat is still empty; the control
  // is not a permanent fixture (see updateSetupVisibility below).
  function setPromptSize(v) {
    if (['very-small', 'average', 'extensive'].indexOf(v) < 0) return;
    updateSwitch(v);
    updateChat({ promptSize: v }).then(() => { refreshSystemPrompt(); });
  }

  // Reflect the active profile in the in-transcript <select>. The
  // select is updated by toggling `selected` on the matching <option>
  // \u2014 not by setting `value` on the <select> (Preact can drop a
  // <select value=\u2026> on first mount when the option list isn't
  // attached yet, see user memory). updateSwitch is a no-op if the
  // setup card has already been removed.
  function updateSwitch(id) {
    const host = setupCardRef.current;
    if (!host) return;
    const opts = host.querySelectorAll('option');
    for (const o of opts) {
      if (o.value === id) o.setAttribute('selected', '');
      else o.removeAttribute('selected');
    }
  }

  // The setup control is a CREATION-TIME widget: it is only mounted
  // while the chat has no messages yet, so the user picks the prompt
  // budget up front. As soon as the first message exists the control
  // is removed and never comes back \u2014 the prompt size is fixed for
  // the life of the chat. Removing it (instead of hiding it) keeps
  // the transcript clean: no empty shape behind later messages.
  function updateSetupVisibility() {
    const empty = !messagesRef.current || messagesRef.current.length === 0;
    const host = setupCardRef.current;
    if (empty) {
      if (!host && transcript.current) {
        // Re-entering a chat that was loaded with messages but then
        // deleted (extremely rare; just safety): nothing to do, the
        // setup control is for fresh chats only.
        return;
      }
      return;
    }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    setupCardRef.current = null;
  }

  function deleteThisChat() {
    if (!chatRef.current) return;
    if (!confirm('Delete this chat? Its messages will be removed; any exported trace file will be kept.')) return;
    fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' })
      .then((r) => {
        if (r.status === 200) { projectsReload.value++; nav('projects'); }
        else if (statusEl.current) statusEl.current.textContent = 'delete failed: HTTP ' + r.status;
      })
      .catch((err) => { if (statusEl.current) statusEl.current.textContent = 'network error'; });
  }

  // `/shell <cmd>` composer command: run the native shell tool directly
  // (no model round-trip) and render the result inline as a tool_result
  // card. Same code path the model-initiated call uses server-side.
  async function runShellCommand(cmd) {
    promptInput.current.value = '';
    autoresize();
    appendToolCallCard({ id: null, name: 'shell', args: { cmd } });
    setChatStatus('running shell\u2026', 'busy');
    sendBtn.current.disabled = true;
    const callId = 'direct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    async function requestShell() {
      return fetchJson('/api/tools/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, chatId, callId, cmd })
      });
    }
    let r;
    try {
      r = await requestShell();
      if (r.status === 409 && r.body && r.body.code === 'EAUTH_REQUIRED') {
        let resumed = null;
        const decision = await authorizationCard(r.body, async () => { resumed = await requestShell(); });
        if (decision === 'deny') {
          r = { status: 403, body: { ok: false, code: 'EDENIED', error: 'user denied' } };
        } else {
          r = resumed;
        }
      }
    } catch (err) {
      appendToolResultCard({ id: null, name: 'shell', ok: false, result: { error: String(err) } });
      setChatStatus('shell error', 'error');
      if (sendBtn.current) sendBtn.current.disabled = false;
      return;
    }
    const body = r.body || {};
    appendToolResultCard({ id: null, name: 'shell', ok: !!body.ok, result: body });
    if (r.status === 403) setChatStatus('shell tool is disabled for this project', 'error');
    else setChatStatus(body.ok ? ('shell exit ' + (body.exitCode ?? 0)) : ('shell failed: ' + (body.error || body.code || '')), body.ok ? 'success' : 'error');
    if (sendBtn.current) sendBtn.current.disabled = false;
  }

  function fileToImageAttachment(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(png|jpe?g|webp|gif)$/i.test(file.type || '')) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ type: 'image', mimeType: file.type, dataUrl: String(reader.result || ''), name: file.name || 'image' });
      reader.onerror = () => reject(reader.error || new Error('image read failed'));
      reader.readAsDataURL(file);
    });
  }

  async function addImagesFromFiles(files) {
    const list = Array.from(files || []).filter((f) => f && /^image\/(png|jpe?g|webp|gif)$/i.test(f.type || ''));
    if (!list.length) return;
    try {
      const items = (await Promise.all(list.map(fileToImageAttachment))).filter(Boolean);
      setImageAttachments((prev) => prev.concat(items).slice(0, 8));
      setChatStatus(items.length === 1 ? 'image attached' : (items.length + ' images attached'), 'success');
    } catch {
      setChatStatus('could not read image', 'error');
    }
  }

  function onComposerPaste(e) {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && Array.from(files).some((f) => /^image\//i.test(f.type || ''))) {
      e.preventDefault();
      addImagesFromFiles(files);
    }
  }

  function onImagePickerChange(e) {
    addImagesFromFiles(e.currentTarget.files);
  }

  function removeImageAttachment(idx) {
    setImageAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // --- SSE reconnect ----------------------------------------------
  // When the live stream drops mid-turn the server keeps writing the
  // run to the transcript file, so we recover by polling that file
  // with exponential backoff. Each tick:
  //   1. fetch the persisted transcript
  //   2. if it's still identical to the last poll, the run is over
  //      (or the server died too) — after a few stable ticks give up
  //      and surface a manual "Resume" via a final render
  //   3. if it changed, replace messagesRef and re-render from the
  //      authoritative rows (this drops the frozen live bubble and
  //      shows every assistant/tool segment the server already saved)
  // `partialText` is the assistant text already streamed before the
  // drop; we keep it on screen until the first successful sync lands
  // so the user never sees the turn vanish.
  function startStreamRecovery(partialText) {
    const st = reconnectStateRef.current;
    stopStreamRecovery(); // clear any stale timer from a prior drop
    st.active = true;
    st.attempts = 0;
    st.stopped = false;
    st.partialText = partialText || '';
    streamingRef.current = true; // still "in a turn" for the poller
    setChatStatus('connection lost — reconnecting…', 'busy');
    scheduleRecoveryTick(0);
  }

  function scheduleRecoveryTick(attempt) {
    const st = reconnectStateRef.current;
    if (st.stopped) return;
    // Backoff: 1s, 2s, 4s, 5s, 5s … (cap at 5s, cap total attempts).
    const delay = Math.min(5000, 1000 * Math.pow(2, attempt));
    st.timer = setTimeout(runRecoveryTick, delay);
  }

  async function runRecoveryTick() {
    const st = reconnectStateRef.current;
    if (st.stopped || !st.active) return;
    st.attempts += 1;
    let synced = null;
    try {
      const r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir));
      if (r.status === 200 && Array.isArray(r.body.messages)) synced = r.body.messages;
    } catch { synced = null; }

    if (!synced) {
      // Server unreachable — keep trying while attempts remain.
      if (st.attempts < 6) return scheduleRecoveryTick(st.attempts);
      return finishStreamRecovery('could not reconnect — tap to retry', true);
    }

    const signature = JSON.stringify(synced);
    const grew = signature !== transcriptSignatureRef.current;
    if (grew) {
      // New content landed on disk. Swap in the authoritative rows and
      // reset the stability counter — the run is clearly still going.
      messagesRef.current = synced;
      transcriptSignatureRef.current = signature;
      renderTranscript();
      st.stableTicks = 0;
      setChatStatus('reconnected — syncing…', 'busy');
      return scheduleRecoveryTick(st.attempts);
    }

    // Transcript is stable. A run is done when the last message is no
    // longer a bare tool call (a call with no result yet means the agent
    // is mid-tool) and we've seen a couple of identical polls.
    const last = synced[synced.length - 1];
    const midTool = last && last.role === 'tool' && last.phase === 'call';
    st.stableTicks = (st.stableTicks || 0) + 1;
    if (!midTool && st.stableTicks >= 2) {
      return finishStreamRecovery(null, false);
    }
    if (st.attempts >= 8) {
      return finishStreamRecovery('reconnect timed out — pull to retry', true);
    }
    scheduleRecoveryTick(st.attempts);
  }

  function finishStreamRecovery(message, failed) {
    const st = reconnectStateRef.current;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.active = false;
    streamingRef.current = false;
    if (sendBtn.current) sendBtn.current.disabled = false;
    if (message) setChatStatus(message, failed ? 'error' : 'success');
    else setChatStatus('reconnected', 'success');
  }

  function stopStreamRecovery() {
    const st = reconnectStateRef.current;
    st.stopped = true;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.active = false;
  }

  async function send() {
    if (!projectDir || !chatId) return;
    // The model picker is the source of truth (not a <select>
    // value) \u2014 the chat record carries { providerId, modelId }.
    const c = chatRef.current || {};
    const modelId = c.modelId || '';
    const providerId = c.providerId || '';
    const content = (promptInput.current.value || '').trim();
    const attachments = imageAttachments;
    if (!content && !attachments.length) { statusEl.current.textContent = 'type something or add an image'; return; }
    // /shell <cmd> \u2014 direct tool invocation, no model.
    if (content.startsWith('/shell ')) {
      const cmd = content.slice('/shell '.length).trim();
      if (cmd) return runShellCommand(cmd);
    }
    if (!modelId || !providerId) {
      // If the chat has no provider+model yet, open the picker so
      // the user is one tap from picking one. (Saves a "you must
      // pick a model first" round-trip.)
      setChatStatus(!providersRef.current.length ? 'add a provider in Settings \u2192 Providers' : 'pick a model', 'error');
      openModelPicker();
      return;
    }

    // Persist the pair before sending so reopening this chat keeps the exact
    // provider/model choice instead of falling back to the first connection.
    await updateChat({ providerId, modelId });

    sendBtn.current.disabled = true;
    streamingRef.current = true;
    setChatStatus('streaming\u2026', 'busy');
    promptInput.current.value = '';
    await clearComposerDraft();
    setImageAttachments([]);
    if (imageInputRef.current) imageInputRef.current.value = '';
    autoresize();

    const userMsg = { role: 'user', content, attachments, ts: new Date().toISOString() };
    messagesRef.current = messagesRef.current.concat([userMsg]);
    appendMessageToTranscript(userMsg, false);
    // The first message ends the creation phase: remove the prompt-size
    // setup control for good (the prompt size is now fixed).
    updateSetupVisibility();
    // Don't append the live assistant bubble eagerly: when the model
    // opens with a tool call (no text delta first), the empty bubble
    // would sit above the tool card with nothing in it. Both
    // appendDeltaToLive and appendReasoningToLive create the live row
    // lazily on the first delta, so the bubble appears exactly when
    // there is content to show.

    // Live per-turn counter. The chat UI runs this on every delta;
    // the server's authoritative completionTokens (sent on `done`)
    // replaces the heuristic on the final tick. The counter is
    // scoped to a single turn \u2014 reset() is called after `done` so
    // the next user message starts from 0.
    const counter = createCounter();

    let resp;
    try {
      resp = await fetch('/api/chats/' + encodeURIComponent(chatId) + '/messages/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, modelId, providerId, content, attachments })
      });
    } catch (err) {
      setChatStatus('network error', 'error');
      finalizeLiveMessage({ content: '[network error]' });
      streamingRef.current = false;
      if (sendBtn.current) sendBtn.current.disabled = false;
      return;
    }
    if (!resp.ok) {
      const text = await resp.text();
      setChatStatus('HTTP ' + resp.status, 'error');
      finalizeLiveMessage({ content: '[error: HTTP ' + resp.status + ']' });
      streamingRef.current = false;
      sendBtn.current.disabled = false;
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', assembled = '', reasoning = '';
    let usage = null;
    let cost = null;
    let streamingMs = null;
    // Throttle the live tok/s repaint: redrawing on every delta
    // produces a strobe effect on a phone. We repaint at most every
    // 120 ms while deltas are flowing, and once on `done`.
    let lastRepaintAt = 0;
    function repaintLiveRate() {
      if (!transcript.current) return;
      const live = transcript.current.querySelector('[data-live="1"]');
      if (!live) return;
      const meta = live.querySelector('.chat-msg__meta');
      if (!meta) return;
      const info = { modelId, usage, cost, streamingMs, liveRate: counter.rate(usage && usage.completionTokens) };
      renderUsageMeta(meta, info);
      updateUsageSummary(info);
    }
    let streamFailed = false;
    function handleStreamEvent(ev, data) {
      // Nested subagent activity: render inside the parent subagent card
      // instead of the live bubble / standalone tool cards.
      if (ev.eventName === 'subagent_event' && data) {
        handleSubagentStreamEvent({ eventName: data.kind }, Object.assign({ parentCallId: data.parentCallId }, data.data || {}));
        return;
      }
      if (data && data.parentTool === 'subagent' && ev.eventName === 'authorization_required') {
        authorizationCard(data);
        return;
      }
      if (data && data.parentTool === 'subagent' && ev.eventName === 'ask_user_required') {
        askUserCard(data);
        return;
      }
      if (ev.eventName === 'message' && typeof data.delta === 'string') {
        assembled += data.delta;
        counter.add(data.delta);
        appendDeltaToLive(data.delta);
        const now = performance.now ? performance.now() : Date.now();
        if (now - lastRepaintAt > 120) {
          lastRepaintAt = now;
          repaintLiveRate();
        }
      }
      else if (ev.eventName === 'reasoning' && typeof data.delta === 'string') {
        reasoning += data.delta;
        appendReasoningToLive(data.delta);
        // Reasoning deltas build the live bubble too (thinking-first
        // turns), so repaint the meta line on the same throttle as
        // text — otherwise context usage stays blank until the first
        // answer token arrives.
        const now = performance.now ? performance.now() : Date.now();
        if (now - lastRepaintAt > 120) {
          lastRepaintAt = now;
          repaintLiveRate();
        }
      }
      else if (ev.eventName === 'done') {
        // Merge rather than overwrite: usage_input/usage_output may have
        // accumulated a prompt/completion count before `done`. A `done`
        // that omits a field (e.g. Anthropic's empty message_stop, or a
        // provider that only streamed per-round usage) must not clobber
        // the numbers we already have.
        if (data.usage) {
          const merged = usage || {};
          const p = Number(data.usage.promptTokens);
          const c = Number(data.usage.completionTokens);
          if (isFinite(p) && p > 0) merged.promptTokens = p;
          if (isFinite(c) && c > 0) merged.completionTokens = c;
          usage = merged;
        }
        cost = data.cost || cost;
        streamingMs = typeof data.streamingMs === 'number' ? data.streamingMs : streamingMs;
        refreshChatTitle();
      }
      else if (ev.eventName === 'usage_input') {
        // Per-round prompt footprint (fires on each tool round for
        // Anthropic; the final `done` carries the authoritative sum).
        // Keep the largest prompt seen so the meta line reflects the
        // fullest the context has been during this exchange.
        const p = Number(data && data.promptTokens);
        if (isFinite(p) && p > 0) {
          usage = usage || {};
          if (!usage.promptTokens || p > usage.promptTokens) usage.promptTokens = p;
          repaintLiveRate();
        }
      }
      else if (ev.eventName === 'usage_output') {
        const c = Number(data && data.completionTokens);
        if (isFinite(c) && c > 0) {
          usage = usage || {};
          usage.completionTokens = (usage.completionTokens || 0) + c;
          repaintLiveRate();
        }
      }
      else if (ev.eventName === 'assistant_turn_end') {
        const segment = assembled;
        const thoughtSegment = reasoning;
        if (segment || thoughtSegment) {
          finalizeLiveMessage({ content: segment, reasoning: thoughtSegment });
          messagesRef.current = messagesRef.current.concat([{
            role: 'assistant', content: segment, reasoning: thoughtSegment, ts: new Date().toISOString(), modelId
          }]);
        } else {
          finalizeLiveMessage({ content: '', reasoning: '' });
        }
        assembled = '';
        reasoning = '';
      }
      else if (ev.eventName === 'authorization_required') { authorizationCard(data); }
      else if (ev.eventName === 'ask_user_required') { askUserCard(data); }
      else if (ev.eventName === 'tool_call') { appendToolCallCard(data); }
      else if (ev.eventName === 'tool_result') { appendToolResultCard(data); }
      else if (ev.eventName === 'error') {
        streamFailed = true;
        setChatStatus('error: ' + (data.code || '') + ' ' + (data.message || '') + (data.detail ? ' — ' + data.detail : ''), 'error');
      }
    }
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = parseSSEFrame(frame); if (!ev) continue;
          let data; try { data = JSON.parse(ev.data); } catch { continue; }
          try {
            handleStreamEvent(ev, data);
          } catch (eventError) {
            // A rendering failure in one tool card must not cancel the
            // network reader: the model may still be producing the next
            // assistant turn. Surface it for diagnostics and keep reading.
            console.error('chat SSE event failed', ev.eventName, eventError);
          }
        }
      }
    } catch (err) {
      streamFailed = true;
      console.error('chat SSE reader failed', err);
      setChatStatus('stream interrupted: ' + (err && err.message ? err.message : 'connection closed'), 'error');
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      if (sendBtn.current) sendBtn.current.disabled = false;
    }
    if (streamFailed) {
      // The SSE socket dropped mid-turn, but the server-side agent may
      // still be appending to the persisted transcript. Rather than
      // end on a "[stream interrupted]" bubble, hand the partial turn
      // over to a backoff poll that syncs from disk. If the transcript
      // is still growing, new segments/tool cards appear as they land.
      // The assistant text already streamed stays in the live bubble
      // until the first poll replaces it with the authoritative rows.
      finalizeLiveMessage({ content: assembled, reasoning });
      counter.reset();
      startStreamRecovery(assembled);
      return;
    }
    finalizeLiveMessage({ content: assembled, reasoning });
    // Final meta line: the live counter has the authoritative
    // completionTokens (from `usage.completionTokens`); the cost is
    // already on the `done` event. The stored message keeps both so
    // a chat that is reopened later shows the same numbers (decision
    // \u00a714 \u2014 usage is persisted on the assistant message).
    const finalRate = counter.rate(usage && usage.completionTokens);
    const persisted = {
      role: 'assistant',
      content: assembled,
      reasoning,
      ts: new Date().toISOString(),
      modelId,
      usage: usage || undefined,
      cost: cost || undefined,
      streamingMs: streamingMs || undefined,
      liveRate: finalRate
    };
    messagesRef.current = messagesRef.current.concat([persisted]);
    updateUsageSummary();
    // Replace the live row's meta with the final, authoritative
    // version (counter is reset on next turn).
    if (transcript.current) {
      const live = transcript.current.querySelector('[data-live="1"]');
      if (live) {
        const meta = live.querySelector('.chat-msg__meta');
        if (meta) renderUsageMeta(meta, persisted);
      }
    }
    counter.reset();
    // The server transcript is authoritative. Reconcile after the complete
    // exchange so tool-heavy turns cannot leave the browser showing only the
    // last tool card when a delta/boundary was missed, reordered, or failed
    // to render. This also restores every intermediate assistant segment with
    // exactly the same ordering that will be shown after reopening the chat.
    try {
      const synced = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir));
      if (synced.status === 200 && Array.isArray(synced.body.messages)) {
        messagesRef.current = synced.body.messages;
        transcriptSignatureRef.current = JSON.stringify(messagesRef.current);
        renderTranscript();
      }
    } catch (syncError) {
      console.error('chat transcript reconciliation failed', syncError);
    }
    if (statusEl.current.textContent === 'streaming\u2026') {
      const hasCounts = usage && (usage.promptTokens != null || usage.completionTokens != null);
      setChatStatus(
        hasCounts
          ? ('done \u2014 ' + (usage.promptTokens || 0) + ' in, ' + (usage.completionTokens || 0) + ' out')
          : 'done',
        'success'
      );
    }
    if (sendBtn.current) sendBtn.current.disabled = false;
    streamingRef.current = false;
  }

  function autoresize() {
    const el = promptInput.current;
    if (!el) return;
    el.style.height = 'auto';
    /* 44px floor matches the CSS min-height on .chat-view__textarea
       and the --tap touch target, so the single-line composer row
       lines up with the send button. 120px ceiling is the max
       multi-line height before the textarea scrolls. */
    const next = Math.min(140, Math.max(44, el.scrollHeight));
    el.style.height = next + 'px';
  }

  function queueComposerDraftSave(value) {
    if (!projectDir || !chatId) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      updateChat({ draft: value || '' }).catch(() => {});
    }, 250);
  }

  function clearComposerDraft() {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    return updateChat({ draft: '' });
  }

  function onComposerInput() {
    queueComposerDraftSave(promptInput.current ? promptInput.current.value : '');
    autoresize();
  }

  useEffect(() => {
    function onDocClick(e) {
      const pickerPop = modelPickerPopRef.current;
      const pickerTrig = modelPickerTriggerRef.current;
      if (pickerPop && !pickerPop.hidden) {
        if (!(pickerPop.contains(e.target) || (pickerTrig && pickerTrig.contains(e.target)))) closeModelPicker();
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        // File editor takes priority: it's a full-screen overlay
        // and a stray Escape from inside the CodeMirror editor
        // would otherwise fall through to the chat's own
        // popovers.
        if (fileEditorOpen[0]) { setFileEditorOpen(false); return; }
        if (modelPickerPopRef.current && !modelPickerPopRef.current.hidden) closeModelPicker();
      }
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    autoresize();
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function onComposerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  // Track whether the user is pinned to the bottom. While pinned,
  // appends keep auto-scrolling; once the user scrolls up we stop
  // hijacking the scroll and surface the jump-to-bottom FAB instead.
  useEffect(() => {
    const el = transcript.current;
    if (!el) return undefined;
    function onScroll() {
      const near = isNearBottom();
      if (near && !pinnedToBottomRef.current) {
        pinnedToBottomRef.current = true;
        pendingCountRef.current = 0;
        updateJumpButton();
      } else if (!near && pinnedToBottomRef.current) {
        pinnedToBottomRef.current = false;
        updateJumpButton();
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [chatId, projectDir]);

  useEffect(() => { load().catch((err) => { if (statusEl.current) statusEl.current.textContent = 'load failed'; }); }, [chatId, projectDir]);

  // Reset the MCP list collapsed/expanded state when the user moves
  // to a different chat. Collapsed/expanded is a per-chat UI choice
  // (the list is a per-chat surface for the model-side tool filter),
  // so it should not silently carry over from another chat.
  useEffect(() => { mcpExpandedRef.current = true; }, [chatId]);

  // Leaving the chat (or unmounting) cancels any in-flight reconnect
  // timer so it can't re-render a detached transcript.
  useEffect(() => () => stopStreamRecovery(), [chatId, projectDir]);

  useEffect(() => {
    if (!chatId || !projectDir) return undefined;
    let stopped = false;
    // True once we've observed the server-side `running` flag on a
    // reloaded chat. While set, the poll drives a busy "still
    // streaming" status; when the flag flips off we restore idle.
    // This is the reload counterpart of streamingRef — that one is
    // this tab's own live stream, this one is a run started before
    // the reload (or in another tab) that we're only watching.
    let watchingRun = false;
    async function reconcileRunningChat() {
      // A reload disconnects the browser from its SSE response, but the
      // server-side agent may still be appending tool calls, results, and
      // assistant segments. Poll the persisted transcript so those new
      // elements appear without requiring another manual reload. Do not
      // reconcile over this tab's own live stream.
      if (stopped || streamingRef.current) return;
      try {
        // The chat record carries the authoritative `running` flag
        // (set by the server while a stream is in flight). Fetch it
        // alongside the transcript so a single tick knows both whether
        // new rows landed and whether the run is still going.
        const [rChat, synced] = await Promise.all([
          fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
          fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir))
        ]);
        if (stopped || synced.status !== 200 || !Array.isArray(synced.body.messages)) return;
        const running = !!(rChat.status === 200 && rChat.body.chat && rChat.body.chat.running);

        const signature = JSON.stringify(synced.body.messages);
        if (signature !== transcriptSignatureRef.current) {
          messagesRef.current = synced.body.messages;
          transcriptSignatureRef.current = signature;
          renderTranscript();
        }

        if (running) {
          // Reflect the in-flight run. sendBtn stays enabled (this tab
          // isn't streaming; the user can still type), but the status
          // line shows the chat is alive rather than frozen.
          watchingRun = true;
          setChatStatus('streaming…', 'busy');
        } else if (watchingRun) {
          // The run we were watching finished. Clear the busy state so
          // the composer returns to idle (the final transcript rows are
          // already rendered above).
          watchingRun = false;
          setChatStatus('done', 'success');
        }
      } catch { /* the next tick retries */ }
    }
    const timer = setInterval(reconcileRunningChat, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [chatId, projectDir]);

  return h('section', { class: 'chat-view' },
    h('div', { class: 'chat-view__head' },
      h('button', { ref: back, class: 'chat-view__back', type: 'button', onClick: () => nav('projects'), 'aria-label': 'Back to projects' }, '\u2190'),
      h('div', { class: 'chat-view__title-stack' },
        h('div', { ref: chatName, class: 'chat-view__name' }, '\u2026'),
        h('div', { ref: chatMeta, class: 'chat-view__meta' }, ''),
        h('div', { ref: usageSummaryRef, class: 'chat-view__usage-summary', 'aria-label': 'Chat usage and provider credit' },
          h('span', null, 'Context --'),
          h('span', null, 'Total --')
        )
      ),
      h('div', { class: 'chat-view__model-row' },
        h('button', { ref: modelPickerTriggerRef, class: 'chat-view__model-trigger', type: 'button', id: 'chatModelTrigger', onClick: openModelPicker, 'aria-label': 'Pick model', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
          h('span', { class: 'chat-view__model-stack' },
            h('span', { class: 'chat-view__model-id' }, '(pick a model)'),
            h('span', { class: 'chat-view__model-provider' }, '')
          ),
          h('span', { class: 'chat-view__model-caret', 'aria-hidden': 'true' }, '\u25be')
        ),
        h('div', { ref: modelPickerPopRef, class: 'chat-view__picker', hidden: true, role: 'dialog', 'aria-label': 'Pick a model' },
          h('div', { class: 'chat-view__picker-head' },
            h('input', { ref: modelPickerSearchRef, class: 'chat-view__picker-search', type: 'search', placeholder: 'Search models', 'aria-label': 'Search models', onInput: onPickerSearch }),
            h('button', { ref: modelPickerRefreshRef, class: 'chat-view__picker-refresh', type: 'button', onClick: refreshAllProviders, 'aria-label': 'Refresh model lists', title: 'Refresh model lists from all providers' },
              h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
                h('path', { d: 'M12 4V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 13c0-4.42-3.58-8-8-8Zm-5.3 7.7A7.93 7.93 0 0 0 4 13c0 4.42 3.58 8 8 8v3l5-5-5-5v3c-3.31 0-6-2.69-6-6 0-1 .25-1.97.7-2.8L5.24 10.24Z', fill: 'currentColor' })
              )
            ),
            h('button', { class: 'chat-view__picker-close', type: 'button', onClick: closeModelPicker, 'aria-label': 'Close', title: 'Close' }, '\u00d7')
          ),
          h('div', { class: 'chat-view__picker-chips', role: 'tablist', 'aria-label': 'Filter by provider' }),
          h('div', { ref: modelPickerListRef, class: 'chat-view__picker-list' })
        )
      ),
      h('a', { class: 'chat-view__iconbtn', href: '#/settings/project?projectDir=' + encodeURIComponent(projectDir || '') + '&chatId=' + encodeURIComponent(chatId || ''), 'aria-label': 'Project settings', title: 'Settings' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
          h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' })
        )
      )
    ),
    // The setup card (prompt-size switch + tool-declaration preview)
    // is mounted into this transcript at render time, only while the
    // chat is empty. See buildSetupCard + updateSetupVisibility.
    h('div', { ref: transcript, class: 'chat-view__transcript', 'aria-live': 'polite' }),
    h('button', {
      ref: jumpBtnRef,
      class: 'chat-view__jump',
      type: 'button',
      hidden: true,
      onClick: scrollTranscriptToBottom,
      'aria-label': 'Jump to latest messages'
    },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
        h('path', { d: 'M12 16.5 4.5 9l1.4-1.4 6.1 6.1 6.1-6.1L19.5 9 12 16.5Z', fill: 'currentColor' })
      ),
      h('span', { class: 'chat-view__jump-count' }, '')
    ),
    h('div', { class: 'chat-view__composer' },
      h('button', {
        class: 'chat-view__iconbtn chat-view__files-btn',
        type: 'button',
        onClick: () => setFileEditorOpen(true),
        'aria-label': 'Edit project files',
        title: 'Edit project files'
      },
        h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
          h('path', { d: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm12 1.5V7h3.5L15 7.5ZM6 8h6v1.5H6V8Zm0 3h9v1.5H6V11Zm0 3h7v1.5H6V14Z', fill: 'currentColor' })
        )
      ),
      h('button', {
        class: 'chat-view__iconbtn chat-view__image-btn',
        type: 'button',
        onClick: () => imageInputRef.current && imageInputRef.current.click(),
        'aria-label': 'Add image',
        title: 'Add image'
      },
        h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
          h('path', { d: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 13.5L9.5 13l3 3 2-2.5 4.5 4.5V6H5v11.5ZM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z', fill: 'currentColor' })
        )
      ),
      h('input', { ref: imageInputRef, class: 'chat-view__image-input', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, onChange: onImagePickerChange }),
      h('textarea', { ref: promptInput, class: 'input chat-view__textarea', id: 'chatComposer', rows: 1, placeholder: imageAttachments.length ? 'Add a caption or send' : 'Type a message', 'aria-label': 'Message', onKeydown: onComposerKey, onPaste: onComposerPaste, onInput: onComposerInput }),
      h('button', { ref: sendBtn, class: 'btn btn--primary chat-view__send', type: 'button', onClick: send, 'aria-label': 'Send' },
        h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
          h('path', { d: 'M3.4 20.6 21 12 3.4 3.4 3 10l13 2-13 2 .4 6.6Z', fill: 'currentColor' })
        )
      ),
      imageAttachments.length ? h('div', { class: 'chat-view__image-preview' },
        imageAttachments.map((a, idx) => h('button', { key: idx, class: 'chat-view__image-chip', type: 'button', onClick: () => removeImageAttachment(idx), title: 'Remove image' },
          h('img', { src: a.dataUrl, alt: a.name || 'attached image' }),
          h('span', null, '×')
        ))
      ) : null,
      h('span', { ref: statusEl, class: 'status chat-view__status', 'aria-live': 'polite' })
    ),
    // File editor popup. Rendered as a full-screen overlay over the
    // chat view; only mounted while open so the CodeMirror EditorView
    // is created once per session and torn down on close.
    fileEditorOpen[0] ? h(FileEditorView, { projectDir, onClose: () => setFileEditorOpen(false) }) : null
  );
}