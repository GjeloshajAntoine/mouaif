'use strict';

// Status bar — the ASCII bar in every OS chat notification.
//
// Three things decide what that bar can look like, and all three vary per
// device:
//
//   1. Screen width. Every phone size gives a different number of characters
//      per body line, so a fixed cell count is wrong somewhere. The device
//      measures its own capacity and the cell count follows it continuously
//      (no small/medium/large buckets).
//   2. Notification style. A collapsed Android notification shows exactly one
//      body line; an iOS banner shows a two-line preview; a desktop toast
//      about two. On a one-line style the bar and its message must share that
//      single line, or the message is never seen.
//   3. OS version. It sets the fallback line counts when a device cannot
//      measure itself (older WebKit, a headless browser), and it bounds a
//      measurement that is out of line for the reported platform.
//
// The server owns this module; the browser only reports raw facts about
// itself (measured characters, viewport width, OS, OS version) at subscribe
// time. Keeping every decision here means one table to reason about and one
// place to test.

// ---- Shape constants ---------------------------------------------------

// How many cells a bar may use. The floor keeps a bar readable on the
// narrowest watch-class notification; the ceiling stops a wide desktop toast
// from turning the bar into a ruler.
const MIN_CELLS = 4;
const MAX_CELLS = 32;
// Characters a bar row adds around its cells: `[` + cells + `]` + ` 100%`.
const BAR_OVERHEAD_CHARS = 7;
// On a one-line style the bar shares its line with the message, so it takes
// at most this share of the line and leaves the rest for the text.
const INLINE_BAR_SHARE = 1 / 3;
const MAX_INLINE_CELLS = 16;
// On a stacked style the bar gets its own row, but keeping it a little
// shorter than the line means the message row stays the widest row in the
// notice — the thing a person actually reads — and the bar still reads as a
// bar rather than a ruler across the card.
const STACKED_BAR_SHARE = 0.8;
// Separator between facts sharing a line (the bar + message on an inline row,
// or the tool/model/time on an activity line).
const SEPARATOR = ' · ';
const INLINE_SEPARATOR = SEPARATOR;
// Below this many characters a message would be a meaningless stub, so a
// one-line style drops it and keeps the bar instead of a two-letter tease.
const MIN_INLINE_INFO_CHARS = 8;
// Detail rows below the bar. A one-line style shares its row with the bar, so
// it has room for the single most important fact. A multi-line banner or
// toast shows the bar plus the top few facts; an expanded notification is
// tall enough for every tier. This is the whole "show more on a bigger
// device" mechanism — no per-device special case.
const DETAIL_LINES_INLINE = 1;
const DETAIL_LINES_PREVIEW = 3;
const DETAIL_LINES_EXPANDED = 6;
// Truncation marker for a message clipped to fit a line. Kept ASCII for the
// same reason the bar is: notification fonts render it consistently.
const ELLIPSIS = '...';

// ---- Per-OS notification capacity --------------------------------------
//
// `collapsedChars` is the characters one body line held on a 360 CSS px
// reference phone for that platform. It is a *fallback and a sanity bound*,
// never the normal source: a device that can measure itself reports its own
// number, and this table only steers the cases where it cannot.
//
// `collapsedLines` is how many body lines the platform shows without the
// user expanding the notification — the number that decides whether the bar
// gets a line of its own. `expandedLines` is how many it shows once the user
// pulls the notification open.
const OS_CAPACITY = Object.freeze({
  android: {
    label: 'Android',
    collapsedChars: 34,
    // A collapsed Android notification shows one body line, whatever its
    // size; the title above it is always visible.
    collapsedLines: 1,
    // Notification channels and the tall BigText card arrive in Android 8
    // (Oreo); before that an expanded notification was only a little taller.
    expandedLines: 4,
    versionRules: [
      { minVersion: 8, collapsedLines: 1, expandedLines: 8, note: 'notification channels (Oreo) introduced the tall expanded card' }
    ]
  },
  ios: {
    label: 'iOS',
    collapsedChars: 40,
    // Before iOS 15 a banner previewed a single body line; 15 and later
    // preview two.
    collapsedLines: 1,
    expandedLines: 6,
    versionRules: [
      { minVersion: 15, collapsedLines: 2, expandedLines: 6, note: 'iOS 15 banners preview two body lines' }
    ]
  },
  ipados: { alias: 'ios' },
  macos: {
    label: 'macOS',
    collapsedChars: 52,
    collapsedLines: 2,
    expandedLines: 4,
    versionRules: []
  },
  windows: {
    label: 'Windows',
    collapsedChars: 46,
    collapsedLines: 2,
    expandedLines: 4,
    versionRules: []
  },
  linux: {
    label: 'Linux',
    collapsedChars: 46,
    collapsedLines: 2,
    expandedLines: 4,
    versionRules: []
  },
  chromeos: {
    label: 'ChromeOS',
    collapsedChars: 48,
    collapsedLines: 2,
    expandedLines: 4,
    versionRules: []
  }
});

