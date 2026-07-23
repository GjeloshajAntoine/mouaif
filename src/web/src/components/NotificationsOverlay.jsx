// mouaif web — Global notification overlay
//
// Renders stacked toast/progress/auth notifications on top of the
// app shell. Reads from the `notifications` signal; every other
// module pushes items via addNotification / updateNotification.
//
// Mobile-first: stacked at bottom of viewport, scrollable when
// multiple notifications are visible. Auth/ask cards show their
// inline action buttons; progress cards show a percentage bar.

import { h } from 'preact';
import { notifications, removeNotification } from './notifications.js';

function ProgressBar({ current, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return h('div', { class: 'notif__progress-bar', role: 'progressbar', 'aria-valuenow': current, 'aria-valuemin': 0, 'aria-valuemax': total },
    h('div', { class: 'notif__progress-fill', style: 'width:' + pct + '%' }),
    h('span', { class: 'notif__progress-label' }, pct + '%')
  );
}

function NotifItem({ n }) {
  const { id, type, title, message, progress, progressMax, buttons } = n;
  const icon = type === 'success' ? '\u2713'
    : type === 'error' ? '\u2717'
    : type === 'progress' ? '\u21BB'
    : type === 'auth' ? '\u26A0'
    : type === 'ask' ? '?' : '\u2139';

  return h('div', {
    class: 'notif notif--' + (type || 'info'),
    'data-notif-id': id,
    role: type === 'auth' || type === 'ask' ? 'dialog' : 'status',
    'aria-live': type === 'progress' ? 'polite' : 'assertive'
  },
    h('div', { class: 'notif__head' },
      h('span', { class: 'notif__icon', 'aria-hidden': 'true' }, icon),
      title ? h('span', { class: 'notif__title' }, title) : null,
      type !== 'auth' && type !== 'ask' && type !== 'progress'
        ? h('button', {
            type: 'button',
            class: 'notif__close',
            'aria-label': 'Dismiss',
            onClick: () => removeNotification(id)
          }, '\u00D7')
        : null
    ),
    message ? h('div', { class: 'notif__message' }, message) : null,
    type === 'progress' && progress != null
      ? h(ProgressBar, { current: progress, total: progressMax })
      : null,
    buttons && buttons.length
      ? h('div', { class: 'notif__actions' },
          buttons.map((b, i) =>
            h('button', {
              key: i,
              type: 'button',
              class: 'notif__btn' + (b.primary ? ' notif__btn--primary' : '') + (b.danger ? ' notif__btn--danger' : ''),
              onClick: () => { b.onClick && b.onClick(); if (b.close !== false) removeNotification(id); }
            }, b.label)
          )
        )
      : null
  );
}

export function NotificationsOverlay() {
  const items = notifications.value;
  if (!items.length) return null;
  return h('div', { class: 'notif-overlay', role: 'log', 'aria-label': 'Notifications' },
    items.map(n => h(NotifItem, { key: n.id, n }))
  );
}

// ---- Convenience helpers used outside JSX (imperative modules) ----
// These return { notificationId } so callers can update progress later.

export function showProgress(title, message, current, total) {
  return addNotification({ type: 'progress', title, message, progress: current, progressMax: total, autoClose: false });
}

export function updateProgress(id, current, total, message) {
  updateNotification(id, { progress: current, progressMax: total, message });
}

export function removeProgress(id) {
  // Complete progress notifications linger briefly so the user sees 100%,
  // then auto-remove.
  updateNotification(id, { progress: 1, progressMax: 1, message: 'complete' });
  setTimeout(() => removeNotification(id), 1500);
}

export function showToast(type, title, message) {
  return addNotification({ type, title, message, autoClose: true });
}
