// Pure helpers for the webhook dock (WebhookDock.jsx): the link, the example
// call and what to say about a webhook and its calls
// (docs/features/webhook-turns.md).

// The longest prompt a webhook accepts (src/webhooks.js MAX_PROMPT_CHARS).
export const WEBHOOK_PROMPT_MAX = 4000;
export const WEBHOOK_METHODS = ['POST', 'GET', 'ANY'];
// The webhook's icon (a chain link: "a link that starts a turn"), shared by the
// dock and the chat list's row marker and filter.
export const WEBHOOK_ICON_PATH = 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71';
export const EVENT_STATUS_TEXT = { queued: 'waiting', started: 'started', failed: 'failed' };

// The full link: the server's public origin when it knows one, otherwise the
// address this browser reaches mouaif at.
export function webhookUrl(webhook, origin) {
  if (!webhook) return '';
  if (webhook.url) return webhook.url;
  const base = String(origin || '').replace(/\/+$/, '');
  return base + (webhook.path || '');
}

function shellQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

// A ready-to-paste curl command for the hook's method.
export function curlExample(webhook, url) {
  if (!webhook || !url) return '';
  if (webhook.method === 'GET') return 'curl ' + shellQuote(url + '?event=test');
  return 'curl -X POST -H ' + shellQuote('Content-Type: application/json') + ' -d ' + shellQuote('{"event":"test"}') + ' ' + shellQuote(url);
}

export function callsLabel(count) {
  return count === 1 ? '1 call' : (count || 0) + ' calls';
}

export function methodLabel(method) {
  return method === 'ANY' ? 'GET or POST' : method || 'POST';
}

export function webhookLine(webhook, nowMs = Date.now()) {
  if (!webhook) return '';
  const parts = [methodLabel(webhook.method), callsLabel(webhook.callCount)];
  if (webhook.lastCallAt) parts.push('last ' + ago(webhook.lastCallAt, nowMs));
  return parts.join(' · ');
}

export function ago(iso, nowMs = Date.now()) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 48 * 3600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

export function eventWhen(ms, locale) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// The sections of a call's data the panel shows, in order; empty ones left out.
export function eventSections(event) {
  if (!event) return [];
  const out = [];
  const query = event.query && typeof event.query === 'object' ? event.query : {};
  if (Object.keys(query).length) out.push({ label: 'Query', text: JSON.stringify(query, null, 2) });
  if (event.body) {
    out.push({ label: 'Body' + (event.contentType ? ' · ' + event.contentType : '') + (event.truncated ? ' · truncated' : ''), text: event.body });
  }
  const headers = event.headers && typeof event.headers === 'object' ? event.headers : {};
  if (Object.keys(headers).length) out.push({ label: 'Headers', text: Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\n') });
  return out;
}

// copyText(text) -> Promise<boolean>. The async clipboard needs a secure
// context; mouaif is often reached over plain http on a LAN, so fall back to
// a selected textarea and execCommand.
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return !!ok;
  } catch { return false; }
}
