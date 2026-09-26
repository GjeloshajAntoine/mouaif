// mouaif web — user-facing web preview dock
//
// The webpreview tool publishes its latest screenshot here instead of
// embedding image bytes in the transcript. The dock is a small
// phone-proportioned image, right-aligned between the chat scroll and
// the composer, matching the Inspector preview rather than presenting
// metadata in chat (title/host/time are shown only in the full-screen
// viewer). A small circular dismiss button sits on the card's top-right
// border so it can be tapped without covering the preview.
//
// A Live payload ({ mode: 'live', url }, from `webpreview` with
// mode: "live") shows the page itself: an unrestricted <iframe> rendered at
// the payload's viewport size and scaled down to the card. The frame is
// inert in the dock (pointer-events: none) so a tap opens the full viewer,
// where the page is interactive.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { FRAME_ALLOW, isLivePayload } from './webpreviewFrame.js';

// Fallback card width before the first measurement (`min(26%, 6.5rem)`).
const DOCK_WIDTH_PX = 104;

export function WebpreviewDock({ preview, onOpen, onDismiss }) {
  const live = isLivePayload(preview);
  const title = (preview && (preview.title || preview.url)) || 'Web preview';
  const vw = (preview && ((preview.viewport && preview.viewport.width) || preview.width)) || 375;
  const vh = (preview && ((preview.viewport && preview.viewport.height) || preview.height)) || 667;
  const boxRef = useRef(null);
  const [boxWidth, setBoxWidth] = useState(DOCK_WIDTH_PX);
  useEffect(() => {
    if (!live) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => { if (el.clientWidth) setBoxWidth(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [live]);
  const scale = boxWidth / vw;
  if (!preview || (!preview.thumbnail && !live)) return null;
  return h('aside', { class: 'webpreview-dock' + (live ? ' webpreview-dock--live' : ''), 'aria-label': 'Web preview' },
    h('button', {
      class: 'webpreview-dock__open',
      type: 'button',
      onClick: onOpen,
      'aria-label': 'Open full preview of ' + title
    },
      live
        ? h('span', {
            class: 'webpreview-dock__live',
            ref: boxRef,
            style: { aspectRatio: vw + ' / ' + vh }
          },
            h('iframe', {
              class: 'webpreview-dock__frame',
              src: preview.url,
              title: 'Live preview of ' + title,
              allow: FRAME_ALLOW,
              allowFullScreen: true,
              tabIndex: -1,
              'aria-hidden': 'true',
              style: {
                width: vw + 'px',
                height: vh + 'px',
                transform: 'scale(' + scale + ')'
              }
            }),
            h('span', { class: 'webpreview-dock__badge' }, 'LIVE')
          )
        : h('img', {
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
