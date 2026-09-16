'use strict';

// Regression coverage for the device-sized ASCII status bar.
//
// The status bar was one fixed 10-cell width for every device, so it either
// wrapped and pushed the status text off a phone's preview or wasted
// resolution on a desktop. The width now follows the screen, the body layout
// follows the notification style the OS presents, and the fallbacks follow the
// OS version (src/statusBar.js). A device reports its own facts at subscribe
// time and the server resolves them per target.
//
// This test drives the real HTTP layer: it POSTs subscriptions with different
// device reports, then fires a chat-style status push and asserts each device
// received a body built for its own screen, style, and OS. web-push is
// replaced with a recorder, so no network is used.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-status-bar-'));

const webpush = require('web-push');
const deliveries = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = (subscription, payload) => {
  deliveries.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  return Promise.resolve();
};

const statusBar = require('../src/statusBar.js');
const push = require('../src/push.js');
const { handlePush } = require('../src/server-handlers-push.js');

push.ensureTable();
push.ensureVapidKeys();

const INFO = 'Fix push layout — 2 of 5';

// ---- Bar formatter -----------------------------------------------------

assert.equal(statusBar.asciiStatusBar(40, 6), '[##----] 40%', 'a 6-cell bar fills proportionally');
assert.equal(statusBar.asciiStatusBar(40, 10), '[####------] 40%', 'a 10-cell bar fills proportionally');
assert.equal(statusBar.asciiStatusBar(40, 20), '[########------------] 40%', 'a 20-cell bar fills proportionally');
assert.equal(statusBar.asciiStatusBar(1, 20), '[#-------------------] 1%', 'a fine bar lights one cell for 1%');
assert.equal(statusBar.asciiStatusBar(0, 20), '[--------------------] 0%', 'zero progress lights no cells');
assert.equal(statusBar.asciiStatusBar(null, 6), '[------]', 'an unlabelled bar has no percentage');
// A cell count outside the supported range is clamped rather than producing
// a bar that cannot be shown.
assert.equal(statusBar.asciiStatusBar(50, 0), '[##--] 50%', 'a zero cell count clamps to the minimum');
assert.equal(statusBar.asciiStatusBar(50, 1e6).length, 32 + 6, 'an absurd cell count clamps to the maximum');

// ---- OS + version resolution -------------------------------------------

assert.equal(statusBar.normalizeOs('iPadOS'), 'ipados', 'iPadOS is recognized as its own platform');
assert.equal(statusBar.normalizeOs('Android'), 'android', 'Android is case-insensitive');
assert.equal(statusBar.normalizeOs('macintel'), 'macos', 'a Safari Mac platform string maps to macOS');
assert.equal(statusBar.normalizeOs('webos'), '', 'an unknown platform is rejected');
assert.equal(statusBar.capacityFor('ios', 12).collapsedLines, 1, 'an iOS 12 banner previews one line');
assert.equal(statusBar.capacityFor('ios', 15).collapsedLines, 2, 'an iOS 15 banner previews two lines');
assert.equal(statusBar.capacityFor('ios', 17).versionMatched, true, 'the iOS 15 rule is reported as matched');
assert.equal(statusBar.capacityFor('ios', 0).collapsedLines, 1, 'an iOS device that reports no version keeps the base row');
assert.equal(statusBar.capacityFor('android', 8).expandedLines, 8, 'an Android 8 expanded card is taller');
assert.equal(statusBar.capacityFor('android', 7).expandedLines, 4, 'a pre-Oreo expanded card stays short');
assert.equal(statusBar.capacityFor('nokia', 1).os, 'unknown', 'an unknown OS resolves to the unknown table');
assert.equal(statusBar.capacityFor('nokia', 1).collapsedLines, 1, 'the unknown table assumes one line');

// ---- Plan: continuous width, style, sanity band ------------------------

