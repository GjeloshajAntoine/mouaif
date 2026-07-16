// mouaif web — ChatView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, parseSSEFrame, projectsReload } from '../api.js';
import { nav } from '../router.js';
import { formatCost, formatTokPerSecond, formatTokens, createCounter } from '../usage.js';

export function ChatView(props) {
  const chatId = props.chatId;
  const projectDir = props.projectDir;
  const back = useRef(null);
  const chatName = useRef(null);
  const chatMeta = useRef(null);
  const traceToggle = useRef(null);
  // The creation-time setup card lives in the TRANSCRIPT (above the
  // system message) instead of the head, so the prompt-size choice is
  // part of the message area and not a permanent fixture of the top
  // bar. The card is the only child of the transcript while the chat
  // is empty; it is removed by updateSetupVisibility when the first
  // message is sent. The ref tracks the element so setPromptSize
  // updates the active-button highlight in place without rebuilding.
  const setupCardRef = useRef(null);
  const promptSelect = useRef(null);
  const transcript = useRef(null);
  const modelSelect = useRef(null);
  const promptInput = useRef(null);
  const sendBtn = useRef(null);
  const statusEl = useRef(null);

  function setChatStatus(text, state) {
    if (!statusEl.current) return;
    statusEl.current.textContent = text;
    if (state) statusEl.current.dataset.state = state;
    else delete statusEl.current.dataset.state;
  }

  const chatRef = useRef(null);
  const messagesRef = useRef([]);
  const modelsRef = useRef([]);
  const promptsRef = useRef([]);
  // The prompt-size profile list is fetched from /api/prompt-profiles
  // once per chat open. The picker's <option> list is generated from
  // this array; the description under the picker reflects the active
  // option's `description` and updates on every change. The array is
  // also the source for the meta line (the chat record's `promptSize`
  // is the raw id; we show the friendlier `label` in the meta).
  const profilesRef = useRef([]);
  const profileByIdRef = useRef({});
  // The effective system context (resolved prompt-size profile + custom
  // prompt) as it will be sent upstream. Fetched from
  // /api/chats/:id/system-prompt and rendered as the first collapsible
  // message in the transcript, so the user sees what the model is told
  // without the prompt-size picker being a permanent fixture.
  const systemPromptRef = useRef(null);

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

  async function load() {
    if (!projectDir || !chatId) return;
    const [rChat, rModels, rMsgs, rPrompts, rProfiles, rSys] = await Promise.all([
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/prompt-profiles'),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/system-prompt?projectDir=' + encodeURIComponent(projectDir))
    ]);
    if (rChat.status !== 200) { statusEl.current.textContent = 'chat not found'; populateModelSelect(rModels.status === 200 ? (rModels.body.models || []) : []); return; }
    const c = rChat.body.chat;
    chatRef.current = c;
    messagesRef.current = rMsgs.status === 200 ? (rMsgs.body.messages || []) : [];
    modelsRef.current = rModels.status === 200 ? (rModels.body.models || []) : [];
    promptsRef.current = rPrompts.status === 200 ? (rPrompts.body.prompts || []) : [];
    profilesRef.current = rProfiles.status === 200 ? (rProfiles.body.profiles || []) : [];
    systemPromptRef.current = rSys.status === 200 ? rSys.body : null;
    profileByIdRef.current = {};
    for (const p of profilesRef.current) profileByIdRef.current[p.id] = p;

    if (chatName.current) chatName.current.textContent = c.title || chatId;
    updateMetaLine();
    if (traceToggle.current) traceToggle.current.checked = !!c.trace;

    if (modelSelect.current) populateModelSelect(modelsRef.current);
    if (promptSelect.current) populatePromptSelect(promptsRef.current, c.promptId || '');

    renderTranscript();
    updateSetupVisibility();
    // Reflect the active profile in the setup card after it has
    // been built (renderTranscript + updateSetupVisibility run first
    // and decide whether the card is on screen at all).
    updateSwitch(activeProfileId());
  }

  function populateModelSelect(list) {
    if (!modelSelect.current) return;
    modelSelect.current.innerHTML = '';
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id + (m.label ? ' — ' + m.label : '');
      modelSelect.current.appendChild(opt);
    }
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no models)';
      opt.title = 'Define models in the project settings to start a chat.';
      modelSelect.current.appendChild(opt);
    }
  }

  function populatePromptSelect(list, currentId) {
    if (!promptSelect.current) return;
    promptSelect.current.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '(none)';
    promptSelect.current.appendChild(blank);
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = (p.title || p.id) + ' (' + p.role + ')';
      promptSelect.current.appendChild(opt);
    }
    promptSelect.current.value = (currentId && list.some(p => p.id === currentId)) ? currentId : '';
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

  // Build (or rebuild) the creation-time setup card. The card lives in
  // the transcript, above the system message, and contains the
  // prompt-size switch + the tool-declaration preview. It is the
  // first thing the user sees on a new chat; once any message exists
  // it is removed entirely (see updateSetupVisibility).
  function buildSetupCard() {
    const card = document.createElement('div');
    card.className = 'chat-view__setup';
    card.dataset.role = 'assistant';
    const head = document.createElement('div');
    head.className = 'chat-view__setup-head';
    const role = document.createElement('div');
    role.className = 'chat-msg__role';
    role.textContent = 'setup';
    const title = document.createElement('div');
    title.className = 'chat-view__setup-title';
    title.textContent = 'Pick a prompt size for this chat';
    const sub = document.createElement('p');
    sub.className = 'chat-view__setup-sub';
    sub.textContent = 'This decides how much the model is told about the tools it can call. You can only change it before sending the first message; after that, the system prompt is fixed for the life of the chat.';
    head.appendChild(role);
    head.appendChild(title);
    head.appendChild(sub);
    card.appendChild(head);
    const sw = document.createElement('div');
    sw.className = 'chat-view__switch';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', 'Prompt size');
    for (const opt of [
      { id: 'very-small', label: 'S', title: 'Very small — tool names only, no parameter schemas, smallest prompt' },
      { id: 'average', label: 'M', title: 'Average — full tools, recommended' },
      { id: 'extensive', label: 'L', title: 'Extensive — full tools + best-practice guidance' }
    ]) {
      const b = document.createElement('button');
      b.className = 'chat-view__switch-btn';
      b.type = 'button';
      b.dataset.size = opt.id;
      b.setAttribute('aria-pressed', 'false');
      b.title = opt.title;
      b.textContent = opt.label;
      b.addEventListener('click', () => setPromptSize(opt.id));
      sw.appendChild(b);
    }
    card.appendChild(sw);
    const prev = document.createElement('div');
    prev.className = 'chat-view__toolprev';
    card.appendChild(prev);
    return card;
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
      text.textContent = 'Pick a prompt size above, then type a message below. The model streams its reply in real time; everything you send is saved to this chat\'s transcript on disk.';
      empty.appendChild(icon); empty.appendChild(title); empty.appendChild(text);
      transcript.current.appendChild(empty);
      return;
    }
    for (const m of messagesRef.current) appendMessageToTranscript(m, false);
    transcript.current.scrollTop = transcript.current.scrollHeight;
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
    role.textContent = m.role;
    const body = document.createElement('div');
    body.className = 'chat-msg__body';
    body.textContent = m.content || '';
    const ts = document.createElement('div');
    ts.className = 'chat-msg__ts';
    ts.textContent = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
    row.appendChild(role); row.appendChild(body); row.appendChild(ts);
    transcript.current.appendChild(row);
    if (m.role === 'assistant' && isLive) row._body = body;
    // Per-turn meta line (decision §14). Lives directly under the
    // assistant bubble and shows the model id, token counts, cost,
    // and live token rate. For non-assistant messages or for
    // assistant messages without a usage block, the line is hidden
    // — the typical case is a fresh chat before any AI turn, or a
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
    transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  // Render the per-turn meta line. Pure DOM, no framework — the chat
  // view intentionally avoids Preact here so the SSE hot path stays
  // as cheap as a textContent assignment. The line is a flat row of
  // "•"-separated tokens sized for a 360 px viewport.
  function renderUsageMeta(el, info) {
    el.innerHTML = '';
    el.hidden = false;
    const modelId = info.modelId || '';
    const usage = info.usage || {};
    const cost = info.cost || null;
    const tokens = [];
    if (modelId) tokens.push(modelId);
    if (typeof usage.promptTokens === 'number') {
      tokens.push(formatTokens(usage.promptTokens) + ' in');
    }
    if (typeof usage.completionTokens === 'number') {
      tokens.push(formatTokens(usage.completionTokens) + ' out');
    }
    if (cost && cost.known) {
      tokens.push(formatCost(cost.total));
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
        sep.textContent = '•';
        el.appendChild(sep);
      }
      const span = document.createElement('span');
      span.textContent = tokens[i];
      el.appendChild(span);
    }
  }

  function appendDeltaToLive(delta) {
    if (!transcript.current) return;
    const live = transcript.current.querySelector('[data-live="1"] .chat-msg__body');
    if (live) {
      live.textContent += delta;
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }

  // Render a tool_call event as a compact card above the live message
  // (or appended if there is no live row). The card shows the tool
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
    const role = document.createElement('div');
    role.className = 'tool-card__role';
    role.textContent = 'tool call';
    const name = document.createElement('div');
    name.className = 'tool-card__name';
    name.textContent = toolCall.name || 'tool';
    const args = document.createElement('pre');
    args.className = 'tool-card__args';
    args.textContent = formatToolArgs(toolCall.args);
    const pill = document.createElement('span');
    pill.className = 'tool-card__pill tool-card__pill--busy';
    pill.textContent = 'running…';
    card.appendChild(role); card.appendChild(name); card.appendChild(args); card.appendChild(pill);
    transcript.current.appendChild(card);
    transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  // Render a tool_result event. If a matching tool_call card is on
  // screen, update it; otherwise append a fresh card so the user can
  // see the result regardless of order. The card collapses the result
  // body on tap; long outputs are truncated to the first ~12 lines.
  function appendToolResultCard(toolResult) {
    if (!transcript.current) return;
    const id = toolResult.id;
    let card = id ? transcript.current.querySelector('[data-tool-id="' + cssEscape(id) + '"]') : null;
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool-card tool-card--result';
      card.dataset.toolId = id || ('call_' + Math.random().toString(36).slice(2, 10));
      const role = document.createElement('div');
      role.className = 'tool-card__role';
      role.textContent = 'tool result';
      const name = document.createElement('div');
      name.className = 'tool-card__name';
      name.textContent = toolResult.name || 'tool';
      const body = document.createElement('pre');
      body.className = 'tool-card__body';
      card.appendChild(role); card.appendChild(name); card.appendChild(body);
      card.addEventListener('click', () => card.classList.toggle('is-expanded'));
      transcript.current.appendChild(card);
    } else {
      // The call card now becomes a result card (clickable to expand).
      card.classList.add('tool-card--result');
      card.classList.remove('tool-card--call');
      const existingPill = card.querySelector('.tool-card__pill');
      if (existingPill) existingPill.remove();
      const role = card.querySelector('.tool-card__role');
      if (role) role.textContent = 'tool result';
      const args = card.querySelector('.tool-card__args');
      if (args) {
        // Repurpose the args pre as the body; rename the class so the
        // collapse-on-tap CSS hits it. A new pre is cleaner, but
        // reusing keeps the same DOM stable.
        args.classList.remove('tool-card__args');
        args.classList.add('tool-card__body');
        card.addEventListener('click', () => card.classList.toggle('is-expanded'));
      } else {
        const body = document.createElement('pre');
        body.className = 'tool-card__body';
        card.appendChild(body);
        card.addEventListener('click', () => card.classList.toggle('is-expanded'));
      }
    }
    const body = card.querySelector('.tool-card__body');
    if (body) body.textContent = formatToolResult(toolResult);
    const pill = document.createElement('span');
    pill.className = 'tool-card__pill ' + (toolResult.ok ? 'tool-card__pill--ok' : 'tool-card__pill--err');
    pill.textContent = toolResult.ok ? 'ok' : 'error';
    card.appendChild(pill);
    transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  function formatToolArgs(args) {
    if (args == null) return '';
    if (typeof args === 'string') return args;
    try { return JSON.stringify(args, null, 2); }
    catch { return String(args); }
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

  // CSS.escape polyfill for older mobile browsers; we only need to
  // escape the chars that can appear in a tool call id (alnum, _, -).
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c);
  }

  function finalizeLiveMessage(message) {
    if (!transcript.current) return;
    const liveRow = transcript.current.querySelector('[data-live="1"]');
    if (liveRow) {
      delete liveRow.dataset.live;
      if (liveRow._body && message && typeof message.content === 'string') liveRow._body.textContent = message.content;
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

  function onTraceChange() {
    if (!traceToggle.current) return;
    updateChat({ trace: !!traceToggle.current.checked });
  }

  // Shared setter for the in-transcript setup card. The prompt size
  // is chosen once, while the chat is still empty; the control is not
  // a permanent fixture (see updateSetupVisibility below).
  function setPromptSize(v) {
    if (['very-small', 'average', 'extensive'].indexOf(v) < 0) return;
    updateSwitch(v);
    updateChat({ promptSize: v }).then(() => { refreshSystemPrompt(); loadToolPreview(); });
  }

  // The switch is a segmented control (very-small | average |
  // extensive). Reflect the active profile by toggling aria-pressed +
  // an is-active class on its buttons. The switch lives inside
  // setupCardRef.current while the chat is empty; if the card has
  // already been removed this is a no-op.
  function updateSwitch(id) {
    const host = setupCardRef.current;
    if (!host) return;
    const btns = host.querySelectorAll('.chat-view__switch-btn[data-size]');
    for (const b of btns) {
      const on = b.dataset.size === id;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  // The setup card is a CREATION-TIME control: it is only mounted
  // while the chat has no messages yet, so the user picks the prompt
  // budget up front. As soon as the first message exists the card is
  // removed and never comes back — the prompt size is fixed for the
  // life of the chat. Removing the card (instead of hiding it) keeps
  // the transcript clean: no empty card shape behind later messages.
  function updateSetupVisibility() {
    const empty = !messagesRef.current || messagesRef.current.length === 0;
    const host = setupCardRef.current;
    if (empty) {
      if (!host && transcript.current) {
        // Re-entering a chat that was loaded with messages but then
        // deleted (extremely rare; just safety): nothing to do, the
        // setup card is for fresh chats only.
        return;
      }
      if (host) loadToolPreview();
      return;
    }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    setupCardRef.current = null;
  }

  // Fetch the tool-declaration state for the active profile and render
  // it inside the setup card. The preview is the concrete effect of
  // the S/M/L choice: which tools ride, and whether their parameter
  // schemas are sent (average/extensive) or stripped to name +
  // one-line description (very-small).
  async function loadToolPreview() {
    const host = setupCardRef.current && setupCardRef.current.querySelector('.chat-view__toolprev');
    if (!host || !projectDir || !chatId) return;
    let r;
    try {
      r = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/tool-preview?projectDir=' + encodeURIComponent(projectDir));
    } catch { return; }
    if (r.status !== 200 || !r.body) return;
    const b = r.body;
    host.innerHTML = '';
    // Summary line: how many tools, and the schema policy.
    const summary = document.createElement('div');
    summary.className = 'chat-view__toolprev-summary';
    const profile = profileByIdRef.current && profileByIdRef.current[b.profile];
    const label = profile && profile.label ? profile.label : b.profile;
    if (!b.count) {
      summary.textContent = label + ': no tools advertised' + (b.shellEnabled ? '' : ' (shell off)');
    } else {
      summary.textContent = label + ': ' + b.count + (b.count === 1 ? ' tool' : ' tools') +
        (b.reduced ? ' — names + short descriptions, no parameter schemas' : ' — full specs with parameter schemas');
    }
    host.appendChild(summary);
    // One row per tool: name + the description actually sent + a chip
    // showing whether the parameter schema rides.
    if (b.count) {
      const list = document.createElement('ul');
      list.className = 'chat-view__toolprev-list';
      for (const t of b.tools) {
        const li = document.createElement('li');
        li.className = 'chat-view__toolprev-row';
        const name = document.createElement('span');
        name.className = 'chat-view__toolprev-name';
        name.textContent = t.name;
        const chip = document.createElement('span');
        chip.className = 'chat-view__toolprev-chip' + (t.hasSchema ? ' is-full' : ' is-reduced');
        chip.textContent = t.hasSchema ? (t.params.length + ' param' + (t.params.length === 1 ? '' : 's')) : 'no schema';
        li.appendChild(name);
        li.appendChild(chip);
        if (t.description) {
          const desc = document.createElement('span');
          desc.className = 'chat-view__toolprev-desc';
          desc.textContent = t.description;
          li.appendChild(desc);
        }
        list.appendChild(li);
      }
      host.appendChild(list);
    }
  }

  function onPromptChange() {
    if (!promptSelect.current) return;
    const v = promptSelect.current.value;
    updateChat({ promptId: v || null }).then(() => refreshSystemPrompt());
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
    setChatStatus('running shell…', 'busy');
    sendBtn.current.disabled = true;
    let r;
    try {
      r = await fetchJson('/api/tools/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, cmd })
      });
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

  async function send() {
    if (!projectDir || !chatId) return;
    const modelId = modelSelect.current ? modelSelect.current.value : '';
    const content = (promptInput.current.value || '').trim();
    if (!content) { statusEl.current.textContent = 'type something'; return; }
    // /shell <cmd> — direct tool invocation, no model.
    if (content.startsWith('/shell ')) {
      const cmd = content.slice('/shell '.length).trim();
      if (cmd) return runShellCommand(cmd);
    }
    if (!modelId) { statusEl.current.textContent = 'pick a model'; return; }

    sendBtn.current.disabled = true;
    setChatStatus('streaming…', 'busy');
    promptInput.current.value = '';
    autoresize();

    const userMsg = { role: 'user', content, ts: new Date().toISOString() };
    messagesRef.current = messagesRef.current.concat([userMsg]);
    appendMessageToTranscript(userMsg, false);
    // The first message ends the creation phase: hide the prompt-size
    // switch + tool preview for good (the prompt size is now fixed).
    updateSetupVisibility();
    const liveMsg = { role: 'assistant', content: '', ts: new Date().toISOString(), modelId };
    appendMessageToTranscript(liveMsg, true);

    // Live per-turn counter. The chat UI runs this on every delta;
    // the server's authoritative completionTokens (sent on `done`)
    // replaces the heuristic on the final tick. The counter is
    // scoped to a single turn — reset() is called after `done` so
    // the next user message starts from 0.
    const counter = createCounter();

    let resp;
    try {
      resp = await fetch('/api/chats/' + encodeURIComponent(chatId) + '/messages/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, modelId, content })
      });
    } catch (err) {
      setChatStatus('network error', 'error');
      finalizeLiveMessage({ content: '[network error]' });
      if (sendBtn.current) sendBtn.current.disabled = false;
      return;
    }
    if (!resp.ok) {
      const text = await resp.text();
      setChatStatus('HTTP ' + resp.status, 'error');
      finalizeLiveMessage({ content: '[error: HTTP ' + resp.status + ']' });
      sendBtn.current.disabled = false;
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', assembled = '';
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
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = parseSSEFrame(frame); if (!ev) continue;
        let data; try { data = JSON.parse(ev.data); } catch { continue; }
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
        else if (ev.eventName === 'done') {
          usage = data.usage || null;
          // Server-side cost enrichment (decision §14). The server
          // already walked the pricing resolution order; the client
          // just renders.
          cost = data.cost || null;
          streamingMs = typeof data.streamingMs === 'number' ? data.streamingMs : streamingMs;
        }
        else if (ev.eventName === 'tool_call') { appendToolCallCard(data); }
        else if (ev.eventName === 'tool_result') { appendToolResultCard(data); }
        else if (ev.eventName === 'error') { statusEl.current.textContent = 'error: ' + (data.code || '') + ' ' + (data.message || ''); }
      }
    }
    finalizeLiveMessage({ content: assembled });
    // Final meta line: the live counter has the authoritative
    // completionTokens (from `usage.completionTokens`); the cost is
    // already on the `done` event. The stored message keeps both so
    // a chat that is reopened later shows the same numbers (decision
    // §14 — usage is persisted on the assistant message).
    const finalRate = counter.rate(usage && usage.completionTokens);
    const persisted = {
      role: 'assistant',
      content: assembled,
      ts: new Date().toISOString(),
      modelId,
      usage: usage || undefined,
      cost: cost || undefined,
      streamingMs: streamingMs || undefined,
      liveRate: finalRate
    };
    messagesRef.current = messagesRef.current.concat([persisted]);
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
    if (statusEl.current.textContent === 'streaming…') {
      setChatStatus(usage ? ('done — ' + usage.promptTokens + ' in, ' + usage.completionTokens + ' out') : 'done', 'success');
    }
    sendBtn.current.disabled = false;
  }

  const settingsPopRef = useRef(null);
  const settingsBtnRef = useRef(null);

  function autoresize() {
    const el = promptInput.current;
    if (!el) return;
    el.style.height = 'auto';
    /* 32px floor matches the CSS min-height on .chat-view__textarea
       and the --tap touch target, so the single-line composer row
       lines up with the send button. 120px ceiling is the max
       multi-line height before the textarea scrolls. */
    const next = Math.min(120, Math.max(32, el.scrollHeight));
    el.style.height = next + 'px';
  }

  function toggleSettings() {
    const pop = settingsPopRef.current;
    const btn = settingsBtnRef.current;
    if (!pop || !btn) return;
    const open = pop.hidden;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }

  useEffect(() => {
    function close() { if (settingsPopRef.current && !settingsPopRef.current.hidden) { settingsPopRef.current.hidden = true; if (settingsBtnRef.current) settingsBtnRef.current.setAttribute('aria-expanded', 'false'); } }
    function onDocClick(e) { const pop = settingsPopRef.current; const btn = settingsBtnRef.current; if (!pop || pop.hidden) return; if (pop.contains(e.target) || (btn && btn.contains(e.target))) return; close(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    if (promptInput.current) { promptInput.current.addEventListener('input', autoresize); autoresize(); }
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      if (promptInput.current) promptInput.current.removeEventListener('input', autoresize);
    };
  }, []);

  function onComposerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  useEffect(() => { load().catch((err) => { if (statusEl.current) statusEl.current.textContent = 'load failed'; }); }, [chatId, projectDir]);

  return h('section', { class: 'chat-view' },
    h('div', { class: 'chat-view__head' },
      h('button', { ref: back, class: 'chat-view__back', type: 'button', onClick: () => nav('projects'), 'aria-label': 'Back to projects' }, '←'),
      h('div', { class: 'chat-view__title-stack' },
        h('div', { ref: chatName, class: 'chat-view__name' }, '…'),
        h('div', { ref: chatMeta, class: 'chat-view__meta' }, '')
      ),
      h('select', { ref: modelSelect, class: 'input chat-view__model', id: 'chatModel', 'aria-label': 'Model' }),
      h('div', { class: 'chat-view__settings-wrap' },
        h('button', { ref: settingsBtnRef, class: 'chat-view__iconbtn', type: 'button', onClick: toggleSettings, 'aria-label': 'Chat settings', 'aria-expanded': 'false', title: 'Settings' },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
            h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' })
          )
        ),
        h('div', { ref: settingsPopRef, class: 'chat-view__settings-pop', hidden: true, role: 'dialog', 'aria-label': 'Chat settings' },
          h('label', { class: 'row row--inline chat-view__settings-row', for: 'chatPrompt' },
            h('span', { class: 'label' }, 'Prompt'),
            h('select', { ref: promptSelect, class: 'input', id: 'chatPrompt', onChange: onPromptChange })
          ),
          h('label', { class: 'row row--inline chat-view__settings-row', for: 'chatTrace' },
            h('input', { ref: traceToggle, class: 'checkbox', id: 'chatTrace', type: 'checkbox', onChange: onTraceChange }),
            h('span', { class: 'label' }, 'Trace to file')
          )
        )
      ),
      h('button', { class: 'chat-view__iconbtn', type: 'button', onClick: renameChat, 'aria-label': 'Rename chat', title: 'Rename' }, '✎'),
      h('button', { class: 'chat-view__iconbtn chat-view__iconbtn--danger', type: 'button', onClick: deleteThisChat, 'aria-label': 'Delete chat', title: 'Delete' }, '×')
    ),
    // The setup card (prompt-size switch + tool-declaration preview)
    // is mounted into this transcript at render time, only while the
    // chat is empty. See buildSetupCard + updateSetupVisibility.
    h('div', { ref: transcript, class: 'chat-view__transcript', 'aria-live': 'polite' }),
    h('div', { class: 'chat-view__composer' },
      h('textarea', { ref: promptInput, class: 'input chat-view__textarea', id: 'chatPrompt', rows: 1, placeholder: 'Type a message', onKeydown: onComposerKey }),
      h('button', { ref: sendBtn, class: 'btn btn--primary chat-view__send', type: 'button', onClick: send, 'aria-label': 'Send' },
        h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
          h('path', { d: 'M3.4 20.6 21 12 3.4 3.4 3 10l13 2-13 2 .4 6.6Z', fill: 'currentColor' })
        )
      ),
      h('span', { ref: statusEl, class: 'status chat-view__status', 'aria-live': 'polite' })
    )
  );
}