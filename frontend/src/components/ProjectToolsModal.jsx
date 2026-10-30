// mouaif web — Tool list modal for a Projects card
//
// The wrench on a project card opens this sheet: the project's tool tree
// (Off / Ask / Allow per tool), the same one Settings → Project shows. It
// renders SettingsProjectView with `page: 'tools'`, so every tap saves to the
// project through the settings page's own handlers instead of a second copy
// of them. SettingsProject.jsx is loaded on first open, the way App.jsx
// lazy-loads it, so the Projects tab does not pay for it up front.
//
// Overlay, sheet and desktop card come from the shared sheet idiom in
// frontend/src/sheets.css; Escape, focus and the system Back gesture from
// useModal. The overlay is portalled to <body>: the card lives in the page
// scroller, which on a phone becomes a fixed overlay's containing block and
// clips it (see inspector/sheetPortal.js).
import { h } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { useModal } from '../hooks/useModal.js';
import { nav } from '../router.js';
import { navTarget } from './settings/projectNavigation.js';

export function ProjectToolsModal({ project, onClose }) {
  const sheetRef = useModal({ onClose });
  const [View, setView] = useState(null);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let cancelled = false;
    import('./SettingsProject.jsx')
      .then((m) => { if (!cancelled) setView(() => m.SettingsProjectView); })
      .catch((err) => { if (!cancelled) setLoadError('load failed: ' + (err && err.message ? err.message : err)); });
    return () => { cancelled = true; };
  }, []);

  const name = project.name || project.path;
  function onBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return createPortal(h('div', {
    class: 'ptools__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Tools for ' + name,
    onClick: onBackdropClick
  },
  h('div', { class: 'ptools__sheet', ref: sheetRef },
    h('div', { class: 'ptools__head' },
      h('div', { class: 'ptools__heading' },
        h('span', { class: 'ptools__title' }, 'Tools'),
        h('span', { class: 'ptools__project', title: project.path }, name)
      ),
      h('button', {
        class: 'ptools__close',
        type: 'button',
        onClick: onClose,
        'aria-label': 'Close tools',
        title: 'Close'
      },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
        h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
      ))
    ),
    h('div', { class: 'ptools__body' },
      View
        ? h(View, { projectDir: project.path, from: 'projects', page: 'tools' })
        : h('div', { class: 'settings-project__item-note', 'data-state': loadError ? 'error' : undefined }, loadError || 'Loading tools…')
    ),
    h('div', { class: 'ptools__foot' },
      h('span', { class: 'ptools__note' }, 'Applies to every chat in this project.'),
      h('button', {
        class: 'btn',
        type: 'button',
        onClick: () => nav(navTarget('settings/project', { projectDir: project.path, from: 'projects' }))
      }, 'Project settings')
    )
  )
  ), document.body);
}
