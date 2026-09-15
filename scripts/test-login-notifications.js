'use strict';
// Coverage for the sign-in notification: the opt-in preference resolution
// and the broadcast that must reach the user's other subscribed devices.
//
// History: a login mints a brand-new push session, so sending to that
// session's own subscription list (empty until the page rebinds) would
// reach nothing. The alert therefore broadcasts to every endpoint. This
// test pins both the preference gate and the broadcast behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-login-push-'));
// ---- Recorder web-push ------------------------------------------------
const webpush = require('web-push');
const deliveries = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = (subscription, payload) => {
deliveries.push({ subscription, payload: JSON.parse(payload) });
return Promise.resolve();
};
const push = require('../src/push.js');
const notifications = require('../src/notifications.js');
const settings = require('../src/settings.js');
push.ensureTable();
push.ensureVapidKeys();
// ---- Preference resolution -------------------------------------------
assert.equal(notifications.resolveNotificationPrefs(undefined).login, false,
'a fresh store leaves sign-in alerts off (opt-in)');
assert.equal(notifications.resolveNotificationPrefs({ login: true }).login, true,
'an explicit login:true enables the sign-in alert');
assert.equal(notifications.resolveNotificationPrefs({ login: false }).login, false,
'an explicit login:false keeps it off');
assert.equal(notifications.resolveNotificationPrefs({ progress: false, completion: false, errors: false }).status, false,
'legacy status keys still resolve');
assert.equal(notifications.resolveNotificationPrefs({ askUser: false, toolAuthorization: false }).authorization, false,
'legacy authorization keys still resolve');
// ---- Broadcast reaches every subscribed session ----------------------
// Two sessions, as if the user is signed in on a phone and a laptop.
push.addSubscription({ sessionId: 'phone', endpoint: 'https://push.test/phone', p256dh: 'p-phone', auth: 'a-phone', origin: 'https://mouaif.test' });
push.addSubscription({ sessionId: 'laptop', endpoint: 'https://push.test/laptop', p256dh: 'p-laptop', auth: 'a-laptop', origin: 'https://mouaif.test' });
assert.equal(push.listAllSubscriptions().length, 2, 'both sessions are subscribed');
deliveries.length = 0;
push.sendPushToAll({
title: 'mouaif sign-in',
body: 'New sign-in as alice from iPhone or iPad.',
tag: 'mouaif-login',
data: { kind: 'login', url: '/#/projects' },
actions: [{ action: 'open', title: 'Open mouaif' }]
});
assert.equal(deliveries.length, 2, 'a sign-in alert reaches every subscribed device, not just the new session');
assert.ok(deliveries.every((d) => d.payload.tag === 'mouaif-login'), 'the sign-in alert uses a single replaceable tag');
assert.ok(deliveries.every((d) => d.payload.data.kind === 'login'), 'the payload marks the alert as a sign-in');
assert.ok(deliveries.every((d) => d.payload.data.url === '/#/projects'), 'tapping the alert opens the projects list');
// ---- The access handler wires the gate ---------------------------------
const accessSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server-handlers-access.js'), 'utf8');
assert.ok(accessSource.includes('function notifyLogin('), 'the access handler defines a sign-in notifier');
assert.ok(accessSource.includes('prefs.login !== true'), 'the notifier respects the opt-in preference');
assert.ok(accessSource.includes('push.sendPushToAll('), 'the notifier broadcasts rather than targeting the new session');
assert.equal((accessSource.match(/notifyLogin\(/g) || []).length, 5,
'the definition and all three sign-in paths (password, setup, passkey) reference notifyLogin');
// ---- The settings surface exposes the row -----------------------------
const settingsUi = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'SettingsNotifications.jsx'), 'utf8');
assert.ok(settingsUi.includes("eventRow('login', 'Sign-in alerts'"), 'the Notifications screen exposes a Sign-in alerts row');
assert.equal(settings.notifications === undefined, true, 'settings.DEFAULTS exposes notifications through DEFAULTS, not a bare export');
assert.equal(settings.DEFAULTS.notifications.login, false, 'the server default keeps sign-in alerts off');
console.log('login notifications: assertions passed');
fs.rmSync(path.join(process.env.MOUAIF_HOME), { recursive: true, force: true });
