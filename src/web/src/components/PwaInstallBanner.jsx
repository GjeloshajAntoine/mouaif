// mouaif web — PWA install banner
//
// Listens for the beforeinstallprompt event and shows a banner
// offering to install the app to the home screen. Once the user
// installs or dismisses, the banner stays hidden for the session.

import { h } from 'preact';
import { signal } from '@preact/signals';

let deferredPrompt = null;
export const showInstallBanner = signal(false);

export function initPwaInstall() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner.value = true;
  });
  window.addEventListener('appinstalled', () => {
    showInstallBanner.value = false;
    deferredPrompt = null;
  });
}

export function PwaInstallBanner() {
  if (!showInstallBanner.value) return null;
  return h('div', { class: 'pwa-banner pwa-banner--install', role: 'alert' },
    h('span', { class: 'pwa-banner__icon', 'aria-hidden': 'true' },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
        h('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z', fill: 'currentColor' })
      )
    ),
    h('span', { class: 'pwa-banner__text' }, 'Install mouaif for quick access'),
    h('button', {
      type: 'button',
      class: 'pwa-banner__btn',
      onClick: async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const result = await deferredPrompt.userChoice;
        if (result.outcome === 'accepted') {
          showInstallBanner.value = false;
        }
        deferredPrompt = null;
      }
    }, 'Install'),
    h('button', {
      type: 'button',
      class: 'pwa-banner__btn pwa-banner__btn--dismiss',
      onClick: () => {
        showInstallBanner.value = false;
        deferredPrompt = null;
      }
    }, 'Not now')
  );
}