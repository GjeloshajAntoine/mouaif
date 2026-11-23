// mouaif web — the block a lazily loaded sheet shows when its code could not
// be fetched (see ../hooks/useLazySheet.js for the rule, and for why the way
// out is a reload rather than a retry).
//
// It *replaces* the sheet that failed to build, so it is itself a full-screen
// sheet: the same overlay + card as the CLI and Git modals (frontend/src/
// sheets.css, `.sheet-err__*`). Rendering it inline instead would drop the
// message into the composer's flow, below whatever the chat is showing, so the
// user would tap Cli and see nothing where the sheet belongs.
//
// Use within a sheet that is already open — the file editor, artifacts, screen
// capture, the web-preview viewer, the image annotator — pass `inline` so the
// block fills that sheet's body instead of opening a second overlay above it.
//
// Mobile first: the actions are a full-width column of ≥44 px targets, so they
// work with a thumb and never wrap into an unreadable row at 360 px.
import { h } from 'preact';
import { lazySheetMessage, reloadDocument } from '../../hooks/useLazySheet.js';

export function LazySheetError(props) {
  const { label, error, onClose, inline } = props;
  const body = h('div', {
    class: 'lazy-err' + (inline ? ' lazy-err--inline' : ''),
    role: 'alert',
    'aria-label': (label || 'This view') + ' could not load'
  },
    h('div', { class: 'lazy-err__icon', 'aria-hidden': 'true' }, '⚠'),
    h('p', { class: 'lazy-err__text' }, lazySheetMessage(error, label)),
    h('div', { class: 'lazy-err__actions' },
      h('button', {
        class: 'btn btn--primary lazy-err__btn',
        type: 'button',
        onClick: () => reloadDocument()
      }, 'Reload the app'),
      onClose
        ? h('button', {
          class: 'btn lazy-err__btn',
          type: 'button',
          onClick: () => onClose()
        }, 'Close')
        : null
    )
  );
  if (inline) return body;
  return h('div', {
    class: 'sheet-err__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': (label || 'This view') + ' could not load',
    // A tap on the backdrop closes it, the same way the sheet it stands in for
    // would have been closed. The card itself stops the click.
    onClick: () => { if (onClose) onClose(); }
  },
    h('div', {
      class: 'sheet-err__sheet',
      onClick: (e) => e.stopPropagation()
    }, body)
  );
}
