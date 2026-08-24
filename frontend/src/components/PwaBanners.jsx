// mouaif web — offline + "update available" banners.
//
// The offline banner is a thin strip pinned to the top of the app
// shell. It uses the same surface palette as the rest of the UI so
// it doesn't feel like an OS dialog, and it only appears when the
// offline signal flips true. Tapping it triggers a manual reload —
// the network may have come back already, and a reload is the
// fastest way to confirm.
//
// The update banner sits below the header and offers a "Reload"
// affordance when a new service worker is waiting. The banner
// itself is dismissed by accepting the update (which posts
// SKIP_WAITING, triggers controllerchange, and reloads the page).

import { h, Fragment } from 'preact';
import { updateAvailable, applyUpdate } from '../sw-registration.js';
import { offline } from '../pwa-connectivity.js';

function ReloadButton() {
  return h('button', {
    type: 'button',
    class: 'pwa-banner__btn',
    onClick: () => { applyUpdate(); }
  }, 'Reload');
}

export function PwaBanners() {
  const showOffline = offline.value;
  const showUpdate = updateAvailable.value;
  if (!showOffline && !showUpdate) return null;
  return h(Fragment, null,
    showOffline ? h('div', { class: 'pwa-banner pwa-banner--offline', role: 'status' },
      h('span', { class: 'pwa-banner__icon', 'aria-hidden': 'true' },
        // Inline SVG: a curved arrow over a wifi glyph. No font
        // dependency, scales with text size.
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
          h('path', { d: 'M12 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0-4c1.66 0 3 1.34 3 3h-2a1 1 0 1 1-2 0H9c0-1.66 1.34-3 3-3Zm0-4c2.76 0 5 2.24 5 5h-2a3 3 0 1 0-6 0H7c0-2.76 2.24-5 5-5Zm0-4c4.42 0 8 3.58 8 8h-2a6 6 0 1 0-12 0H4c0-4.42 3.58-8 8-8Z', fill: 'currentColor' })
        )
      ),
      h('span', { class: 'pwa-banner__text' }, 'You are offline. Showing the last cached view.'),
      h('button', {
        type: 'button',
        class: 'pwa-banner__btn',
        onClick: () => { window.location.reload(); }
      }, 'Retry')
    ) : null,
    showUpdate ? h('div', { class: 'pwa-banner pwa-banner--update', role: 'status' },
      h('span', { class: 'pwa-banner__icon', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
          h('path', { d: 'M12 4V1L7 5l5 4V6c3.31 0 6 2.69 6 6 0 .96-.23 1.87-.63 2.68l1.46 1.46A7.95 7.95 0 0 0 20 12c0-4.42-3.58-8-8-8Zm-6.37 5.32A7.95 7.95 0 0 0 4 12c0 4.42 3.58 8 8 8v3l5-4-5-4v3c-3.31 0-6-2.69-6-6 0-.96.23-1.87.63-2.68L5.63 9.32Z', fill: 'currentColor' })
        )
      ),
      h('span', { class: 'pwa-banner__text' }, 'A new version is ready.'),
      ReloadButton()
    ) : null
  );
}
