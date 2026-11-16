// mouaif web — a small "Extensions" menu for one slot (docs/features/extensions.md)
//
// Used by the slots that open a view as a sheet from somewhere outside the
// chat's own menus: `app.panel` (app header), `files.action` (file editor),
// `git.action` (Git sheet) and `inspector.panel` (Inspector). It renders
// nothing when no active extension uses the slot (or with `?safe`), so it
// costs one shared surfaces feed and no DOM until something is installed.
// The sheet is loaded on first use.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useExtensionSurfaces, PuzzleIcon } from './ExtensionDocks.jsx';
import './extension-ui.css';

export function ExtensionMenu({ projectDir, chatId, slot, class: extraClass, label = 'Extensions' }) {
  const list = useExtensionSurfaces(projectDir, slot);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(null);
  const [Sheet, setSheet] = useState(null);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open || Sheet) return;
    import('./ExtensionSheet.jsx').then((m) => setSheet(() => m.ExtensionSheet), () => setOpen(null));
  }, [open, Sheet]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setMenuOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [menuOpen]);
  useEffect(() => { setOpen(null); setMenuOpen(false); }, [projectDir, chatId]);
  if (!list.length) return null;
  const pick = (s) => { setMenuOpen(false); setOpen(s); };
  return h(Fragment, null,
    h('div', { class: 'ext-menu' + (extraClass ? ' ' + extraClass : ''), ref: wrap },
      h('button', {
        type: 'button', class: 'icon-btn ext-menu__btn', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false',
        'aria-label': label, title: label,
        // One view: open it directly.
        onClick: () => (list.length === 1 ? pick(list[0]) : setMenuOpen((v) => !v))
      }, h(PuzzleIcon, { size: 16 })),
      menuOpen ? h('div', { class: 'ext-menu__list', role: 'menu' },
        list.map((s) => h('button', { key: s.extensionId + '/' + s.surfaceId, type: 'button', role: 'menuitem',
          class: 'ext-menu__item', onClick: () => pick(s) },
        s.title,
        s.extensionName !== s.title ? h('span', { class: 'ext-menu__ext' }, s.extensionName) : null))) : null),
    open && Sheet ? h(Sheet, { projectDir, chatId: chatId || undefined, surface: open, onClose: () => setOpen(null) }) : null);
}
