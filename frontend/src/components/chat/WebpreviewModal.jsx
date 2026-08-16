// mouaif web — Webpreview modal (full-screen preview overlay)
//
// Renders a screenshot that the `webpreview` tool captured. The user
// taps a thumbnail card in the transcript to open this modal; closing
// returns them to the chat. The same full-screen overlay pattern as
// the Git modal: a dark backdrop, a single sheet that fills the
// viewport on a phone and grows to a centered card on tablet/desktop.
//
// The modal shows the captured JPEG verbatim. Two pieces of meta
// stay visible at all times so the user always knows what they're
// looking at: the page title (from the `target.title` record) and
// the URL (from `result.url`, monospace so a long URL wraps cleanly).
//
// Props:
//   preview   { url, title, thumbnail, width, height, sizeBytes, capturedAt }
//   onClose   () => void  — wired to the close button, Escape, and
//                            the dialog backdrop tap

import { h } from 'preact';
import { useEffect } from 'preact/hooks';

export function WebpreviewModal(props) {
  const preview = props && props.preview;
  const onClose = props && props.onClose;

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (onClose) onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Defensive: render the modal shell even when the preview payload
  // is missing — the close button still has to work and the page
  // shows the model-facing error in the body so the user knows
  // nothing useful was returned.
  const url = (preview && preview.url) || '';
  const title = (preview && preview.title) || url || 'Web preview';
  const thumbnail = preview && preview.thumbnail;
  const width = preview && preview.width;
  const height = preview && preview.height;
  const sizeBytes = preview && preview.sizeBytes;
  const capturedAt = preview && preview.capturedAt;

  function onBackdropClick(e) {
    // Only close when the tap lands on the backdrop itself, not on
    // the sheet. Same pattern as the Git modal.
    if (e.target === e.currentTarget && onClose) onClose();
  }

  const meta = [];
  if (width && height) meta.push(width + ' × ' + height);
  if (sizeBytes) meta.push(formatBytes(sizeBytes));
  if (capturedAt) meta.push('captured ' + formatTime(capturedAt));

  return h('div', {
    class: 'wp__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    onClick: onBackdropClick
  },
    h('div', { class: 'wp__sheet' },
      h('div', { class: 'wp__head' },
        h('div', { class: 'wp__head-text' },
          h('div', { class: 'wp__title', title: title }, title || 'Web preview'),
          h('div', { class: 'wp__url', title: url }, url || '')
        ),
        h('button', {
          class: 'wp__close',
          type: 'button',
          'aria-label': 'Close preview',
          title: 'Close preview',
          onClick: () => onClose && onClose()
        },
          h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
            h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
          )
        )
      ),
      h('div', { class: 'wp__body' },
        thumbnail
          ? h('img', {
              class: 'wp__img',
              src: thumbnail,
              alt: title || ('Preview of ' + url),
              draggable: 'false'
            })
          : h('div', { class: 'wp__empty' },
              h('p', null, 'No preview available.'),
              h('p', { class: 'wp__empty-hint' }, 'The webpreview call finished without a captured image.')
            )
      ),
      h('div', { class: 'wp__foot' },
        h('span', { class: 'wp__foot-meta' }, meta.filter(Boolean).join(' · ')),
        url
          ? h('a', {
              class: 'wp__open-link',
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              'aria-label': 'Open ' + url + ' in a new tab'
            }, 'Open in new tab')
          : null
      )
    )
  );
}

function formatBytes(b) {
  if (!b || !isFinite(b) || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
