// mouaif web — global notification store
//
// Signal-driven notification queue. Every module in the app pushes
// notifications here; the NotificationsOverlay component renders
// them as a stacked overlay on mobile.
//
// Notification shapes:
//   { id, type: 'info'|'success'|'error'|'progress'|'auth'|'ask',
//     title?, message?, progress?, progressMax?, buttons?, onAnswer?,
//     autoClose? (default true for info/success/error) }

import { signal } from '@preact/signals';

export const notifications = signal([]);

let nextId = 0;

export function addNotification(n) {
  // Honor a caller-supplied id so live notifications (e.g. progress bars
  // keyed by `progress-<callId>`) can be updated/removed later. Fall back
  // to an incrementing id otherwise.
  const id = n.id != null ? String(n.id) : String(++nextId);
  notifications.value = [...notifications.value, { ...n, id }];
  if (n.autoClose !== false && n.type !== 'progress' && n.type !== 'auth' && n.type !== 'ask') {
    setTimeout(() => removeNotification(id), 4000);
  }
  return id;
}

export function removeNotification(id) {
  notifications.value = notifications.value.filter(n => n.id !== id);
}

export function updateNotification(id, patch) {
  notifications.value = notifications.value.map(n => n.id === id ? { ...n, ...patch } : n);
}

export function clearNotifications() {
  notifications.value = [];
}
