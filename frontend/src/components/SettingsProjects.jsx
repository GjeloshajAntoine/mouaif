// mouaif web — SettingsProjectsView
//
// Registered projects listed under Settings, so the project registry is
// reachable from the Settings tab (not only the Chats tab). Each row links
// to that project's settings and carries a small overflow menu for rename /
// unregister — the same two actions available from the project cards on the
// Chats tab. "Add project" opens the existing folder picker.
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { useClickOutside } from '../hooks/useClickOutside.js';

function RowMenu({ project, onRename, onUnregister }) {
const [open, setOpen] = useState(false);
const menuRef = useRef(null);
useClickOutside(menuRef, () => setOpen(false), open);
return h('div', { ref: menuRef, class: 'sprojects__menu' },
h('button', {
class: 'sprojects__menu-btn',
type: 'button',
'aria-haspopup': 'true',
'aria-expanded': String(open),
'aria-label': 'Project options for ' + (project.name || project.path),
onClick: (e) => { e.stopPropagation(); setOpen(!open); }
}, '⋯'),
h('div', {
class: 'sprojects__menu-pop',
hidden: !open,
role: 'menu',
onClick: e => e.stopPropagation()
},
h('button', { type: 'button', onClick: () => { setOpen(false); onRename(project); } }, 'Rename…'),
h('button', { type: 'button', 'data-danger': '1', onClick: () => { setOpen(false); onUnregister(project); } }, 'Unregister')
)
);
}

export function SettingsProjectsView() {
const [projects, setProjects] = useState(null);
const [statusText, setStatusText] = useState('loading…');
const [statusType, setStatusType] = useState('busy');

async function load() {
setStatusText('loading…');
setStatusType('busy');
try {
const r = await fetchJson('/api/projects/registered');
if (r.status !== 200) {
setStatusText('HTTP ' + r.status);
setStatusType('error');
return;
}
const list = r.body.projects || [];
setProjects(list);
setStatusText(list.length + (list.length === 1 ? ' project' : ' projects'));
setStatusType(list.length ? 'success' : '');
} catch {
setStatusText('network error');
setStatusType('error');
}
}

useEffect(() => { load(); }, []);

async function renameProject(project) {
const next = prompt('Rename project', project.name || project.path);
if (next == null) return;
const trimmed = next.trim();
if (!trimmed || trimmed === project.name) return;
const r = await fetchJson('/api/projects/registered/' + encodeURIComponent(project.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: trimmed }) });
if (r.status !== 200) { alert('rename failed: HTTP ' + r.status); return; }
load();
}

async function unregisterProject(project) {
if (!confirm('Unregister project "' + (project.name || project.path) + '"? The folder on disk is not touched.')) return;
const r = await fetchJson('/api/projects/registered/' + encodeURIComponent(project.id), { method: 'DELETE' });
if (r.status !== 200) { alert('unregister failed: HTTP ' + r.status); return; }
load();
}

return h(Fragment, null,
h('div', { class: 'view-head' },
h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
h('h2', { class: 'view-title' }, 'Projects')
),
h('p', { class: 'hint hint--compact' }, 'Projects the app remembers. Removing one only unregisters it — the folder on disk is never touched.'),
h('div', { class: 'page-bar' },
h('span', { class: 'status page-bar__status' + (statusType ? ' status--' + statusType : ''), 'aria-live': 'polite' }, statusText),
h('a', { href: '#/projects/new', class: 'page-bar__add', 'aria-label': 'Add project' }, '+')
),
h('ul', { class: 'sprojects__list', 'aria-label': 'Registered projects' },
projects === null ? null :
projects.length === 0 ? h('li', { class: 'sprojects__empty' }, 'No projects yet. Tap "+" to register a folder on disk.') :
projects.map(p => h('li', { class: 'sprojects__row', key: p.id },
h('a', {
class: 'sprojects__main',
href: '#/settings/project?projectDir=' + encodeURIComponent(p.path),
'aria-label': 'Project settings for ' + (p.name || p.path)
},
h('div', { class: 'sprojects__name' }, p.name || p.path),
h('div', { class: 'sprojects__meta' }, p.path)
),
h('span', { class: 'sprojects__chev', 'aria-hidden': 'true' }, '›'),
h(RowMenu, { project: p, onRename: renameProject, onUnregister: unregisterProject })
))
)
);
}