// Width is continuous across phone sizes, not bucketed: two phones 24 px apart
// get different cell counts.
const smallPhone = statusBar.statusBarPlan({ chars: 28, viewportWidth: 320, os: 'android', osVersion: 13 });
const bigPhone = statusBar.statusBarPlan({ chars: 35, viewportWidth: 430, os: 'android', osVersion: 13 });
assert.notEqual(smallPhone.cells, bigPhone.cells, 'two phone sizes get different bar widths');
assert.ok(bigPhone.cells > smallPhone.cells, 'the wider phone gets the wider bar');
// The same holds on a two-line platform, where the bar has a row of its own.
const smallIos = statusBar.statusBarPlan({ chars: 33, viewportWidth: 320, os: 'ios', osVersion: 17 });
const bigIos = statusBar.statusBarPlan({ chars: 42, viewportWidth: 430, os: 'ios', osVersion: 17 });
assert.ok(bigIos.cells > smallIos.cells, 'a larger iOS phone gets a longer stacked bar');

// Style decides the layout, and the lines come from the OS + version.
const android = statusBar.statusBarPlan({ chars: 34, viewportWidth: 360, os: 'android', osVersion: 13 });
assert.equal(android.lines, 1, 'a collapsed Android notification shows one body line');
assert.equal(android.layout, 'inline', 'a one-line style puts the bar and message on one row');
const ios = statusBar.statusBarPlan({ chars: 40, viewportWidth: 390, os: 'ios', osVersion: 17 });
assert.equal(ios.lines, 2, 'an iOS 17 banner shows two body lines');
assert.equal(ios.layout, 'stacked', 'a multi-line style keeps the bar on its own row');
const ios14 = statusBar.statusBarPlan({ chars: 40, viewportWidth: 390, os: 'ios', osVersion: 14 });
assert.equal(ios14.layout, 'inline', 'a pre-15 iOS banner uses the inline layout');
const expanded = statusBar.statusBarPlan({ chars: 34, viewportWidth: 360, os: 'android', osVersion: 13, style: 'expanded' });
assert.equal(expanded.layout, 'stacked', 'an expanded notification gives the bar its own row');

// A stacked bar stays shorter than the line, so the message row is the widest
// row in the notice.
assert.ok(statusBar.asciiStatusBar(100, android.cells).length <= android.chars,
  'a stacked bar fits its body line');
assert.ok(android.cells <= Math.round(android.chars * statusBar.STACKED_BAR_SHARE),
  'a stacked bar leaves room on its row');

// A measurement far off what the platform expects is pulled back rather than
// trusted, so a broken probe cannot produce a bar that overflows.
const bogus = statusBar.statusBarPlan({ chars: 900, viewportWidth: 360, os: 'android', osVersion: 13 });
assert.equal(bogus.clamped, true, 'an implausible measurement is clamped');
assert.ok(bogus.chars <= Math.ceil(34 * 1.6), 'the clamped width is near the platform expectation');

// An unmeasured device falls back to the platform table scaled to its
// viewport, and an unknown platform to the conservative phone plan.
const unmeasured = statusBar.statusBarPlan({ viewportWidth: 720, os: 'macos' });
assert.ok(unmeasured.chars > 52, 'an unmeasured desktop scales the fallback up from the table');
const unknown = statusBar.statusBarPlan({});
assert.equal(unknown.os, 'unknown', 'a device that reports nothing is unknown');
assert.equal(unknown.layout, 'inline', 'an unknown device is assumed to show one line');

// ---- Extra facts in the body -------------------------------------------
//
// Everything the status knows lives in the body, under the bar. Different
// tiers matter on different surfaces, so a narrow device keeps the top tiers
// and a wide one shows all of them — no separate code path.

assert.equal(statusBar.usageSummary({ tokens: 243 }), '243 tok', 'usage without pricing is just tokens');
assert.equal(statusBar.usageSummary({ tokens: 12400, costKnown: true, cost: 0.0312 }), '12K tok · $0.0312',
  'usage adds the price when pricing is known');
