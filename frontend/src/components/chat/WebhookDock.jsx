// mouaif web — webhook dock
//
// The chat's webhook (docs/features/webhook-turns.md): a bar in the bottom
// stack, above the composer, shown while the chat has a webhook. It shows the
// method and how many calls came in, copies the link in one tap, and opens a
// panel with the full link, a ready-to-paste curl, the method, pause / resume,
// the prompt, a new link, delete, and every call with the data it carried and
// a jump to the turn it started. State comes from GET /api/chats/:id/webhook,
// polled while the page is visible.
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { webhookUrl, curlExample, webhookLine, eventWhen, eventSections, copyText, methodLabel,
  WEBHOOK_METHODS, WEBHOOK_PROMPT_MAX, EVENT_STATUS_TEXT, WEBHOOK_ICON_PATH } from './webhookDock.js';

const POLL_OPEN_MS = 4000;
const POLL_ACTIVE_MS = 10000;
const POLL_NONE_MS = 15000;
const CONFIRM_MS = 4000;
const FLASH_MS = 1600;

export function WebhookIcon({ size = 16 }) {
  return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  h('path', { d: WEBHOOK_ICON_PATH }));
}

export function WebhookDock({ projectDir, chatId, onJumpToSeq }) {
  const [webhook, setWebhook] = useState(null);
  const [events, setEvents] = useState([]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [armed, setArmed] = useState('');
  const [draft, setDraft] = useState(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const base = '/api/chats/' + encodeURIComponent(chatId) + '/webhook';
  const apply = useCallback((body) => {
    setWebhook((body && body.webhook) || null);
    setEvents((body && Array.isArray(body.events)) ? body.events : []);
  }, []);

  useEffect(() => {
    setWebhook(null);
    setEvents([]);
    setOpen(false);
    setExpanded('');
    setDraft(null);
    setPromptOpen(false);
    setError('');
    setArmed('');
  }, [projectDir, chatId]);

  useEffect(() => {
    if (!projectDir || !chatId) return undefined;
    let stopped = false;
    let timer = null;
    let has = false;
    const load = async () => {
      try {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          const r = await fetchJson(base + '?projectDir=' + encodeURIComponent(projectDir));
          if (!stopped && r.status === 200) { apply(r.body); has = !!r.body.webhook; }
        }
      } catch { /* offline: keep the last state */ }
      if (!stopped) timer = setTimeout(load, open ? POLL_OPEN_MS : has ? POLL_ACTIVE_MS : POLL_NONE_MS);
    };
    load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [projectDir, chatId, open, refresh, base, apply]);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(''), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(''), FLASH_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!webhook) return null;

  const url = webhookUrl(webhook, typeof location !== 'undefined' ? location.origin : '');
  const paused = webhook.status === 'paused';

  const send = async (method, payload) => {
    if (busy) return false;
    setBusy(true);
    setError('');
    let ok = false;
    try {
      const r = method === 'DELETE'
        ? await fetchJson(base + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' })
        : await fetchJson(base, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, ...payload }) });
      if (r.status === 200) {
        ok = true;
        if (method === 'DELETE') { setWebhook(null); setEvents([]); setOpen(false); }
        else apply(r.body);
      } else setError((r.body && r.body.error) || 'Could not update the webhook');
    } catch { setError('Could not reach mouaif'); }
    setBusy(false);
    setArmed('');
    return ok;
  };
  const copy = async (what, text) => { setCopied((await copyText(text)) ? what : 'failed'); };
  const twoTap = (what, action) => () => { if (armed !== what) { setArmed(what); return; } action(); };
  const savePrompt = async () => {
    const text = (draft || '').trim();
    if (!text) return;
    if (text === webhook.prompt) { setDraft(null); return; }
    if (await send('PUT', { prompt: text })) setDraft(null);
  };
  const jump = (seq) => { setOpen(false); if (onJumpToSeq) onJumpToSeq(seq); };

  const linkSection = h('div', { class: 'webhook-panel__section' },
    h('div', { class: 'webhook-panel__label' }, 'Link · accepts ' + methodLabel(webhook.method)),
    h('code', { class: 'webhook-panel__url', 'data-testid': 'webhook-url' }, url),
    h('div', { class: 'webhook-panel__row' },
      h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', onClick: () => copy('link', url) }, copied === 'link' ? 'Copied' : 'Copy link'),
      h('button', { class: 'run-dock__btn', type: 'button', onClick: () => copy('curl', curlExample(webhook, url)) }, copied === 'curl' ? 'Copied' : 'Copy curl')),
    copied === 'failed' ? h('div', { class: 'webhook-panel__hint' }, 'Could not copy; select the link above instead.') : null,
    h('div', { class: 'webhook-panel__label' }, 'Method'),
    h('div', { class: 'webhook-panel__seg', role: 'radiogroup', 'aria-label': 'Accepted method' },
      WEBHOOK_METHODS.map((m) => h('button', { key: m, type: 'button', role: 'radio', 'aria-checked': webhook.method === m ? 'true' : 'false',
        class: 'webhook-panel__seg-btn' + (webhook.method === m ? ' is-on' : ''), disabled: busy,
        onClick: () => { if (webhook.method !== m) send('PUT', { method: m }); } }, m === 'ANY' ? 'Both' : m))),
    h('div', { class: 'webhook-panel__row' },
      h('button', { class: 'run-dock__btn' + (paused ? ' run-dock__btn--primary' : ''), type: 'button', disabled: busy,
        onClick: () => send('PUT', { status: paused ? 'active' : 'paused' }) }, paused ? 'Resume' : 'Pause'),
      h('button', { class: 'run-dock__btn', type: 'button', 'aria-expanded': promptOpen ? 'true' : 'false',
        onClick: () => { setPromptOpen((v) => !v); setDraft(null); } }, 'Prompt'),
      h('button', { class: 'run-dock__btn' + (armed === 'rotate' ? ' run-dock__btn--danger is-armed' : ''), type: 'button', disabled: busy,
        onClick: twoTap('rotate', () => send('PUT', { rotate: true })),
        'aria-label': armed === 'rotate' ? 'Tap again: the current link stops working' : 'Make a new link' }, armed === 'rotate' ? 'Tap: old link dies' : 'New link'),
      h('button', { class: 'run-dock__btn run-dock__btn--danger' + (armed === 'delete' ? ' is-armed' : ''), type: 'button', disabled: busy,
        onClick: twoTap('delete', () => send('DELETE')),
        'aria-label': armed === 'delete' ? 'Tap again to delete the webhook' : 'Delete the webhook' }, armed === 'delete' ? 'Tap to delete' : 'Delete')),
    promptOpen ? (draft === null
      ? h(Fragment, null,
        h('pre', { class: 'run-prompt__text' }, webhook.prompt),
        h('div', { class: 'webhook-panel__hint' }, 'Sent at the start of every call’s turn, with the call’s data below it.'),
        h('div', { class: 'webhook-panel__row' }, h('button', { class: 'run-dock__btn', type: 'button', onClick: () => setDraft(webhook.prompt) }, 'Edit prompt')))
      : h(Fragment, null,
        h('textarea', { class: 'run-prompt__input', value: draft, rows: 6, maxLength: WEBHOOK_PROMPT_MAX, disabled: busy,
          'aria-label': 'Webhook prompt', onInput: (e) => setDraft(e.target.value) }),
        h('div', { class: 'webhook-panel__hint' }, draft.length + ' / ' + WEBHOOK_PROMPT_MAX + ' · applies from the next call'),
        h('div', { class: 'webhook-panel__row' },
          h('button', { class: 'run-dock__btn', type: 'button', disabled: busy, onClick: () => setDraft(null) }, 'Cancel'),
          h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', disabled: busy || !draft.trim(), onClick: savePrompt }, 'Save')))) : null,
    error ? h('div', { class: 'webhook-panel__hint webhook-panel__hint--error', role: 'alert' }, error) : null);

  const callsSection = h('div', { class: 'webhook-panel__section' },
    h('div', { class: 'webhook-panel__label' }, 'Calls'),
    events.length ? h('ul', { class: 'webhook-calls' }, events.map((e) => {
      const isOpen = expanded === e.id;
      const sections = isOpen ? eventSections(e) : [];
      return h('li', { key: e.id, class: 'webhook-call', 'data-status': e.status },
        h('button', { class: 'webhook-call__head', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false',
          onClick: () => setExpanded(isOpen ? '' : e.id) },
        h('strong', null, e.run ? 'Run ' + e.run : 'Call'),
        h('span', { class: 'webhook-call__method' }, e.method),
        h('span', { class: 'webhook-call__when' }, eventWhen(e.receivedAt)),
        h('span', { class: 'webhook-call__status' }, EVENT_STATUS_TEXT[e.status] || e.status)),
        isOpen ? h('div', { class: 'webhook-call__body' },
          e.error ? h('div', { class: 'webhook-panel__hint webhook-panel__hint--error' }, e.error) : null,
          sections.length ? sections.map((s) => h(Fragment, { key: s.label },
            h('div', { class: 'webhook-panel__label' }, s.label),
            h('pre', { class: 'webhook-call__data' }, s.text)))
            : h('div', { class: 'webhook-panel__hint' }, 'The call carried no data.'),
          h('div', { class: 'webhook-panel__row' },
            e.seq != null ? h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', onClick: () => jump(e.seq) }, 'Open turn') : null,
            h('button', { class: 'run-dock__btn', type: 'button', onClick: () => copy('data-' + e.id, sections.map((s) => s.label + '\n' + s.text).join('\n\n')) },
              copied === 'data-' + e.id ? 'Copied' : 'Copy data'))) : null);
    })) : h('div', { class: 'webhook-panel__hint' }, 'No calls yet. Each call to the link starts a turn here.'));

  const panel = open ? h('div', { class: 'webhook-panel', role: 'group', 'aria-label': 'Webhook' }, linkSection, callsSection) : null;

  return h(Fragment, null, panel,
    h('div', { class: 'run-dock webhook-dock' + (paused ? ' webhook-dock--paused' : ''), role: 'group', 'aria-label': 'Webhook' },
      h('span', { class: 'webhook-dock__icon' }, h(WebhookIcon, { size: 16 })),
      h('div', { class: 'run-dock__text' },
        h('div', { class: 'run-dock__goal' }, h('strong', null, paused ? 'Webhook paused' : 'Webhook'), ' · ', webhookLine(webhook)),
        h('div', { class: 'run-dock__meta webhook-dock__url', title: url }, url)),
      h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', onClick: () => copy('link', url),
        'aria-label': 'Copy the webhook link' }, copied === 'link' ? 'Copied' : 'Copy'),
      h('button', { class: 'run-dock__btn', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        onClick: () => { setOpen((v) => !v); setRefresh((n) => n + 1); }, 'aria-label': 'Show the webhook link and its calls' }, open ? 'Close' : 'Calls')));
}
