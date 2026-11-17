'use strict';
// mouaif — project preview links
//
// Every successful `webpreview` (the agent's call, or a capture from the
// project's Web preview page) records its URL in the project setting
// `previewLinks`, newest first. The Web preview page in project settings
// lists them. Only the URL and a little metadata are kept, never the
// screenshot bytes.
//
//   previewLinks: [{ url, title, mode, viewport, addedAt }]

const KEY = 'previewLinks';
const MAX_LINKS = 50;

function normalizeLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const e of raw) {
    if (!e || typeof e.url !== 'string' || !e.url || seen.has(e.url)) continue;
    seen.add(e.url);
    out.push({
      url: e.url,
      title: typeof e.title === 'string' ? e.title.slice(0, 200) : '',
      mode: e.mode === 'live' ? 'live' : 'screenshot',
      viewport: typeof e.viewport === 'string' ? e.viewport : 'phone',
      addedAt: typeof e.addedAt === 'string' ? e.addedAt : ''
    });
  }
  return out.slice(0, MAX_LINKS);
}

// withLink(list, entry) -> new list with `entry` first and any older copy of
// the same URL removed. Pure, for tests.
function withLink(list, entry) {
  const rest = normalizeLinks(list).filter((e) => e.url !== entry.url);
  return normalizeLinks([entry, ...rest]);
}

// recordFromResult(projectDir, out) — best effort; a failed write never
// fails the tool call.
function recordFromResult(projectDir, out) {
  try {
    const r = out && out.ok && out.result;
    if (!projectDir || !r || typeof r.url !== 'string') return false;
    const content = require('./content/service.js');
    const settings = require('./settings.js');
    const current = (settings.getProject(projectDir) || {})[KEY];
    const entry = {
      url: r.url,
      title: r.title || '',
      mode: r.mode === 'live' ? 'live' : 'screenshot',  // a saved-only link reopens as a screenshot
      viewport: (r.viewport && r.viewport.id) || 'phone',
      addedAt: r.capturedAt || new Date().toISOString()
    };
    content.applyPatch({ scope: 'project', projectDir, patch: { [KEY]: withLink(current, entry) }, actor: 'ui' });
    return true;
  } catch {
    return false;
  }
}

module.exports = { KEY, MAX_LINKS, normalizeLinks, withLink, recordFromResult };