assert.equal(statusBar.usageSummary({ tokens: 0 }), '', 'no usage reported means no usage row');
assert.equal(statusBar.usageSummary({}), '', 'a missing usage never renders');
assert.equal(statusBar.formatCost(0.00004), '$0.00004', 'a sub-cent cost keeps its precision rather than reading as free');
assert.equal(statusBar.formatCost(0.5), '$0.50', 'a normal cost keeps two decimals');
assert.equal(statusBar.activityLine({ tool: 'shell', model: 'gpt-5-mini', elapsedMs: 12400 }),
  'shell · gpt-5-mini · 12s', 'the activity line joins tool, model, and elapsed time');
assert.equal(statusBar.activityLine({ model: 'gpt-5-mini' }), 'gpt-5-mini', 'an activity line with one part is just that part');
assert.equal(statusBar.activityLine({}), '', 'an empty activity line renders nothing');
// A path or model id is read from its tail when it has to be clipped.
assert.equal(statusBar.clipSmart('/a/b/c/transcript.js', 16), '...transcript.js', 'a clipped path keeps the filename');
assert.equal(statusBar.clipSmart('short', 40), 'short', 'a short value is untouched');

const richInfo = {
  kind: 'task',
  message: 'Refactoring the composer',
  current: 2, total: 5,
  time: '12s', tool: 'shell', model: 'gpt-5-mini',
  usage: '12.4K tok · $0.0312'
};
const richLines = statusBar.detailLines(ios, 40, richInfo);
assert.equal(richLines[0], 'Refactoring the composer', 'the running message is the first detail row');
assert.equal(richLines[1], '2 of 5', 'the position in the work is the next detail row');
assert.ok(richLines.includes('12.4K tok · $0.0312'), 'the turn usage is a detail row');
assert.equal(richLines.length, ios.detailLines, 'the detail rows stay within the surface height');
assert.ok(!richLines.some((l) => l.includes('Fix push layout')), 'a task no longer duplicates its title into the body');

// A taller surface shows the lower tiers; a preview-sized one does not.
const expandedPlan = statusBar.statusBarPlan({ chars: 34, viewportWidth: 360, os: 'android', osVersion: 13, style: 'expanded' });
const expandedLines = statusBar.detailLines(expandedPlan, 40, richInfo);
assert.ok(expandedLines.length > richLines.length, 'an expanded notification shows more facts than a preview');
assert.ok(expandedLines.some((l) => l.includes('shell')), 'the tool surfaces once the surface is tall enough');
assert.ok(expandedLines.some((l) => l.includes('gpt-5-mini')), 'the model surfaces once the surface is tall enough');
assert.ok(!richLines.some((l) => l.includes('gpt-5-mini')), 'a preview-sized surface drops the lowest tier rather than wrapping');
// A wider body line is what brings the tool and model in on a preview surface.
const richDesktop = statusBar.detailLines(statusBar.statusBarPlan({ chars: 110, viewportWidth: 1280, os: 'macos', osVersion: 14 }), 40, richInfo);
assert.ok(richDesktop.length >= richLines.length, 'a wider surface shows at least as many detail rows');
// A narrower surface drops the lowest tiers instead of wrapping.
const narrow = statusBar.statusBarPlan({ chars: 26, viewportWidth: 300, os: 'android', osVersion: 13 });
const narrowLines = statusBar.detailLines(narrow, 40, richInfo);
assert.ok(narrowLines.length <= narrow.detailLines, 'a narrow surface keeps within its height budget');
for (const line of narrowLines) assert.ok(line.length <= narrow.chars, 'a narrow detail row fits the body line: ' + line);

// A completion says what happened and leaves the position in the work out.
const completeLines = statusBar.detailLines(ios, 100, { kind: 'complete', message: 'Response complete', current: 5, total: 5 });
assert.equal(completeLines[0], 'Response complete', 'a completion leads with its message');
assert.ok(!completeLines.includes('5 of 5'), 'a completion drops the now-redundant counts row');
// An error keeps its message and whatever context the turn had.
const errorLines = statusBar.detailLines(ios, null, { kind: 'error', message: 'Error: upstream error', model: 'gpt-5-mini' });
assert.equal(errorLines[0], 'Error: upstream error', 'an error leads with its message');

