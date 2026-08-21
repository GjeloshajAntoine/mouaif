// mouaif web — Webpreview modal (redesigned full-screen viewer)
//
// Renders the latest screenshot the `webpreview` tool captured. The
// same full-screen overlay pattern as the Git modal: dark backdrop,
// a single sheet that fills the viewport on a phone and grows to a
// centered card on tablet/desktop. Tapping the backdrop, the close
// button, or pressing Escape all dismiss the viewer.
//
// Header: page title (one line, ellipsised), the source URL with a
// copy-to-clipboard button, and a "Refresh" action that asks the
// model to recapture the same URL. Body: the screenshot, centered,
// object-fit:contain so a tall page keeps its full strip visible
// without horizontal scroll. Footer: small metadata (dimensions,
// size, capture time) and an "Open in new tab" link.
//
// Props:
//   preview     { url, title, thumbnail, width, height, sizeBytes, capturedAt }
//   onClose     () => void
//   onRefresh   () => void  — wired by ChatViewx to prefill the
//                              composer with a webpreview request.
//   copyStatus  string      — transient "Copied" hint, owned by the
//                              parent so the toast survives re-renders.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
export function WebpreviewModal(props) {
  const preview = props && props.preview;
  const onClose = props && props.onClose;
  const onRefresh = props && props.onRefresh;
  const initialCopy = (props && props.copyStatus) || '';
  const [copyStatus, setCopyStatus] = useState(initialCopy);
  useEffect(() => { setCopyStatus(initialCopy); }, [initialCopy]);
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
  // is missing — the close button still has to work and the body
  // shows the model-facing error so the user knows nothing useful
  // was returned.
  const url = (preview && preview.url) || '';
  const title = (preview && preview.title) || url || 'Web preview';
  const thumbnail = preview && preview.thumbnail;
  const width = preview && preview.width;
  const height = preview && preview.height;
  const sizeBytes = preview && preview.sizeBytes;
  const capturedAt = preview && preview.capturedAt;
  const host = hostFromUrl(url);
  function onBackdropClick(e) {
    // Only close when the tap lands on the backdrop itself, not on
    // the sheet. Same pattern as the Git modal.
    if (e.target === e.currentTarget && onClose) onClose();
  }
  function onCopy() {
    if (!url) return;
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
          setCopyStatus('Copied');
          setTimeout(() => setCopyStatus(''), 1500);
        }, () => {
          setCopyStatus('Copy failed');
          setTimeout(() => setCopyStatus(''), 1500);
        });
        copied = true;
      }
    } catch { /* fall through */ }
    if (!copied) {
      // Legacy fallback for browsers without async clipboard.
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopyStatus('Copied');
        setTimeout(() => setCopyStatus(''), 1500);
      } catch {
        setCopyStatus('Copy failed');
        setTimeout(() => setCopyStatus(''), 1500);
      }
    }
  }
  function onRefreshClick() {
    if (!onRefresh) return;
    onRefresh();
    if (onClose) onClose();
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
          url
            ? h('div', { class: 'wp__url-row' },
                h('span', { class: 'wp__url', title: url }, url),
                h('button', {
                  class: 'wp__url-copy' + (copyStatus ? ' wp__url-copy--active' : ''),
                  type: 'button',
                  onClick: onCopy,
                  'aria-label': 'Copy URL to clipboard',
                  title: 'Copy URL'
                },
                  h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
                    h('path', { d: 'M9 4h9a2 2 0 0 1 2 2v12M5 8h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
                  ),
                  h('span', { class: 'wp__url-copy-label', 'aria-live': 'polite' }, copyStatus || 'Copy')
                )
              )
            : null,
          host
            ? h('div', { class: 'wp__host', title: url }, host)
            : null
        ),
        h('div', { class: 'wp__head-actions' },
          onRefresh && url
            ? h('button', {
                class: 'wp__action wp__action--refresh',
                type: 'button',
                onClick: onRefreshClick,
                'aria-label': 'Ask the model to recapture ' + url,
                title: 'Ask the model to recapture this page'
              },
                h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
                  h('path', { d: 'M4 12a8 8 0 0 1 13.66-5.66L20 4 M20 4v5h-5 M20 12a8 8 0 0 1-13.66 5.66L4 20 M4 20v-5h5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
                ),
                h('span', null, 'Refresh')
              )
            : null,
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
        )
      ),
      h('div', { class: 'wp__body' },
        thumbnail
          ? h('img', {
              class: 'wp__img',
              src: thumbnail,
              alt: title || ('Preview of ' + url),
              draggable: 'false',
              decoding: 'async'
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
function hostFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname || '';
  } catch { return ''; }
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