// mouaif web — an extension's sheet (docs/features/extensions.md)
//
// The `chat.sheet` slot: a bottom sheet opened from the chat's file menu
// (next to custom actions) or by the extension's own view
// (mouaif/chat.open_sheet). It mounts the view when it opens and unmounts it
// when it closes. Full height on a phone; the view's own Fullscreen works too.
// Sheets do not count toward the live-view budget: they are in the foreground.
import { h } from 'preact';
import { useModal } from '../../hooks/useModal.js';
import { activeProject } from '../../api.js';
import { McpAppFrame } from './McpAppFrame.jsx';
import { PuzzleIcon } from './ExtensionDocks.jsx';
import './extension-ui.css';

export function ExtensionSheet({ projectDir, chatId, surface, onClose }) {
  const sheetRef = useModal({ onClose: () => { if (onClose) onClose(); } });
  const id = surface.extensionId + '/' + surface.surfaceId;
  return h('div', {
    class: 'ext-sheet__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': surface.title,
    onClick: (e) => { if (e.target === e.currentTarget && onClose) onClose(); }
  },
  h('div', { class: 'ext-sheet', ref: sheetRef },
    h('header', { class: 'ext-sheet__head' },
      h('span', { class: 'ext-sheet__icon' }, h(PuzzleIcon, { size: 18 })),
      h('div', { class: 'ext-sheet__titles' },
        h('strong', null, surface.title),
        surface.extensionName !== surface.title ? h('span', { class: 'ext-sheet__ext' }, surface.extensionName) : null),
      h('button', { type: 'button', class: 'btn ext-sheet__close', onClick: onClose, 'aria-label': 'Close ' + surface.title }, 'Close')),
    h('div', { class: 'ext-sheet__body' },
      h(McpAppFrame, { projectDir, chatId, callId: 'sheet:' + id,
        surface: { extensionId: surface.extensionId, surfaceId: surface.surfaceId, slot: 'chat.sheet',
          projectName: (activeProject.value && activeProject.value.name) || '' } }))));
}
