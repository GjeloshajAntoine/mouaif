// Draft Craft — pick any project chat and append text and/or an image to its draft.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';

function chatLabel(chat) {
const title = chat && typeof chat.title === 'string' ? chat.title.trim() : '';
return title || 'New chat';
}
function chatMeta(chat) {
const raw = chat && (chat.lastOpenedAt || chat.createdAt);
if (!raw) return '';
const date = new Date(raw);
if (Number.isNaN(date.getTime())) return '';
return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function loadAllChats(projectDir) {
const rows = [];
const pageSize = 100;
let total = Infinity;
while (rows.length < total) {
const r = await fetchJson('/api/chats?projectDir=' + encodeURIComponent(projectDir) + '&offset=' + rows.length + '&limit=' + pageSize);
if (r.status !== 200 || !r.body) throw new Error('Could not load chats.');
const page = Array.isArray(r.body.chats) ? r.body.chats : [];
total = typeof r.body.total === 'number' ? r.body.total : rows.length + page.length;
rows.push(...page);
if (!page.length || page.length < pageSize) break;
}
return rows;
}

export function DraftCraftSheet({ open, payload, onClose, onAdded, placement = 'bottom' }) {
const [projects, setProjects] = useState([]);
const [projectDir, setProjectDir] = useState('');
const [chats, setChats] = useState([]);
const [chatId, setChatId] = useState('');
const [loading, setLoading] = useState(false);
const [saving, setSaving] = useState(false);
const [status, setStatus] = useState('');

useEffect(() => {
if (!open) return;
let cancelled = false;
setLoading(true);
setStatus('Loading projects…');
fetchJson('/api/projects/registered').then((r) => {
if (cancelled) return;
const list = r.status === 200 && r.body ? (r.body.projects || []) : [];
setProjects(list);
const preferred = payload && payload.projectDir;
const first = list.find((project) => project.path === preferred) || list[0];
setProjectDir(first ? first.path : '');
setStatus(list.length ? '' : 'Add a project before using Draft Craft.');
setLoading(false);
}).catch(() => {
if (!cancelled) {
setProjects([]);
setStatus('Could not load projects.');
setLoading(false);
}
});
return () => { cancelled = true; };
}, [open, payload]);

useEffect(() => {
if (!open || !projectDir) {
setChats([]);
setChatId('');
return;
}
let cancelled = false;
setLoading(true);
setStatus('Loading chats…');
loadAllChats(projectDir).then((list) => {
if (cancelled) return;
setChats(list);
setChatId((current) => list.some((chat) => chat.id === current) ? current : '');
setStatus(list.length ? '' : 'This project has no chats yet.');
setLoading(false);
}).catch(() => {
if (!cancelled) {
setChats([]);
setChatId('');
setStatus('Could not load chats.');
setLoading(false);
}
});
return () => { cancelled = true; };
}, [open, projectDir]);

if (!open) return null;
const hasText = !!(payload && typeof payload.text === 'string' && payload.text.trim());
const hasImage = !!(payload && payload.image && payload.image.dataUrl);
const textLabel = payload && payload.textLabel ? payload.textLabel : 'selected code';

async function addToDraft() {
if (!projectDir || !chatId || (!hasText && !hasImage) || saving) return;
setSaving(true);
setStatus('Adding to draft…');
try {
const get = await fetchJson('/api/chats/' + encodeURIComponent(chatId) + '?projectDir=' + encodeURIComponent(projectDir));
if (get.status !== 200 || !get.body || !get.body.chat) throw new Error('Could not read the chat draft.');
const chat = get.body.chat;
const patch = { projectDir };
if (hasText) {
const before = typeof chat.draft === 'string' ? chat.draft.trimEnd() : '';
patch.draft = before ? before + '\n\n' + payload.text.trim() : payload.text.trim();
}
if (hasImage) {
const attachments = Array.isArray(chat.draftAttachments) ? chat.draftAttachments.slice() : [];
patch.draftAttachments = attachments.concat([payload.image]).slice(0, 8);
}
const update = await fetchJson('/api/chats/' + encodeURIComponent(chatId), {
method: 'PATCH',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(patch)
});
if (update.status !== 200) throw new Error((update.body && update.body.error) || 'Could not update the draft.');
setStatus('Added with Draft Craft.');
setSaving(false);
if (onAdded) onAdded({ projectDir, chatId, chat: update.body.chat });
} catch (error) {
setStatus(error && error.message ? error.message : 'Draft Craft failed.');
setSaving(false);
}
}

return h('div', { class: 'draft-craft__overlay draft-craft__overlay--' + placement, role: 'presentation', onClick: onClose },
h('section', {
class: 'draft-craft__sheet',
role: 'dialog',
'aria-modal': 'true',
'aria-labelledby': 'draftCraftTitle',
onClick: (event) => event.stopPropagation()
},
h('div', { class: 'draft-craft__handle', 'aria-hidden': 'true' }),
h('div', { class: 'draft-craft__head' },
h('div', null,
h('h2', { id: 'draftCraftTitle' }, 'Draft Craft'),
h('p', null, hasImage && hasText ? 'Add the annotated image and note to any chat draft.' : hasImage ? 'Add the annotated Inspector image to any chat draft.' : 'Add selected file code to any chat draft.')
),
h('button', { class: 'draft-craft__close', type: 'button', onClick: onClose, 'aria-label': 'Close Draft Craft' }, '×')
),
h('div', { class: 'draft-craft__content' },
h('label', { class: 'draft-craft__field' },
h('span', null, 'Project'),
h('select', { class: 'input', value: projectDir, onChange: (event) => setProjectDir(event.currentTarget.value), disabled: loading || saving },
projects.map((project) => h('option', { key: project.id || project.path, value: project.path }, project.name || project.path))
)
),
h('div', { class: 'draft-craft__field' },
h('span', null, 'Chats'),
h('ul', { class: 'draft-craft__chats', 'aria-label': 'Choose a chat' },
loading
? h('li', { class: 'draft-craft__chat-empty' }, 'Loading chats…')
: chats.length
? chats.map((chat) => h('li', { key: chat.id },
h('button', {
class: 'draft-craft__chat' + (chatId === chat.id ? ' is-selected' : ''),
type: 'button',
onClick: () => setChatId(chat.id),
disabled: saving,
'aria-pressed': String(chatId === chat.id)
},
h('span', { class: 'draft-craft__chat-title' }, chatLabel(chat)),
h('span', { class: 'draft-craft__chat-meta' }, chatMeta(chat))
)
))
: h('li', { class: 'draft-craft__chat-empty' }, 'No chats in this project.')
)
),
h('div', { class: 'draft-craft__summary' },
h('strong', null, 'Adding'),
h('span', null, [hasImage ? 'annotated image' : '', hasText ? textLabel : ''].filter(Boolean).join(' + ') || 'nothing')
),
h('p', { class: 'status draft-craft__status', role: 'status', 'aria-live': 'polite' }, status)
),
h('div', { class: 'draft-craft__actions' },
h('button', { class: 'btn btn--ghost', type: 'button', onClick: onClose, disabled: saving }, 'Cancel'),
h('button', { class: 'btn btn--primary', type: 'button', onClick: addToDraft, disabled: loading || saving || !chatId || (!hasText && !hasImage) }, saving ? 'Adding…' : 'Add to draft')
)
)
);
}
