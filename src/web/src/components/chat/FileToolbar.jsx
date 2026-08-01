// mouaif web — File/git toolbar button (inline inside composer pill)
//
// Sits as the first element inside .chat-view__composer: a round button
// with a stacked ▲▼ SVG icon. Opens a dropdown menu with two actions:
// the file editor and the git changes modal. The menu is positioned
// above the composer; the git modal is a full-screen overlay.
//
// The icon is an inline SVG, not text glyphs: ▲ (U+25B2) and ▼ (U+25BC)
// render as color emoji on some mobile fonts, where one triangle covers
// the other and only a single icon is visible.

import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { GitModal } from './GitModal.jsx';

export function FileToolbar(props) {
  const { projectDir, onOpenFileEditor } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  function handleFileEditor() {
    setMenuOpen(false);
    if (onOpenFileEditor) onOpenFileEditor();
  }

  function handleGit() {
    setMenuOpen(false);
    setGitOpen(true);
  }

  return h('div', { class: 'file-toolbar' },
    h('button', {
      class: 'file-toolbar__trigger',
      type: 'button',
      onClick: () => setMenuOpen(!menuOpen),
      'aria-label': 'File tools',
      'aria-haspopup': 'true',
      'aria-expanded': String(menuOpen),
      title: 'File and git tools'
    },
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
        h('path', { d: 'M12 5 5.5 11.4h13L12 5Z', fill: 'currentColor' }),
        h('path', { d: 'M12 19 5.5 12.6h13L12 19Z', fill: 'currentColor' })
      )
    ),
    menuOpen && h('div', { ref: menuRef, class: 'file-toolbar__menu', role: 'menu' },
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: handleFileEditor },
        h('span', { class: 'file-toolbar__menu-icon' }, '\u{1F4DD}'),
        h('span', null, 'Files')
      ),
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: handleGit },
        h('span', { class: 'file-toolbar__menu-icon' }, '\u{1F4C1}'),
        h('span', null, 'Git')
      )
    ),
    gitOpen ? h(GitModal, { projectDir, onClose: () => setGitOpen(false) }) : null
  );
}
