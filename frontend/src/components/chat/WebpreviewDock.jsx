// mouaif web — user-facing web preview dock
//
// The webpreview tool publishes its latest screenshot here instead of
// embedding image bytes in the transcript. The dock is a small
// phone-proportioned image, right-aligned between the chat scroll and
// the composer, matching the Inspector preview rather than presenting
// metadata in chat (title/host/time are shown only in the full-screen
// viewer). A small circular dismiss button sits on the card's top-right
// border so it can be tapped without covering the preview.
import { h } from 'preact';
export function WebpreviewDock({ preview, onOpen, onDismiss }) {
  if (!preview || !preview.thumbnail) return null;
  const title = preview.title || preview.url || 'Web preview';
  return h('aside', { class: 'webpreview-dock', 'aria-label': 'Web preview' },
    h('button', {
      class: 'webpreview-dock__open',
      type: 'button',
      onClick: onOpen,
      'aria-label': 'Open full preview of ' + title
    },
      h('img', {
        class: 'webpreview-dock__image',
        src: preview.thumbnail,
        alt: 'Preview of ' + title,
        draggable: 'false',
        loading: 'lazy',
        decoding: 'async'
      })
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