// A platform the client did not identify behaves like a phone on a
// conservative platform: one body line, moderate width.
const UNKNOWN_CAPACITY = Object.freeze({
  label: 'Unknown',
  collapsedChars: 34,
  collapsedLines: 1,
  expandedLines: 4,
  versionRules: []
});

const REFERENCE_VIEWPORT_PX = 360;
// A measured capacity is trusted only within this band of what the platform's
// table expects for the reported viewport width. A measurement outside it is
// more likely a broken probe (a hidden 0-width element, a zoomed layout) than
// a genuinely unusual device, so it is pulled back to the bound.
const MEASURE_LOWER_BOUND = 0.6;
const MEASURE_UPPER_BOUND = 1.6;

// normalizeOs(raw) -> key in OS_CAPACITY, or '' when unrecognized.
function normalizeOs(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return '';
  if (value === 'ios' || value === 'iphone' || value === 'ipad' || value === 'ipados') {
    // iPad reports as "iPadOS" from userAgentData and as "MacIntel" from a
    // missing platform; both are the iOS notification family.
    return value === 'ipados' ? 'ipados' : 'ios';
  }
  if (value.startsWith('android')) return 'android';
  if (value === 'macos' || value === 'mac' || value === 'macintel') return 'macos';
  if (value.startsWith('win')) return 'windows';
  if (value.startsWith('linux')) return 'linux';
  if (value.startsWith('chromeos') || value === 'cros') return 'chromeos';
  return '';
}

// capacityFor(os, majorVersion) -> resolved table entry
//
// Applies the ordered version rules for the platform: the first rule whose
// `minVersion` the device meets wins, so the table reads oldest-first and a
// device that reports no version keeps the base row.
function capacityFor(os, majorVersion) {
  const key = normalizeOs(os);
  let entry = key ? OS_CAPACITY[key] : null;
  if (entry && entry.alias) entry = OS_CAPACITY[entry.alias];
  const base = entry || UNKNOWN_CAPACITY;
  const major = Number(majorVersion);
  let resolved = {
    os: key || 'unknown',
    label: base.label,
    collapsedChars: base.collapsedChars,
    collapsedLines: base.collapsedLines,
    expandedLines: base.expandedLines,
    versionMatched: false
  };
  if (!Number.isFinite(major) || major <= 0) return resolved;
  for (const rule of base.versionRules || []) {
    if (major >= rule.minVersion) {
      resolved = Object.assign(resolved, {
        collapsedLines: rule.collapsedLines,
        expandedLines: rule.expandedLines,
        versionMatched: true
      });
      break;
    }
  }
  return resolved;
}

// ---- Plan --------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// clip(text, maxChars) -> text limited to maxChars, ellipsized when cut.
function clip(text, maxChars) {
  const s = String(text == null ? '' : text).trim();
  const max = Math.floor(maxChars);
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= ELLIPSIS.length) return s.slice(0, max);
  return s.slice(0, max - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}

// clipSmart(text, maxChars) -> clip() that keeps the part that identifies the
// thing. Paths, model ids, and tool names are read from their tail (`.../chat.js`,
// `.../gpt-5-mini`), messages from their head. Splitting on the last separator
// keeps the filename or the model name visible instead of truncating to a
// useless prefix.
function clipSmart(text, maxChars) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const max = Math.floor(maxChars);
  if (!s || max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= ELLIPSIS.length) return s.slice(0, max);
  const budget = max - ELLIPSIS.length;
  const cut = s.lastIndexOf('/');
  if (cut > 0) {
    const tail = s.slice(cut + 1);
    if (tail.length <= budget) return ELLIPSIS + tail;
  }
  return s.slice(0, budget).trimEnd() + ELLIPSIS;
}

