'use strict';
// App-level browser notification preferences.
//
// The persisted `notifications` object has grown over time. Older stores
// held five booleans (progress/completion/errors and
// askUser/toolAuthorization); the current shape is a flat set of named
// channels. This module is the single server-side normalizer so every
// sender (chat streaming, access sign-in) agrees on the defaults.
//
// Kept in sync with normalizePreferences() in
// frontend/src/components/SettingsNotifications.jsx.
const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
// One replaceable ASCII status per chat: progress, completion, errors.
status: true,
// Questions and tool-authorization requests (the "attention" slot).
authorization: true,
// Answer/allow/deny directly from the notification when supported.
quickActions: true,
// A sign-in to this server (password or passkey). On by default: a new
// sign-in is exactly the event a user wants to know about, and it can be
// turned off from Settings → Notifications.
login: true
});

// resolveNotificationPrefs(saved) — collapse the persisted settings into
// the current key shape. New stores hold these keys directly; older
// stores only had the legacy five booleans, which are derived here.
function resolveNotificationPrefs(saved) {
const prefs = saved || {};
return {
status: prefs.status !== undefined
? prefs.status === true
: prefs.progress !== false && prefs.completion !== false && prefs.errors !== false,
authorization: prefs.authorization !== undefined
? prefs.authorization === true
: prefs.askUser !== false && prefs.toolAuthorization !== false,
quickActions: prefs.quickActions !== false,
login: prefs.login !== undefined ? prefs.login === true : DEFAULT_NOTIFICATION_PREFS.login
};
}

// notificationEnabled(saved, key) — resolve + read one channel in a single
// step for callers that only care about a boolean gate.
function notificationEnabled(saved, key) {
return resolveNotificationPrefs(saved)[key] === true;
}

module.exports = {
DEFAULT_NOTIFICATION_PREFS,
resolveNotificationPrefs,
notificationEnabled
};
