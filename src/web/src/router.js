// mouaif web — hash router
// No history API; the Node server doesn't rewrite unknown paths to
// index.html, so deep links would 404 anyway; the hash is enough.
import { route } from './api.js';

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (!h) return { name: 'chats' };
  if (h === 'projects') return { name: 'chats' };
  if (h === 'settings') return { name: 'settings' };
  if (h === 'auth') return { name: 'settings' };
  if (h === 'inspector') return { name: 'inspector' };
  if (h === 'settings/providers') return { name: 'settingsProviders' };
  if (h === 'settings/providers/new') return { name: 'settingsProviderNew' };
  if (h.startsWith('settings/providers/')) {
    const id = decodeURIComponent(h.slice('settings/providers/'.length));
    if (id && id !== 'new') return { name: 'settingsProviderEdit', id };
  }
  if (h === 'settings/project') return { name: 'settingsProject' };
  if (h === 'settings/defaults') return { name: 'settingsDefaults' };
  if (h === 'settings/copilot') return { name: 'settingsCopilot' };
  if (h === 'settings/about') return { name: 'settingsAbout' };
  if (h.startsWith('chat/')) {
    const rest = h.slice('chat/'.length);
    const [chatId, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return { name: 'chat', chatId, projectDir: params.get('projectDir') || '' };
  }
  if (h.startsWith('projects/new')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'picker', dir: params.get('dir') || '' };
  }
  return { name: 'chats' };
}

route.value = parseHash();

window.addEventListener('hashchange', () => { route.value = parseHash(); });

export function nav(toHash) {
  window.location.hash = '#/' + toHash;
}