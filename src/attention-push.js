'use strict';

// Shared attention channel for model-driven and direct composer tools.
// Sending is server-side: leaving the page or losing its response stream
// must not prevent a pending approval/question from reaching Web Push.
const push = require('./push.js');
const settings = require('./settings.js');
const chats = require('./chats.js');
const { resolveNotificationPrefs } = require('./notifications.js');

// `broadcast` is for a turn nobody's browser started (a recurring task's run):
// it has no push session, so the alert goes to every subscribed device.
// `attention` hooks (src/hooks.js) run first and may suppress the push.
// `origin` is the turn's origin kind for their `Sent by` match.
function notifyAttention({ sessionId, projectDir, chatId, name, data, preferences, broadcast, origin }) {
  if ((!sessionId && !broadcast) || !projectDir || !chatId) return;
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
  // Use the current chat name for every sender, including direct commands
  // and nested agents. A missing/deleted chat must not block an alert.
  let chatTitle = '';
  try {
    const chat = chats.getChat(projectDir, chatId);
    chatTitle = (chat && chat.title) || '';
  } catch { /* best-effort metadata */ }
  const send = (o) => (sessionId ? push.sendPushToSession(sessionId, o) : push.sendPushToAll(o));
  const message = {
    title: chatTitle || (question ? 'The chat needs your answer' : 'Authorization needed'),
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
  };
  const hooks = require('./hooks.js');
  if (!hooks.hasHooks('attention')) { send(message); return; }
  hooks.runHooks('attention', { origin: { kind: (origin && origin.kind) || 'user' }, kind, tool: message.data.tool || '' },
    { projectDir, chatId, cwd: projectDir })
    .then((o) => { if (!o.suppress) send(message); }, () => send(message));
}

module.exports = { notifyAttention };
