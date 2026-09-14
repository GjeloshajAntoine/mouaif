// Inspector ConfirmSheet — in-app confirmation dialog.
//
// Why an in-app sheet instead of window.confirm
// ----------------------------------------------
// window.confirm is a synchronous global dialog that some embedded web
// views (and a number of mobile-platform embedding scenarios around the
// Inspector) auto-dismiss or block: the function returns false without
// ever showing a UI, the rest of the handler early-returns, and the user
// sees no feedback (no status pill, no spinner, no network call) —
// identical to "the button is dead". The Inspector targets list and the
// inspect-phase header menu both used this pattern for Close tab and
// surfaced it as "tapping does nothing".
//
// An in-app sheet is rendered with the same overlay + safe-area padding
// as DetailSheet, so it obeys the mobile-first rules in
// .github/copilot-instructions.md: it appears in the same place the user
// is already looking, respects the iOS home indicator and status bar,
// keeps both buttons inside the 44×44 px tap-target minimum, and never
// relies on a platform dialog that may be suppressed.
//
// Render shape
// ------------
//   <div class="inspector__overlay" onClick={onCancel}>
//     <div class="inspector__sheet inspector__sheet--confirm" role="alertdialog">
//       <div class="inspector__sheet-head">
//         <strong class="inspector__sheet-title">{title}</strong>
//       </div>
//       <div class="inspector__sheet-body inspector__sheet-body--confirm">
//         <p class="inspector__confirm-msg">{message}</p>
//         <div class="inspector__confirm-actions">
//           <button onClick={onCancel}>Cancel</button>
//           <button data-danger="1" onClick={onConfirm}>{confirmLabel}</button>
//         </div>
//       </div>
//     </div>
//   </div>
//
// Returns null when `props.open` is false. The parent owns the
// open/closed state — typically a `pendingClose` ref or piece of
// useState that captures the target the user is about to close, plus a
// `resolveClose(bool)` callback so the calling flow can be written
// straight-line.
import { h } from 'preact';
import { sheetPortal } from './sheetPortal.js';
export function ConfirmSheet(props) {
  if (!props.open) return null;
  const title = props.title || 'Confirm';
  const message = props.message || '';
  const confirmLabel = props.confirmLabel || 'Confirm';
  const cancelLabel = props.cancelLabel || 'Cancel';
  const busy = !!props.busy;
  return sheetPortal(h('div', {
    class: 'inspector__overlay',
    onClick: busy ? undefined : props.onCancel,
    role: 'presentation'
  },
    h('div', {
      class: 'inspector__sheet inspector__sheet--confirm',
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-label': title,
      onClick: (e) => e.stopPropagation()
    },
      h('div', { class: 'inspector__sheet-head' },
        h('strong', { class: 'inspector__sheet-title' }, title)
      ),
      h('div', { class: 'inspector__sheet-body inspector__sheet-body--confirm' },
        h('p', { class: 'inspector__confirm-msg' }, message),
        h('div', { class: 'inspector__confirm-actions' },
          h('button', {
            class: 'btn inspector__confirm-cancel',
            type: 'button',
            disabled: busy,
            onClick: props.onCancel
          }, cancelLabel),
          h('button', {
            class: 'btn inspector__confirm-go',
            type: 'button',
            'data-danger': '1',
            disabled: busy,
            onClick: props.onConfirm
          }, busy ? 'Working…' : confirmLabel)
        )
      )
    )
  ));
}
