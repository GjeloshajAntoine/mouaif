'use strict';

// Unit coverage for subscription rebinding and interactive payloads. No
// network is used: web-push is replaced with a synchronous recorder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-push-home-'));

const webpush = require('web-push');
const deliveries = [];
const vapidDetails = [];
webpush.setVapidDetails = (subject, publicKey, privateKey) => {
  vapidDetails.push({ subject, publicKey, privateKey });
};
webpush.sendNotification = (subscription, payload, options) => {
  deliveries.push({ subscription, payload: JSON.parse(payload), options });
  return Promise.resolve();
};

const push = require('../src/push.js');
push.ensureTable();
push.ensureVapidKeys();

const localConfig = push.getPushConfig('http://127.0.0.1:5732');
assert.equal(localConfig.privateKeyConfigured, true, 'a complete VAPID pair is configured automatically');
assert.ok(localConfig.publicKey, 'the generated VAPID public key is exposed');
assert.equal(localConfig.subject, 'mailto:push@mouaif.local', 'local HTTP uses the valid mailto VAPID fallback');
const iosConfig = push.getPushConfig('https://mouaif.example.test');
assert.equal(iosConfig.subject, 'https://mouaif.example.test', 'public HTTPS origin becomes the deployment VAPID contact');
assert.equal(iosConfig.publicKey, localConfig.publicKey, 'changing served origin preserves existing subscriptions');
assert.equal(vapidDetails.at(-1).subject, 'https://mouaif.example.test', 'web-push receives the served-domain VAPID subject');

const endpoint = 'https://push.example.test/subscription-1';
const first = push.addSubscription({
  sessionId: 'session-a',
  endpoint,
  p256dh: 'p256dh-a',
  auth: 'auth-a',
  origin: 'http://127.0.0.1:5732'
});
const rebound = push.addSubscription({
  sessionId: 'session-b',
  endpoint,
  p256dh: 'p256dh-b',
  auth: 'auth-b',
  origin: 'http://127.0.0.1:5732'
});

assert.equal(rebound.id, first.id, 'rebinding preserves the subscription id');
assert.equal(push.listSubscriptions('session-a').length, 0, 'old session no longer owns the endpoint');
assert.equal(push.listSubscriptions('session-b').length, 1, 'new session owns the endpoint');
assert.equal(push.listSubscriptions('session-b')[0].p256dh, 'p256dh-b', 'rebinding refreshes keys');

push.sendPushToSession('session-b', {
  title: 'Authorization needed',
  body: 'shell is waiting for approval.',
  chatId: 'abcd1234',
  projectDir: 'C:\\project',
  tag: 'chat-abcd1234-attention',
  data: {
    kind: 'tool_authorization',
    chatId: 'abcd1234',
    projectDir: 'C:\\project',
    callId: 'call-1',
    url: '/#/chat/abcd1234'
  },
  actions: [
    { action: 'allow-once', title: 'Allow once' },
    { action: 'deny', title: 'Deny' }
  ],
  requireInteraction: true
});