// usageSummary({ tokens, costKnown, cost }) -> '12.4K tok · $0.0312'
//
// The running turn usage as one compact token, or '' when nothing is known.
// It used to be appended to the notification *title*, where it competed with
// the chat name and was the first thing the OS clipped on a narrow lock
// screen; it lives in the body now, next to the rest of the status.
function usageSummary(opts) {
  const o = opts || {};
  const tokens = Number(o.tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const parts = [formatTokenCount(tokens) + ' tok'];
  if (o.costKnown === true && o.cost != null) parts.push(formatCost(o.cost));
  return parts.join(' · ');
}

// formatTokenCount(n) -> '243' / '12.4K' / '1.2M'
//
// The same magnitude rules as the server's usage.formatTokens(), so a number
// shown in the notification matches the number shown in the chat. Kept local
// so src/statusBar.js stays free of the pricing/usage module.
function formatTokenCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '--';
  if (v < 1000) return String(Math.round(v));
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'K';
  return (v / 1000000).toFixed(v < 10000000 ? 2 : 1) + 'M';
}

// formatCost(amount) -> '$0.0312' / '$0.50'
//
// Deliberately the same fractional-digit rules as the server's
// usage.formatCost() (2–5 digits, minimum 2), so a price in the notification
// reads exactly like the price on the chat's own cost line. Trimming stops at
// two decimals, unlike a plain toFixed(5), so `$0.50` does not become
// `$0.50000`.
function formatCost(amount) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a < 0) return '';
  if (a === 0) return '$0.00';
  const digits = a < 1 ? 5 : 2;
  let body = a.toFixed(digits);
  if (digits > 2) body = body.replace(/(\.\d\d[0-9]*?)0+$/, '$1');
  return '$' + body;
}

// activityLine({ tool, model, elapsedMs }) -> 'shell · gpt-5-mini · 12s'
//
// What the model is doing and what is doing it, most specific first. Only
// non-empty fields appear, so a plain model round shows just the model. This
// is the place a new fact belongs: add a field here rather than growing the
// notification title, which the OS truncates first.
function activityLine(opts) {
  const o = opts || {};
  const parts = [];
  if (o.tool) parts.push(clip(String(o.tool), 40));
  if (o.model) parts.push(clip(String(o.model), 48));
  if (Number.isFinite(Number(o.elapsedMs)) && Number(o.elapsedMs) > 0) {
    const seconds = Number(o.elapsedMs) / 1000;
    parts.push(seconds < 10 ? seconds.toFixed(1) + 's' : Math.round(seconds) + 's');
  }
  return parts.join(SEPARATOR);
}

// Detail tiers, most important first. A narrow notification (an Android
// shade, a phone lock screen) drops the lowest tiers rather than wrapping the
// block to a second screen; a desktop toast usually fits all of them, so a
// bigger screen simply shows more without any extra code.
const DETAIL_TIERS = Object.freeze([
  'counts',  // '2 of 5' — where in the work we are
  'usage',   // '12.4K tok · $0.0312'
  'time',    // '12s'
  'tool',    // 'shell' / 'read_file'
  'model'    // 'gpt-5-mini' / 'openai-compatible/gpt-4o'
]);

// detailLines(plan, percent, info) -> [] of detail rows, widest tier set that
// fits the device's line budget.
//
// `info` carries the status facts: { message, kind, title, current, total,
// time, tool, model, usage }. Every field is optional; a missing one simply
// does not offer its tier. A tier line is included only while it fits BOTH
// the body line and the remaining height — so a phone keeps '2 of 5' and the
// token count and drops the rest, while a desktop shows everything.
function detailLines(plan, percent, info) {
  const p = plan || {};
  const chars = Number(p.chars) > 0 ? Number(p.chars) : 0;
  const maxLines = Math.max(1, Number(p.detailLines) || 1);
  const share = p.layout === 'inline' ? INLINE_BAR_SHARE : 1;
  const budget = chars ? Math.max(0, Math.floor(chars * share)) : 0;

  const tiers = {};
  const kind = info && info.kind;
  const current = Number(info && info.current);
  const total = Number(info && info.total);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    tiers.counts = current + ' of ' + total;
  }
  // The first update of a task is 0 of N, which says nothing the bar has not
  // already said more clearly.
  if (tiers.counts && current <= 0) delete tiers.counts;
  if (info && info.time) tiers.time = String(info.time);
  if (info && info.tool) tiers.tool = String(info.tool);
  if (info && info.model) tiers.model = String(info.model);
  if (info && info.usage) tiers.usage = String(info.usage);

  const out = [];
  if (info && info.message) {
    const message = String(info.message).replace(/\s+/g, ' ').trim();
    if (message) {
      out.push(chars ? clipSmart(message, chars) : message);
    }
  }
  for (const tier of DETAIL_TIERS) {
    // A completion ('nothing left to do') makes the position in the work
    // redundant, so the counts tier steps aside for a completer.
    if (tier === 'counts' && info && info.kind === 'complete') continue;
    const value = tiers[tier];
    if (!value) continue;
    if (out.length >= maxLines) break;
    const line = chars ? clipSmart(value, budget) : value;
    if (!line) continue;
    out.push(line);
  }
  return out.slice(0, maxLines);
}

