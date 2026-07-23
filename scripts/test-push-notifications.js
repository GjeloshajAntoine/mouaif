'use strict';

// Unit coverage for subscription rebinding and interactive payloads. No
// network is used: web-push is replaced with a synchronous recorder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MOUAIF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-push-home-'));

const webpush = require('web-push');
const deliveries = [];
webpush.sendNotification = (subscription, payload) => {
  deliveries.push({ subscription, payload: JSON.parse(payload) });
  return Promise.resolve();
};

const push = require('../src/push.js');
push.ensureTable();
push.ensureVapidKeys();

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
    url: '/web/#/chat/abcd1234'
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

console.log('push notifications: 11 assertions passed');