assert.equal(deliveries.length, 1, 'one delivery is produced');
assert.equal(deliveries[0].subscription.keys.p256dh, 'p256dh-b', 'delivery uses rebound keys');
assert.equal(deliveries[0].payload.tag, 'chat-abcd1234-attention', 'attention tag is preserved');
assert.equal(deliveries[0].payload.data.kind, 'tool_authorization', 'interaction kind is preserved');
assert.equal(deliveries[0].payload.actions[0].action, 'allow-once', 'allow-once action is preserved');
assert.equal(deliveries[0].payload.actions[1].action, 'deny', 'deny action is preserved');
assert.equal(deliveries[0].payload.requireInteraction, true, 'attention notification remains visible');
assert.equal(deliveries[0].options.vapidDetails.subject, 'mailto:push@mouaif.local', 'local subscription uses the fallback VAPID contact');
assert.equal(deliveries[0].options.vapidDetails.publicKey, localConfig.publicKey, 'delivery uses the persisted VAPID public key');
assert.ok(deliveries[0].options.vapidDetails.privateKey, 'delivery configures the private VAPID key without exposing it');
const chatPushSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server-handlers-chats.js'), 'utf8');
assert.ok(chatPushSource.includes("const statusPushTag = 'chat-' + chatId + '-status'"), 'chat streams define one shared status push tag');
assert.ok(!chatPushSource.includes("'-progress'"), 'chat streams do not send progress pushes under a second tag');
assert.ok(chatPushSource.includes("'[' + '#'.repeat(filled) + '-'.repeat(barWidth - filled) + ']'"), 'task status uses a true ASCII progress bar');
assert.ok(!chatPushSource.includes("'▓'.repeat") && !chatPushSource.includes("'░'.repeat"), 'task status avoids Unicode block glyphs');
const swSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'build', 'sw-src.js'), 'utf8');
const swHandlers = {};
const shownNotifications = [];
let pageVisible = true;
let pageResponds = true;
class TestMessageChannel {
constructor() {
const port1 = { onmessage: null, start() {}, close() {} };
const port2 = { onmessage: null, start() {}, close() {} };
port1.postMessage = (data) => { if (port2.onmessage) port2.onmessage({ data }); };
port2.postMessage = (data) => { if (port1.onmessage) port1.onmessage({ data }); };
this.port1 = port1;
this.port2 = port2;
}
}
const testClient = {
id: 'client-1',
url: 'https://mouaif.test/#/chat/chat-1?projectDir=%2Ftmp',
focused: true,
visibilityState: 'visible',
postMessage(message, ports) {
assert.equal(message.type, 'GET_VISIBILITY_STATE', 'push asks the live page for current visibility');
if (!pageResponds) return;
ports[0].postMessage({
type: 'VISIBILITY_STATE',
hash: '#/chat/chat-1?projectDir=%2Ftmp',
visible: pageVisible,
focused: pageVisible
});
}
};
const swClients = {
matchAll: async () => [testClient],
claim: async () => {},
openWindow: async () => null
};
const swRegistration = {
getNotifications: async () => [],
showNotification: async (title, options) => { shownNotifications.push({ title, options }); }
};
const swContext = {
URL,
Date,
Map,
Set,
Promise,
MessageChannel: TestMessageChannel,
setTimeout,
clearTimeout,
Request: class Request {},
fetch: async () => ({}),
caches: {},
clients: swClients,
self: {
location: { origin: 'https://mouaif.test' },
clients: swClients,
registration: swRegistration,
addEventListener(type, handler) { swHandlers[type] = handler; }
}
};
vm.runInNewContext(swSource.replace("'__CACHE_VERSION__'", "'test'"), swContext);
assert.equal(swContext.chatIdFromHash('#/chat/chat-1?projectDir=%2Ftmp'), 'chat-1', 'chat matching ignores projectDir query data');
assert.equal(swContext.chatIdFromHash('#/chat/chat%202'), 'chat 2', 'chat matching decodes the route id');
assert.equal(swContext.chatIdFromHash('#/projects'), '', 'non-chat routes do not match chat notifications');
assert.ok(swSource.includes("client.postMessage({ type: 'GET_VISIBILITY_STATE' }, [channel.port2])"), 'push-time suppression queries live pages after worker restarts');
assert.ok(swSource.includes('freshViews.some((view) =>'), 'only a fresh visible-page response can suppress a push');
assert.ok(swSource.includes("statusKinds = new Set(['progress', 'completion', 'error'])"), 'status cleanup covers all replaceable status types');

function dispatchPush(kind = 'completion') {
let pending = Promise.resolve();
const authorization = kind === 'tool_authorization';
swHandlers.push({
data: { json: () => ({
title: authorization ? 'Authorization needed' : 'Chat one',
body: authorization ? 'shell is waiting for approval.' : 'Response complete',
tag: authorization ? 'chat-chat-1-attention' : 'chat-chat-1-status',
data: { kind, chatId: 'chat-1', url: '/#/chat/chat-1?projectDir=%2Ftmp' }
}) },
waitUntil(promise) { pending = promise; }
});
return pending;
}

(async () => {
await dispatchPush();
assert.equal(shownNotifications.length, 0, 'a fresh visible-chat response suppresses the push after worker restart');
pageVisible = false;
await dispatchPush();
assert.equal(shownNotifications.length, 1, 'a fresh hidden-chat response still shows the push');
pageVisible = true;
pageResponds = false;
await dispatchPush('tool_authorization');
assert.equal(shownNotifications.length, 2, 'a suspended PWA with stale visible client state does not suppress an authorization push');
console.log('push notifications: 34 assertions passed');
})().catch((err) => {
console.error(err);
process.exitCode = 1;
});