// composeStatusBody(plan, percent, info) -> notification body
//
// The whole status lives in the body, under the bar: the running message, the
// position in the work, the turn usage, the elapsed time, the tool, and the
// model. Nothing here belongs in the notification title — the OS shows the
// (fixed) chat name there and clips it first — and a task is one row, not a
// title row plus a separate task row, so the block reads as one unit.
//
// `info` accepts either a string (a lone message, the common case) or the
// fact object documented on detailLines().
//
//   stacked: bar row first (so a body the OS collapses still shows progress),
//            then the detail rows.
//   inline:  the bar shares its row with the most important fact, because a
//            one-line style never shows a second row.
function composeStatusBody(plan, percent, info) {
  const p = plan || {};
  const cells = p.cells ? p.cells : MIN_CELLS;
  const chars = Number(p.chars) > 0 ? Number(p.chars) : 0;
  const layout = p.layout ? p.layout : 'stacked';
  const facts = typeof info === 'string' || info == null ? { message: info } : info;
  const bar = asciiStatusBar(percent, cells);
  const lines = detailLines(p, percent, facts);
  if (!lines.length) return bar;
  if (layout !== 'inline') return bar + '\n' + lines.join('\n');

  // One visible line: the bar, then the first detail row in whatever room the
  // line has left. If nothing useful fits, the bar (with its percentage) is
  // the whole line rather than a truncated stub.
  const room = chars ? Math.max(0, chars - bar.length - INLINE_SEPARATOR.length) : 0;
  if (room < MIN_INLINE_INFO_CHARS) return bar;
  return bar + INLINE_SEPARATOR + clipSmart(lines[0], room);
}

// statusBarPlan(report) -> { os, osVersion, chars, lines, style, cells, layout, clamped }
//
// Turn a device's self-report into everything the body builder needs.
// `report` is what the browser measured and sniffed:
//   chars          measured characters per body line (optional)
//   viewportWidth  CSS px width of the device (optional, used to sanity-check)
//   os             platform id, see normalizeOs (optional)
//   osVersion      major version number (optional)
//   style          'collapsed' (default) or 'expanded' (optional)
//
// Rules:
//   chars  — the measurement when it is plausible, otherwise the platform
//            table scaled to the reported viewport. This is what makes the
//            width continuous across phone sizes instead of bucketed.
//   lines  — collapsed line count from the version-aware table, expanded
//            count when the device says the style is expanded. Never less
//            than one.
//   layout — 'stacked' when the style shows two or more lines (bar on its own
//            row), 'inline' when it shows one (bar and message share the row,
//            so the message is visible at all).
//   cells  — derived from `chars`: a stacked bar may use the whole line, an
//            inline bar keeps to INLINE_BAR_SHARE of it so text remains.
function statusBarPlan(report) {
  const input = report && typeof report === 'object' ? report : {};
  const capacity = capacityFor(input.os, input.osVersion);

  const viewport = Number(input.viewportWidth);
  const hasViewport = Number.isFinite(viewport) && viewport > 0;
  // What the platform expects at this device's width — the anchor for both
  // the fallback and the plausibility band.
  const expected = hasViewport
    ? Math.round(capacity.collapsedChars * (viewport / REFERENCE_VIEWPORT_PX))
    : capacity.collapsedChars;

  const measured = Number(input.chars);
  let chars = expected;
  let clamped = false;
  let measured_used = false;
  if (Number.isFinite(measured) && measured > 0) {
    chars = Math.round(measured);
    measured_used = true;
    const lower = Math.max(1, Math.floor(expected * MEASURE_LOWER_BOUND));
    const upper = Math.max(lower, Math.ceil(expected * MEASURE_UPPER_BOUND));
    if (chars < lower || chars > upper) {
      chars = clamp(chars, lower, upper);
      clamped = true;
    }
  }

  const expanded = String(input.style || '').trim().toLowerCase() === 'expanded';
  const lines = Math.max(1, expanded ? capacity.expandedLines : capacity.collapsedLines);
  const layout = lines > 1 ? 'stacked' : 'inline';
  // How many detail rows this surface has room for. It is the height budget
  // that makes a bigger device show more facts, exactly like the width budget
  // makes it show a longer bar.
  const detailLines = layout === 'inline' ? DETAIL_LINES_INLINE
    : (expanded ? DETAIL_LINES_EXPANDED : DETAIL_LINES_PREVIEW);

  // Available cell width for the bar itself. A stacked bar may use most of
  // the line; an inline bar keeps to INLINE_BAR_SHARE so text remains.
  const barBudget = Math.max(1, chars - BAR_OVERHEAD_CHARS);
  const cells = layout === 'inline'
    ? clamp(Math.round(Math.min(barBudget, chars * INLINE_BAR_SHARE)), MIN_CELLS, MAX_INLINE_CELLS)
    : clamp(Math.round(Math.min(barBudget, chars * STACKED_BAR_SHARE)), MIN_CELLS, MAX_CELLS);

  return {
    os: capacity.os,
    osVersion: Number.isFinite(Number(input.osVersion)) && Number(input.osVersion) > 0 ? Math.round(Number(input.osVersion)) : 0,
    versionMatched: capacity.versionMatched,
    chars,
    measuredChars: measured_used ? Math.round(measured) : 0,
    clamped,
    lines,
    style: expanded ? 'expanded' : 'collapsed',
    layout,
    detailLines,
    cells
  };
}

