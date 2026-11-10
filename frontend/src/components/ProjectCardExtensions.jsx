// mouaif web — extension rows on a project card (docs/features/extensions.md)
//
// The `project.card` slot: one chip per active extension view of that
// project, under its chat list. Tapping a chip opens the view in a sheet with
// no chat (ExtensionSheet, loaded on first use so the project list stays
// light). `?safe` shows none.
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { safeMode } from '../theme/runtime.js';

const EXTENSIONS_CHANGED = 'mouaif:extensions-changed';

export function ProjectCardExtensions({ projectDir }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  const [Sheet, setSheet] = useState(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (safeMode || !projectDir) { setList([]); return undefined; }
    let stopped = false;
    fetchJson('/api/extensions/surfaces?projectDir=' + encodeURIComponent(projectDir) + '&slot=project.card')
      .then((r) => { if (!stopped && r.status === 200) setList(r.body.surfaces || []); }, () => {});
    return () => { stopped = true; };
  }, [projectDir, refresh]);
  useEffect(() => {
    const bump = () => setRefresh((n) => n + 1);
    window.addEventListener(EXTENSIONS_CHANGED, bump);
    return () => window.removeEventListener(EXTENSIONS_CHANGED, bump);
  }, []);
  useEffect(() => {
    if (!open || Sheet) return;
    import('./chat/ExtensionSheet.jsx').then((m) => setSheet(() => m.ExtensionSheet), () => setOpen(null));
  }, [open, Sheet]);
  if (!list.length) return null;
  return h(Fragment, null,
    h('div', { class: 'project-card__extensions', role: 'group', 'aria-label': 'Extensions' },
      list.map((s) => h('button', { key: s.extensionId + '/' + s.surfaceId, type: 'button', class: 'project-card__extension',
        'aria-haspopup': 'dialog', onClick: () => setOpen(s), title: s.extensionName },
      h('span', { class: 'project-card__extension-icon', 'aria-hidden': 'true' }, '\u{1F9E9}'), s.title))),
    open && Sheet ? h(Sheet, { projectDir, surface: open, onClose: () => setOpen(null) }) : null);
}