// ---- Body composition --------------------------------------------------

const stackedBody = statusBar.composeStatusBody(ios, 40, { message: INFO });
assert.equal(stackedBody.split('\n')[0], statusBar.asciiStatusBar(40, ios.cells), 'the bar row comes first');
assert.ok(stackedBody.endsWith('\n' + INFO), 'the message row follows intact');
// A bare string is the one-fact shorthand and behaves the same way.
assert.equal(statusBar.composeStatusBody(ios, 40, INFO), stackedBody, 'a string is accepted as a lone message');
const inlineBody = statusBar.composeStatusBody(android, 40, { message: INFO });
assert.equal(inlineBody.split('\n').length, 1, 'an inline body is a single line');
assert.ok(inlineBody.startsWith(statusBar.asciiStatusBar(40, android.cells) + statusBar.INLINE_SEPARATOR),
  'an inline body starts with the bar and its separator');
assert.ok(inlineBody.length <= android.chars, 'an inline body fits the body line');
// A bar-only body is legal (a progress update with no message).
assert.equal(statusBar.composeStatusBody(android, 40, {}), statusBar.asciiStatusBar(40, android.cells),
  'an empty fact set leaves the bar alone');
assert.equal(statusBar.composeStatusBody(android, 40, []), statusBar.asciiStatusBar(40, android.cells),
  'an empty list leaves the bar alone');
// If the bar leaves no room for a meaningful message, the bar is the line
// rather than a two-letter stub.
const tiny = statusBar.statusBarPlan({ chars: 8, os: 'android', osVersion: 13 });
assert.ok(!statusBar.composeStatusBody(tiny, 40, { message: INFO }).includes(statusBar.INLINE_SEPARATOR),
  'a line too narrow for a message shows the bar only');
// The stacked body carries every detail row the plan allows.
const richBody = statusBar.composeStatusBody(ios, 40, richInfo).split('\n');
assert.equal(richBody[0], statusBar.asciiStatusBar(40, ios.cells), 'the rich body still leads with the bar');
assert.equal(richBody.length, 1 + richLines.length, 'the rich body carries exactly the planned detail rows');
assert.equal(statusBar.clip('Fix push layout — 2 of 5', 12), 'Fix push...', 'a clipped message is ellipsized');
assert.ok(statusBar.clip('Fix push layout — 2 of 5', 12).length <= 12, 'a clipped message fits its budget');
assert.equal(statusBar.clip('short', 12), 'short', 'a message inside the budget is untouched');
assert.equal(statusBar.clip('  padded  ', 40), 'padded', 'a clip trims surrounding whitespace');

// ---- Legacy stored shape ----------------------------------------------

// A subscription written by the older client stored only the character count.
const legacyPlan = statusBar.planForSubscription({ status_bar: 34 });
assert.equal(legacyPlan.chars, 34, 'the legacy character count is still honored');
assert.equal(legacyPlan.os, 'unknown', 'a legacy subscription has no OS and uses the safe default');
// A profile written by the current client wins over the legacy count.
const profilePlan = statusBar.planForSubscription({
  status_bar: 34,
  status_bar_profile: JSON.stringify({ chars: 40, viewportWidth: 390, os: 'ios', osVersion: 17 })
});
assert.equal(profilePlan.os, 'ios', 'the stored profile drives the plan');
assert.equal(profilePlan.layout, 'stacked', 'the stored profile style drives the layout');
// Corruption in the stored profile must not throw at send time.
assert.doesNotThrow(() => statusBar.planForSubscription({ status_bar_profile: '{not json' }),
  'a corrupt stored profile falls back safely');

// ---- HTTP: subscribe with a device report ------------------------------

function mockResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { if (chunk) this.body += chunk; }
  };
}

async function postSubscription(sessionToken, endpoint, subscription) {
  const payload = JSON.stringify({ subscription: Object.assign({ endpoint, keys: { p256dh: 'p-' + endpoint, auth: 'a-' + endpoint } }, subscription || {}) });
  const req = {
    method: 'POST',
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(payload));
      if (event === 'end') handler();
      return this;
    },
    once(event, handler) { return this.on(event, handler); }
  };
  const res = mockResponse();
  await handlePush(req, res, { pathname: '/api/push/subscribe' }, sessionToken, 'https://mouaif.test');
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

(async () => {
  const session = 'session-mixed';
  const sid = push.sessionIdFromToken(session);

  // A small Android phone (one body line), an iOS 17 phone (two lines), and a
  // desktop window — three devices, three different bodies.
  assert.equal((await postSubscription(session, 'https://android.example', {
    statusBarProfile: { chars: 30, viewportWidth: 320, os: 'android', osVersion: 13, style: 'collapsed' }
  })).status, 200, 'the Android subscription is accepted');
  assert.equal((await postSubscription(session, 'https://ios.example', {
    statusBarProfile: { chars: 40, viewportWidth: 390, os: 'ios', osVersion: 17, style: 'collapsed' }
  })).status, 200, 'the iOS subscription is accepted');
  assert.equal((await postSubscription(session, 'https://desktop.example', {
    statusBarProfile: { chars: 110, viewportWidth: 1280, os: 'macos', osVersion: 14, style: 'collapsed' }
  })).status, 200, 'the desktop subscription is accepted');
  // The older bare-count shape still works.
  assert.equal((await postSubscription(session, 'https://legacy.example', { statusBarMaxChars: 34 })).status, 200,
    'the legacy bare-count subscription is accepted');

  const rows = new Map(push.listSubscriptions(sid).map((r) => [r.endpoint, r]));
  assert.ok(rows.get('https://android.example').status_bar_profile.includes('"os":"android"'),
    'the Android device report is stored');
  assert.equal(rows.get('https://legacy.example').status_bar_profile, null, 'a bare count stores no profile');
  assert.equal(rows.get('https://legacy.example').status_bar, 34, 'a bare count is still stored');

  // Rebinding without a report (an older/cached page) must not wipe a profile.
  await postSubscription(session, 'https://android.example');
  assert.equal(push.listSubscriptions(sid).find((r) => r.endpoint === 'https://android.example').status_bar_profile,
    rows.get('https://android.example').status_bar_profile, 'a rebind without a report keeps the stored profile');

  // A new subscription that reports nothing stores nothing and gets the
  // conservative plan at send time.
  await postSubscription(session, 'https://unknown.example');
  assert.equal(push.listSubscriptions(sid).find((r) => r.endpoint === 'https://unknown.example').status_bar_profile, null,
    'a silent subscription stores no profile');

  // ---- One push, three device-specific bodies -------------------------
  deliveries.length = 0;
  const planBodies = new Map();
  push.sendPushToSession(sid, {
    title: 'Chat one',
    // The chat handler passes a resolver, not a fixed body, which is what lets
    // each device get its own plan.
    bodyFor: (sub) => {
      const plan = push.statusBar.planForSubscription(sub);
      planBodies.set(sub.endpoint, plan);
      return push.statusBar.composeStatusBody(plan, 40, {
      message: INFO, current: 2, total: 5, kind: 'task',
      time: '12s', tool: 'shell', model: 'gpt-5-mini', usage: '12.4K tok'
      });
    },
    tag: 'chat-abcd1234-status',
    chatId: 'abcd1234',
    projectDir: '/tmp/project'
  });
  await new Promise((r) => setTimeout(r, 20));

  const bodies = new Map(deliveries.map((d) => [d.endpoint, d.payload.body]));
  assert.equal(deliveries.length, 5, 'every device got the push');

  // Android: one body line, so the message shares the bar's row.
  assert.equal(bodies.get('https://android.example').split('\n').length, 1,
    'the one-line Android device gets a single-line body');
  assert.ok(bodies.get('https://android.example').includes(INFO.slice(0, 8)),
    'the one-line Android body still shows the message');
  // iOS: two body lines, so the bar keeps its own row and the facts follow in
  // the planned order (message, then counts, then usage) — not one long row.
  const iosBody = bodies.get('https://ios.example');
  const iosPlan = planBodies.get('https://ios.example');
  assert.equal(iosBody.split('\n')[0], statusBar.asciiStatusBar(40, iosPlan.cells),
    'the two-line iOS body keeps the bar on its own row');
  assert.ok(iosBody.includes(INFO), 'the two-line iOS body still carries the message');
  assert.ok(iosBody.includes('2 of 5'), 'the two-line iOS body carries the position in the work');
  assert.ok(iosBody.includes('12.4K tok'), 'the two-line iOS body carries the turn usage');
  assert.equal(iosBody.split('\n').length, 1 + iosPlan.detailLines, 'the iOS body uses exactly its height budget');
  // The extra facts ride the body, never the title: the title is the chat name
  // on every device, however much detail the body shows.
  const pushPayloads = deliveries.map((d) => d.payload);
  assert.ok(pushPayloads.every((p) => p.title === 'Chat one'), 'the notification title stays the chat name on every device');
  assert.ok(pushPayloads.every((p) => !/tok|12\.4K|\$0/.test(p.title)), 'no usage ever leaks into the notification title');
  // Desktop: a wider body line, so a longer bar (up to the readability cap).
  assert.ok(planBodies.get('https://desktop.example').chars > planBodies.get('https://ios.example').chars,
    'the desktop body line is wider than the phone line');
  assert.ok(planBodies.get('https://desktop.example').cells >= planBodies.get('https://ios.example').cells,
    'the desktop bar is at least as wide as the phone bar');
  assert.ok(planBodies.get('https://android.example').cells < planBodies.get('https://ios.example').cells,
    'the small phone bar is narrower than the larger phone bar');
  // No body wraps: each device's longest line fits its own body line.
  for (const endpoint of ['https://android.example', 'https://ios.example', 'https://desktop.example']) {
    const lines = bodies.get(endpoint).split('\n');
    const chars = planBodies.get(endpoint).chars;
    for (const line of lines) assert.ok(line.length <= chars, endpoint + ' line ' + JSON.stringify(line) + ' fits ' + chars);
  }

  // ---- An error keeps the bar shape with no percentage ----------------
  deliveries.length = 0;
  push.sendPushToSession(sid, {
    title: 'Chat one',
    bodyFor: (sub) => {
      const plan = push.statusBar.planForSubscription(sub);
      return push.statusBar.composeStatusBody(plan, null, { kind: 'error', message: 'Error: upstream error' });
    },
    tag: 'chat-abcd1234-status',
    chatId: 'abcd1234',
    projectDir: '/tmp/project'
  });
  await new Promise((r) => setTimeout(r, 20));
  const errorBody = deliveries.find((d) => d.endpoint === 'https://ios.example').payload.body;
  assert.equal(errorBody, statusBar.asciiStatusBar(null, planBodies.get('https://ios.example').cells) + '\nError: upstream error',
    'an error keeps the bar shape but has no percentage');

  // ---- A push without a resolver sends one body everywhere ------------
  deliveries.length = 0;
  push.sendPushToSession(sid, { title: 'Authorization needed', body: 'shell is waiting for approval.', tag: 'chat-abcd1234-attention' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(deliveries.length > 0, 'the attention push is delivered');
  assert.ok(deliveries.every((d) => d.payload.body === 'shell is waiting for approval.'),
    'a push with no resolver sends the same body to every device');

  console.log('status bar sizing: ' + deliveries.length + ' deliveries, all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
