// mouaif web — user-facing web preview dock
//
// The webpreview tool publishes its latest screenshot here instead of
// embedding image bytes in the transcript. The dock is deliberately just a
// reduced phone-proportioned image, matching the Inspector preview rather
// than presenting the screenshot as a metadata card.
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
      draggable: 'false'
    })
    ),
    h('button', {
      class: 'webpreview-dock__dismiss',
      type: 'button',
      onClick: onDismiss,
      'aria-label': 'Dismiss preview',
      title: 'Dismiss preview'
    }, '×')
  );
}
