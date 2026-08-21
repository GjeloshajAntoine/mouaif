// mouaif web — user-facing web preview dock (redesigned card)
//
// The webpreview tool publishes its latest screenshot here instead of
// embedding image bytes in the transcript. The dock is a small card
// docked between the chat scroll and the composer: a thumbnail the
// user can tap to open the full-screen viewer, the page title and host
// for context, a relative "captured N min ago" hint, and a dismiss
// affordance that sits *inside* the card so it never overflows the
// tap area.
import { h } from 'preact';
export function WebpreviewDock({ preview, onOpen, onDismiss }) {
  if (!preview || !preview.thumbnail) return null;
  const title = preview.title || preview.url || 'Web preview';
  const host = hostFromUrl(preview.url);
  const when = formatRelativeTime(preview.capturedAt);
  return h('aside', { class: 'webpreview-dock', 'aria-label': 'Web preview' },
    h('button', {
      class: 'webpreview-dock__open',
      type: 'button',
      onClick: onOpen,
      'aria-label': 'Open full preview of ' + title
    },
      h('span', { class: 'webpreview-dock__thumb' },
        h('img', {
          class: 'webpreview-dock__image',
          src: preview.thumbnail,
          alt: 'Preview of ' + title,
          draggable: 'false',
          loading: 'lazy',
          decoding: 'async'
        })
      ),
      h('span', { class: 'webpreview-dock__meta' },
        h('span', { class: 'webpreview-dock__title', title: title }, title),
        h('span', { class: 'webpreview-dock__sub' },
          h('span', { class: 'webpreview-dock__host', title: host || '' }, host || ''),
          when ? h('span', { class: 'webpreview-dock__sep', 'aria-hidden': 'true' }, '·') : null,
          when ? h('span', { class: 'webpreview-dock__time', title: preview.capturedAt || '' }, when) : null
        )
      )
    ),
    h('button', {
      class: 'webpreview-dock__dismiss',
      type: 'button',
      onClick: onDismiss,
      'aria-label': 'Dismiss preview',
      title: 'Dismiss preview'
    },
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
        h('path', { d: 'M6 6l12 12 M18 6L6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
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
function formatRelativeTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!t || !isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' d ago';
  try {
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch { return ''; }
}