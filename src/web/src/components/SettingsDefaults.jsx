// mouaif web — SettingsDefaultsView
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { loadApp, saveApp, setStatus } from '../api.js';

export function SettingsDefaultsView() {
  const promptSize = useRef(null);
  const saveBtn = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    try {
      const app = await loadApp({ force: true });
      if (promptSize.current) promptSize.current.value = (app.app && app.app.promptSize) || 'average';
    } catch (e) { setStatus(statusEl, 'load failed: ' + e.message, 'error'); }
  }

  async function save() {
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    try {
      await saveApp({ promptSize: promptSize.current.value });
      setStatus(statusEl, 'saved.', 'success');
    } catch (e) { setStatus(statusEl, 'save failed: ' + e.message, 'error'); }
    if (saveBtn.current) saveBtn.current.disabled = false;
  }

  useEffect(() => { load(); }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'App defaults')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Defaults applied to new chats. Each chat can override these.'),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'sd-prompt-size' }, 'Default prompt size'),
        h('select', { ref: promptSize, class: 'input', id: 'sd-prompt-size' },
          h('option', { value: 'very-small' }, 'very-small'),
          h('option', { value: 'average' }, 'average'),
          h('option', { value: 'extensive' }, 'extensive')
        )
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, 'Save'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}