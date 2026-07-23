// mouaif web — SettingsDefaultsView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, saveApp, setStatus } from '../api.js';
import { pushSupported, pushPermission, pushEnabled, requestPushPermission, unsubscribePush, syncPushState } from './push.js';

export function SettingsDefaultsView() {
  const promptSize = useRef(null);
  const chatStorage = useRef(null);
  const saveBtn = useRef(null);
  const statusEl = useRef(null);
  const pushStatus = useRef(null);

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (promptSize.current) promptSize.current.value = (app.app && app.app.promptSize) || 'average';
      if (chatStorage.current) chatStorage.current.value = (app.app && app.app.chatStorage) || 'db';
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); }
    await syncPushState();
  }

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    try {
      await saveApp({ promptSize: promptSize.current.value, chatStorage: chatStorage.current.value });
      setStatus(statusEl, 'saved.', 'success');
    } catch (e) { setStatus(statusEl, 'save failed: ' + e.message, 'error'); }
    if (saveBtn.current) saveBtn.current.disabled = false;
  }

  async function handlePushToggle() {
    if (pushEnabled.value) {
      await unsubscribePush();
      setStatus(pushStatus, 'Push notifications disabled', 'success');
    } else {
      const ok = await requestPushPermission();
      setStatus(pushStatus, ok ? 'Push notifications enabled' : 'Could not enable push notifications', ok ? 'success' : 'error');
    }
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'App defaults')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'How much tool schema and instruction text the model receives. Smaller = less context used, faster replies.'),
      h('p', { class: 'hint hint--compact' }, 'This applies to every project. A project or a single chat can pick a different style for itself.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sd-prompt-size' }, 'Default prompt style'),
        h('select', { ref: promptSize, class: 'input', id: 'sd-prompt-size' },
          h('option', { value: 'very-small' }, 'Very small — tool names only, no schemas'),
          h('option', { value: 'average' }, 'Average — full tools, recommended'),
          h('option', { value: 'extensive' }, 'Extensive — full tools + best-practice guidance')
        )
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sd-chat-storage' }, 'Chat storage'),
        h('select', { ref: chatStorage, class: 'input', id: 'sd-chat-storage' },
          h('option', { value: 'db' }, 'Database (SQLite) — default, fast'),
          h('option', { value: 'json' }, 'JSON files — legacy, hand-editable')
        )
      ),
      h('p', { class: 'hint hint--compact' }, '"Database" stores chats and messages in the app SQLite store. "JSON files" keeps the legacy per-chat .mouaif.messages.*.json files. Changing this does not migrate existing data; use the Import tool to reimport JSON files into the DB.'),
      
      // Push notifications
      pushSupported.value
        ? h('div', { class: 'group' },
            h('div', { class: 'group__title' }, 'Push notifications'),
            h('div', { class: 'group__list' },
              h('div', { class: 'group__row' },
                h('div', { class: 'group__row-body' },
                  h('span', { class: 'group__row-label' }, 'Browser push notifications'),
                  h('span', { class: 'group__row-detail' },
                    pushPermission.value === 'granted'
                      ? (pushEnabled.value ? 'Enabled' : 'Permission granted, not subscribed')
                      : (pushPermission.value === 'denied' ? 'Blocked in browser settings' : 'Permission not requested')
                  )
                ),
                h('div', { class: 'group__row-actions' },
                  h('button', {
                    type: 'button',
                    class: 'btn btn--small' + (pushEnabled.value ? ' btn--danger' : ' btn--primary'),
                    onClick: handlePushToggle,
                    'aria-label': pushEnabled.value ? 'Disable push notifications' : 'Enable push notifications'
                  }, pushEnabled.value ? 'Disable' : 'Enable')
                )
              )
            ),
            h('p', { class: 'hint hint--compact' }, 'Receive OS-level notifications for chat progress, completion, and errors even when the tab is backgrounded or closed.')
          )
        : null,

      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, 'Save'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      ),
      h('span', { ref: pushStatus, class: 'status', 'aria-live': 'polite' })
    )
  );
}