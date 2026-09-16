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
// Separator between the bar and the message on a shared line.
const INLINE_SEPARATOR = ' · ';
// Below this many characters a message would be a meaningless stub, so a
// one-line style drops it and keeps the bar instead of a two-letter tease.
const MIN_INLINE_INFO_CHARS = 8;
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

// composeStatusBody(plan, percent, infoLines) -> notification body
//
// `infoLines` is the message: the task title with its counts, a progress
// message, 'Response complete', or the error text. Empty entries are dropped,
// so a progress update with no message is the bar alone.
//
// stacked: bar row first (so a body the OS collapses still shows progress),
//          then every message line.
// inline:  one shared line — `[##--] 40% · message` — because a one-line
//          style never shows a second row; the message is clipped to what is
//          left after the bar. If nothing useful fits, the bar (with its
//          percentage) is the whole line rather than a truncated stub.
function composeStatusBody(plan, percent, infoLines) {
  const cells = plan && plan.cells ? plan.cells : MIN_CELLS;
  const chars = plan && plan.chars ? plan.chars : 0;
  const layout = plan && plan.layout ? plan.layout : 'stacked';
  const bar = asciiStatusBar(percent, cells);
  const info = (infoLines || [])
    .map((line) => String(line == null ? '' : line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!info.length) return bar;
  if (layout !== 'inline') return bar + '\n' + info.join('\n');

  // One visible line: give the message everything the bar does not use, and
  // keep the total inside the line so the OS never wraps it.
  const room = chars ? Math.max(0, chars - bar.length - INLINE_SEPARATOR.length) : 0;
  const message = info.join(' / ');
  if (room >= MIN_INLINE_INFO_CHARS) return bar + INLINE_SEPARATOR + clip(message, room);
  return bar;
}

module.exports = {
  MIN_CELLS,
  MAX_CELLS,
  BAR_OVERHEAD_CHARS,
  INLINE_SEPARATOR,
  INLINE_BAR_SHARE,
  MAX_INLINE_CELLS,
  STACKED_BAR_SHARE,
  MIN_INLINE_INFO_CHARS,
  REFERENCE_VIEWPORT_PX,
  OS_CAPACITY,
  UNKNOWN_CAPACITY,
  normalizeOs,
  capacityFor,
  statusBarPlan,
  planForSubscription,
  asciiStatusBar,
  composeStatusBody,
  clip
};
