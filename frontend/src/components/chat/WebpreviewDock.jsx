// mouaif web — user-facing web preview dock
//
// The webpreview tool publishes its latest screenshot here instead of
// embedding image bytes in the transcript. The compact dock sits between
// the scrolling transcript and composer; tapping it opens the full viewer.
import { h } from 'preact';

export function WebpreviewDock({ preview, onOpen, onDismiss }) {
  if (!preview || !preview.thumbnail) return null;
  const title = preview.title || preview.url || 'Web preview';
  const url = preview.url || '';

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
    }),
    h('span', { class: 'webpreview-dock__text' },
      h('strong', { class: 'webpreview-dock__title' }, title),
      h('span', { class: 'webpreview-dock__url' }, url)
    ),
    h('span', { class: 'webpreview-dock__expand', 'aria-hidden': 'true' }, '↗')
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
