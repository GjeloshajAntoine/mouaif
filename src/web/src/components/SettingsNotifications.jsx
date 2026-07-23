// mouaif web — browser notification settings
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, loadApp, saveApp } from '../api.js';
import {
  pushSupported,
  pushPermission,
  pushEnabled,
  requestPushPermission,
  unsubscribePush,
  syncPushState
} from './push.js';

const DEFAULTS = Object.freeze({
  askUser: true,
  toolAuthorization: true,
  completion: true,
  errors: true,
  progress: true,
  quickActions: true
});

export function SettingsNotificationsView() {
  const [prefs, setPrefs] = useState(DEFAULTS);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState('Checking this browser…');
  const [statusState, setStatusState] = useState('busy');
  const [pushConfig, setPushConfig] = useState(null);

  async function load() {
    setBusy(true);
    try {
      const app = await loadApp({ force: true });
      setPrefs({ ...DEFAULTS, ...((app.app && app.app.notifications) || {}) });
      const configResponse = await fetchJson('/api/push/config');
      if (configResponse.status !== 200) throw new Error((configResponse.body && configResponse.body.error) || 'Push key configuration failed');
      setPushConfig(configResponse.body);
      if (pushSupported.value) await syncPushState();
      setStatus(pushSupported.value
        ? (pushPermission.value === 'denied'
            ? 'Permission is blocked in browser settings.'
            : (pushEnabled.value ? 'Notifications are enabled on this browser.' : 'Notifications are not enabled on this browser.'))
        : 'Web Push is not supported by this browser.');
      setStatusState(pushEnabled.value ? 'success' : '');
    } catch (err) {
      setStatus('Could not load notification settings: ' + err.message);
      setStatusState('error');
    }
    setBusy(false);
  }

  async function toggleDelivery() {
    setBusy(true);
    if (pushEnabled.value) {
      await unsubscribePush();
      setStatus('Notifications disabled on this browser.');
      setStatusState('success');
    } else {
      const ok = await requestPushPermission();
      setStatus(ok
        ? 'Notifications enabled on this browser.'
        : (pushPermission.value === 'denied'
            ? 'Permission is blocked. Allow notifications in browser settings, then try again.'
            : 'Could not enable notifications.'));
      setStatusState(ok ? 'success' : 'error');
    }
    setBusy(false);
  }

  async function changePreference(key, checked) {
    const next = { ...prefs, [key]: checked };
    setPrefs(next);
    setBusy(true);
    try {
      await saveApp({ notifications: next });
      setStatus('Notification preferences saved.');
      setStatusState('success');
    } catch (err) {
      setPrefs(prefs);
      setStatus('Save failed: ' + err.message);
      setStatusState('error');
    }
    setBusy(false);
  }

  async function sendTest() {
    setBusy(true);
    try {
      const response = await fetchJson('/api/push/test', { method: 'POST' });
      if (response.status !== 200) throw new Error('HTTP ' + response.status);
      setStatus('Test notification sent.');
      setStatusState('success');
    } catch (err) {
      setStatus('Test failed: ' + err.message);
      setStatusState('error');
    }
    setBusy(false);
  }

  useEffect(() => { load(); }, []);

  function eventRow(key, label, detail) {
    return h('label', { class: 'group__row settings-notifications__event' },
      h('span', { class: 'group__row-body' },
        h('span', { class: 'group__row-label' }, label),
        h('span', { class: 'group__row-detail' }, detail)
      ),
      h('input', {
        type: 'checkbox',
        class: 'checkbox',
        checked: prefs[key] === true,
        disabled: busy,
        onChange: (event) => changePreference(key, event.currentTarget.checked)
      })
    );
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Notifications')
    ),
    h('section', { class: 'settings-notifications' },
      h('p', { class: 'hint hint--compact' },
        'Follow a running chat from browser notifications. Attention alerts stay visible when the model needs an answer or tool approval.'),
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'This browser'),
        h('div', { class: 'group__list' },
          h('div', { class: 'group__row' },
            h('span', { class: 'group__row-body' },
              h('span', { class: 'group__row-label' }, 'Web notifications'),
              h('span', { class: 'group__row-detail' },
                !pushSupported.value ? 'Not supported'
                  : pushPermission.value === 'denied' ? 'Blocked by browser'
                    : pushEnabled.value ? 'Enabled' : 'Disabled')
            ),
            pushSupported.value
              ? h('button', {
                  type: 'button',
                  class: 'btn btn--small' + (pushEnabled.value ? ' btn--danger' : ' btn--primary'),
                  disabled: busy || pushPermission.value === 'denied',
                  onClick: toggleDelivery
                }, pushEnabled.value ? 'Disable' : 'Enable')
              : null
          )
        ),
        h('div', { class: 'settings-notifications__actions' },
          h('button', {
            type: 'button',
            class: 'btn',
            disabled: busy || !pushEnabled.value,
            onClick: sendTest
          }, 'Send test notification')
        ),
        h('p', { class: 'status', 'data-state': statusState, 'aria-live': 'polite' }, status)
      ),
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Server configuration'),
        h('div', { class: 'group__list' },
          h('div', { class: 'group__row' },
            h('span', { class: 'group__row-body' },
              h('span', { class: 'group__row-label' }, 'Served origin'),
              h('span', { class: 'group__row-detail settings-notifications__value' }, pushConfig && pushConfig.origin ? pushConfig.origin : window.location.origin)
            )
          ),
          h('div', { class: 'group__row' },
            h('span', { class: 'group__row-body' },
              h('span', { class: 'group__row-label' }, 'Web Push keys'),
              h('span', { class: 'group__row-detail' }, pushConfig && pushConfig.privateKeyConfigured ? 'Configured automatically' : 'Not configured')
            )
          ),
          h('div', { class: 'group__row' },
            h('span', { class: 'group__row-body' },
              h('span', { class: 'group__row-label' }, 'VAPID contact'),
              h('span', { class: 'group__row-detail settings-notifications__value' }, pushConfig ? pushConfig.subject : 'Checking…')
            )
          )
        ),
        h('p', { class: 'hint hint--compact' },
          'Keys are generated once and reused. iPhone and iPad use these standard Web Push keys through Apple Push Notification service; Apple developer keys are not required.')
      ),
      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Chat events'),
        h('div', { class: 'group__list' },
          eventRow('askUser', 'Questions from the model', 'Answer two-choice questions directly when supported.'),
          eventRow('toolAuthorization', 'Tool authorization', 'Allow once or deny without reopening the chat.'),
          eventRow('completion', 'Response completed', 'Know when a background chat has finished.'),
          eventRow('progress', 'Progress updates', 'Receive per-chat progress status from the model.'),
          eventRow('errors', 'Chat errors', 'Be alerted when a background run fails.'),
          eventRow('quickActions', 'Notification actions', 'Show safe quick actions on supported browsers.')
        )
      ),
      h('p', { class: 'hint hint--compact' },
        'When the target chat is already focused, the service worker suppresses its OS notification. Longer questions and multi-select answers open the full chat. On iPhone and iPad, install mouaif to the Home Screen before enabling notifications.')
    )
  );
}
