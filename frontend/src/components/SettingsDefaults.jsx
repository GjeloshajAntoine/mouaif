// mouaif web — SettingsDefaultsView
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { loadApp, saveApp } from '../api.js';
export function SettingsDefaultsView() {
const [promptSize, setPromptSize] = useState('average');
const [enterForNewline, setEnterForNewline] = useState(true);
const [isSaving, setIsSaving] = useState(false);
const [status, setStatusObj] = useState({ message: '', type: '' });
async function load() {
try {
const app = await loadApp({ force: true });
setPromptSize((app.app && app.app.promptSize) || 'average');
setEnterForNewline(app.app && typeof app.app.enterForNewline === 'boolean' ? app.app.enterForNewline : true);
} catch (e) { setStatusObj({ message: 'load failed: ' + e.message, type: 'error' }); }
}
async function save() {
setIsSaving(true);
setStatusObj({ message: 'saving…', type: 'busy' });
try {
await saveApp({ promptSize, enterForNewline });
setStatusObj({ message: 'saved.', type: 'success' });
} catch (e) { setStatusObj({ message: 'save failed: ' + e.message, type: 'error' }); }
setIsSaving(false);
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
h('select', { class: 'input', id: 'sd-prompt-size', value: promptSize, onChange: e => setPromptSize(e.target.value) },
h('option', { value: 'very-small' }, 'Very small — tool names only, no schemas'),
h('option', { value: 'average' }, 'Average — full tools, recommended'),
h('option', { value: 'extensive' }, 'Extensive — full tools + best-practice guidance')
)
),
h('div', { class: 'row row--inline' },
h('label', { class: 'switch' },
h('input', {
id: 'sd-enter-newline',
type: 'checkbox',
role: 'switch',
'aria-checked': String(enterForNewline),
checked: enterForNewline,
onChange: (e) => setEnterForNewline(e.currentTarget.checked)
}),
h('span', { class: 'switch__track', 'aria-hidden': 'true' },
h('span', { class: 'switch__thumb' })
)
),
h('label', { class: 'label', for: 'sd-enter-newline' }, 'Enter inserts a newline instead of sending')
),
h('p', { class: 'hint hint--compact' }, 'When on, Enter adds a new line and you send with the send button or Ctrl/Cmd+Enter. Turn it off to send with Enter (Shift+Enter for a new line).'),
h('p', { class: 'hint hint--compact' }, 'Chats and messages are stored in the app database. To keep a chat history you can commit, turn on tracing for that chat in project settings — it writes a project-local trace file you can add to source control.'),
h('div', { class: 'row row--actions' },
h('button', { class: 'btn btn--primary', type: 'button', onClick: save, disabled: isSaving }, 'Save'),
h('span', { class: `status${status.type ? ' status--' + status.type : ''}`, 'aria-live': 'polite' }, status.message)
)
)
);
}
