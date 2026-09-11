// mouaif web — hash router
// No history API; the Node server doesn't rewrite unknown paths to
// index.html, so deep links would 404 anyway; the hash is enough.
//
// This module is only the browser wiring: it keeps the shared `route`
// signal in sync with `window.location.hash` and exposes `nav()`. The
// hash → route mapping itself is a table in ./routes.js so it can be
// tested (and extended) without a DOM.
import { route } from './api.js';
import { parseHash } from './routes.js';

route.value = parseHash(window.location.hash);
window.addEventListener('hashchange', () => { route.value = parseHash(window.location.hash); });

export function nav(toHash) {
  window.location.hash = '#/' + toHash;
}
