'use strict';

// Shared attention channel for model-driven and direct composer tools.
// Sending is server-side: leaving the page or losing its response stream
// must not prevent a pending approval/question from reaching Web Push.
const push = require('./push.js');
const settings = require('./settings.js');
const { resolveNotificationPrefs } = require('./notifications.js');

function notifyAttention({ sessionId, projectDir, chatId, name, data, preferences }) {
  if (!sessionId || !projectDir || !chatId) return;
  if (name !== 'authorization_required' && name !== 'ask_user_required') return;
  const prefs = preferences || resolveNotificationPrefs(settings.getApp().notifications);
  if (prefs.authorization === false) return;
  const question = name === 'ask_user_required';
  const kind = question ? 'ask_user' : 'tool_authorization';
  const request = data || {};
  const options = question && request.multiSelect !== true && Array.isArray(request.options) && request.options.length === 2
    ? request.options.map((option) => ({ label: String(option.label || '').slice(0, 40), value: String(option.value || '').slice(0, 120) }))
    : [];
  const actions = [];
  if (prefs.quickActions !== false) {
    if (!question) {
      actions.push({ action: 'allow-once', title: 'Allow once' });
      actions.push({ action: 'deny', title: 'Deny' });
    } else {
      options.forEach((option, i) => {
        if (option.label && option.value) actions.push({ action: 'answer-' + i, title: option.label });
      });
    }
  }
  if (!actions.length) actions.push({ action: 'open', title: 'Open chat' });
  push.sendPushToSession(sessionId, {
    title: question ? 'The chat needs your answer' : 'Authorization needed',
    body: question
      ? (request.question ? String(request.question).slice(0, 240) : 'Open the chat to answer.')
      : (request.tool || 'A tool') + ' is waiting for approval.',
    tag: 'chat-' + chatId + '-attention',
    chatId,
    projectDir,
    data: {
      kind, chatId, projectDir,
      url: `/#/chat/${chatId}?projectDir=${encodeURIComponent(projectDir)}`,
      callId: request.callId,
      tool: question ? 'ask_user' : request.tool,
      ...(question ? { options } : {})
    },
    actions,
    requireInteraction: true
  });
}

module.exports = { notifyAttention };