// planForSubscription(sub) -> statusBarPlan
//
// A stored subscription carries the device report as JSON in
// `status_bar_profile` (the current shape) and/or the measured character
// count in `status_bar` (the original shape, and still what a client that
// only sends a number writes). Reading both lets a subscription created
// before the profile existed keep working.
function planForSubscription(sub) {
  const report = {};
  const raw = sub && sub.status_bar_profile;
  if (typeof raw === 'string' && raw) {
    try { Object.assign(report, JSON.parse(raw) || {}); } catch { /* fall through to the legacy column */ }
  } else if (raw && typeof raw === 'object') {
    Object.assign(report, raw);
  }
  const legacy = Number(sub && sub.status_bar);
  if (report.chars == null && Number.isFinite(legacy) && legacy > 0) report.chars = legacy;
  return statusBarPlan(report);
}

// ---- Rendering --------------------------------------------------------

// asciiStatusBar(percent, cells) -> '[##----] 40%'
//
// Pure ASCII (`#` filled, `-` empty) — no Unicode block glyphs, which render
// inconsistently across Android, iOS, and desktop notification fonts.
// `percent == null` means "no measurable progress" (an error): the bar is
// empty and carries no label. Any non-zero progress lights at least one cell,
// so a fine bar never reads as empty at the start of a task.
function asciiStatusBar(percent, cells) {
  const width = clamp(Math.round(Number(cells) || MIN_CELLS), MIN_CELLS, MAX_CELLS);
  const normalized = percent == null ? null : clamp(Math.round(Number(percent) || 0), 0, 100);
  const filled = normalized == null ? 0
    : (normalized > 0 ? Math.max(1, Math.round((normalized / 100) * width)) : 0);
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']'
    + (normalized == null ? '' : ' ' + normalized + '%');
}

module.exports = {
  MIN_CELLS,
  MAX_CELLS,
  BAR_OVERHEAD_CHARS,
  SEPARATOR,
  INLINE_SEPARATOR,
  INLINE_BAR_SHARE,
  MAX_INLINE_CELLS,
  STACKED_BAR_SHARE,
  MIN_INLINE_INFO_CHARS,
  DETAIL_TIERS,
  REFERENCE_VIEWPORT_PX,
  OS_CAPACITY,
  UNKNOWN_CAPACITY,
  normalizeOs,
  capacityFor,
  statusBarPlan,
  planForSubscription,
  asciiStatusBar,
  DETAIL_LINES_INLINE,
  DETAIL_LINES_PREVIEW,
  DETAIL_LINES_EXPANDED,
  usageSummary,
  formatTokenCount,
  formatCost,
  activityLine,
  detailLines,
  composeStatusBody,
  clipSmart,
  clip
};
