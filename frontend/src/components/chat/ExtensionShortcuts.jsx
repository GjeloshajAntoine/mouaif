// mouaif web — extension keyboard shortcuts (docs/features/extensions.md)
//
// A `ui` entry of a sheet or page slot may carry `"shortcut": "mod+shift+k"`
// (mod = Ctrl, or Cmd on Apple devices). One listener for the whole app:
//   - app.route  goes to the page,
//   - app.panel  opens its sheet anywhere (no chat),
//   - chat.sheet / composer.action open their sheet in the open chat only.
// The server gives each shortcut to the first active extension that claims
// it (`shortcutTaken` for the others). `?safe` registers none.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useExtensionSurfaces } from './ExtensionDocks.jsx';
import { openExtensionSheet } from './extensionEvents.js';
import { extensionRouteHash } from './ExtensionMenu.jsx';
import { nav } from '../../router.js';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

// keyboard event -> "mod+alt+shift+k" (only the parts that are held).
export function comboOf(e) {
  const code = e.code || '';
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit[0-9]$/.test(code) ? code.slice(5) : '';
  if (!key) return '';
  const mod = MAC ? e.metaKey : e.ctrlKey;
  // The other platform modifier is not part of any shortcut.
  if (MAC ? e.ctrlKey : e.metaKey) return '';
  return (mod ? 'mod+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + key;
}

export function ExtensionShortcuts({ projectDir }) {
  const list = useExtensionSurfaces(projectDir, '').filter((s) => s.shortcut);
  const latest = useRef(list);
  latest.current = list;
  const [panel, setPanel] = useState(null);
  const [Sheet, setSheet] = useState(null);
  useEffect(() => {
    if (!panel || Sheet) return;
    import('./ExtensionSheet.jsx').then((m) => setSheet(() => m.ExtensionSheet), () => setPanel(null));
  }, [panel, Sheet]);
  const any = list.length > 0;
  useEffect(() => {
    if (!any) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.repeat) return;
      const combo = comboOf(e);
      if (!combo) return;
      const s = latest.current.find((x) => x.shortcut === combo);
      if (!s) return;
      let done = false;
      if (s.slot === 'app.route') { nav(extensionRouteHash(s)); done = true; }
      else if (s.slot === 'app.panel') { setPanel(s); done = true; }
      else done = openExtensionSheet({ extensionId: s.extensionId, surfaceId: s.surfaceId });
      if (done) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [any]);
  useEffect(() => { setPanel(null); }, [projectDir]);
  return panel && Sheet ? h(Sheet, { projectDir, surface: panel, onClose: () => setPanel(null) }) : null;
}
