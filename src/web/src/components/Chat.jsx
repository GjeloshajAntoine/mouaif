// mouaif web — ChatView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, parseSSEFrame, projectsReload } from '../api.js';
import { nav } from '../router.js';

export function ChatView(props) {
  const chatId = props.chatId;
  const projectDir = props.projectDir;
  const back = useRef(null);
  const chatName = useRef(null);
  const chatMeta = useRef(null);
  const traceToggle = useRef(null);
  const promptSizeSelect = useRef(null);
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

  async function load() {
    if (!projectDir || !chatId) return;
    const [rChat, rModels, rMsgs, rPrompts] = await Promise.all([
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/ai/models?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/chats/' + encodeURIComponent(chatId) + '/messages?projectDir=' + encodeURIComponent(projectDir)),
      fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir))
    ]);
    if (rChat.status !== 200) { statusEl.current.textContent = 'chat not found'; populateModelSelect(rModels.status === 200 ? (rModels.body.models || []) : []); return; }
    const c = rChat.body.chat;
    chatRef.current = c;
    messagesRef.current = rMsgs.status === 200 ? (rMsgs.body.messages || []) : [];
    modelsRef.current = rModels.status === 200 ? (rModels.body.models || []) : [];
    promptsRef.current = rPrompts.status === 200 ? (rPrompts.body.prompts || []) : [];

    if (chatName.current) chatName.current.textContent = c.title || chatId;
    if (chatMeta.current) chatMeta.current.textContent = (c.promptSize || 'average') + ' · ' + (c.trace ? 'trace on' : 'trace off');
    if (traceToggle.current) traceToggle.current.checked = !!c.trace;
    if (promptSizeSelect.current) promptSizeSelect.current.value = c.promptSize || 'average';

    if (modelSelect.current) populateModelSelect(modelsRef.current);
    if (promptSelect.current) populatePromptSelect(promptsRef.current, c.promptId || '');

    renderTranscript();
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

  function renderTranscript() {
    if (!transcript.current) return;
    transcript.current.innerHTML = '';
    if (!messagesRef.current.length) {
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
    transcript.current.scrollTop = transcript.current.scrollHeight;
  }

  function appendDeltaToLive(delta) {
    if (!transcript.current) return;
    const live = transcript.current.querySelector('[data-live="1"] .chat-msg__body');
    if (live) {
      live.textContent += delta;
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
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
    if (chatMeta.current && chatRef.current) chatMeta.current.textContent = (chatRef.current.promptSize || 'average') + ' · ' + (chatRef.current.trace ? 'trace on' : 'trace off');
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

  function onPromptSizeChange() {
    if (!promptSizeSelect.current) return;
    const v = promptSizeSelect.current.value;
    if (['very-small', 'average', 'extensive'].indexOf(v) < 0) return;
    updateChat({ promptSize: v });
  }

  function onPromptChange() {
    if (!promptSelect.current) return;
    const v = promptSelect.current.value;
    updateChat({ promptId: v || null });
    if (chatMeta.current && chatRef.current) chatMeta.current.textContent = (chatRef.current.promptSize || 'average') + ' · ' + (chatRef.current.trace ? 'trace on' : 'trace off');
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

  async function send() {
    if (!projectDir || !chatId) return;
    const modelId = modelSelect.current ? modelSelect.current.value : '';
    const content = (promptInput.current.value || '').trim();
    if (!content) { statusEl.current.textContent = 'type something'; return; }
    if (!modelId) { statusEl.current.textContent = 'pick a model'; return; }

    sendBtn.current.disabled = true;
    setChatStatus('streaming…', 'busy');
    promptInput.current.value = '';
    autoresize();

    const userMsg = { role: 'user', content, ts: new Date().toISOString() };
    messagesRef.current = messagesRef.current.concat([userMsg]);
    appendMessageToTranscript(userMsg, false);
    const liveMsg = { role: 'assistant', content: '', ts: new Date().toISOString() };
    appendMessageToTranscript(liveMsg, true);

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
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = parseSSEFrame(frame); if (!ev) continue;
        let data; try { data = JSON.parse(ev.data); } catch { continue; }
        if (ev.eventName === 'message' && typeof data.delta === 'string') { assembled += data.delta; appendDeltaToLive(data.delta); }
        else if (ev.eventName === 'done') { usage = data.usage || null; }
        else if (ev.eventName === 'error') { statusEl.current.textContent = 'error: ' + (data.code || '') + ' ' + (data.message || ''); }
      }
    }
    finalizeLiveMessage({ content: assembled });
    messagesRef.current = messagesRef.current.concat([{ role: 'assistant', content: assembled, ts: new Date().toISOString() }]);
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
    /* 44px floor matches the CSS min-height on .chat-view__textarea
       and the --tap touch target, so the single-line composer row
       lines up with the send button. 140px ceiling is the max
       multi-line height before the textarea scrolls. */
    const next = Math.min(140, Math.max(44, el.scrollHeight));
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
          h('label', { class: 'row row--inline chat-view__settings-row', for: 'chatPromptSize' },
            h('span', { class: 'label' }, 'Prompt size'),
            h('select', { ref: promptSizeSelect, class: 'input', id: 'chatPromptSize', onChange: onPromptSizeChange },
              h('option', { value: 'very-small' }, 'very-small'),
              h('option', { value: 'average' }, 'average'),
              h('option', { value: 'extensive' }, 'extensive')
            )
          ),
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