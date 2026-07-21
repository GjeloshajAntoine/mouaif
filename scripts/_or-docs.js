'use strict';
// Fetch OpenRouter docs pages and grep for cost/usage/streaming hints.
const urls = [
  'https://openrouter.ai/docs/use-cases/usage-accounting',
  'https://openrouter.ai/docs/api/reference/get-completion',
  'https://openrouter.ai/docs/api/reference/overview',
  'https://openrouter.ai/docs/use-cases/streaming',
  'https://openrouter.ai/docs/api-reference/streaming'
];

function strip(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ');
}

(async () => {
  for (const u of urls) {
    let text = '';
    try {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
      text = await r.text();
      console.log('\n===== ' + u + '  [HTTP ' + r.status + ', ' + text.length + ' bytes] =====');
    } catch (e) {
      console.log('\n===== ' + u + '  [FETCH FAILED: ' + (e && e.message) + '] =====');
      continue;
    }
    const clean = strip(text);
    const lines = clean.split(/\n+/);
    for (const ln of lines) {
      if (/cost|usage|credit|token accounting|stream/i.test(ln)) {
        const t = ln.trim();
        if (t.length > 2) console.log(t.slice(0, 220));
      }
    }
  }
})();
