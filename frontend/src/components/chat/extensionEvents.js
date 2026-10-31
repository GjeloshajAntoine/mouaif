// The extension views mounted in this tab (docks, sheets, renderers), so
// mouaif can reach them: a badge a view sets on its dock chip
// (mouaif/chat.badge), a sheet a view opens (mouaif/chat.open_sheet), and
// host events (turn.start, turn.end, tool.after) forwarded to the views of
// the extension that declared them (docs/features/extensions.md).
//
// entry: { projectDir, chatId, extensionId, surfaceId, events, setBadge?,
//          bridge() -> live bridge | null, open?() }

const entries = new Set();
const sheetOpeners = new Set();

export function registerSurface(entry) { entries.add(entry); }
export function unregisterSurface(entry) { entries.delete(entry); }

export function surfacesOf(projectDir, chatId, extensionId) {
  const out = [];
  for (const e of entries) {
    if (e.projectDir === projectDir && (!chatId || !e.chatId || e.chatId === chatId) && (!extensionId || e.extensionId === extensionId)) out.push(e);
  }
  return out;
}

// setDockBadge(projectDir, chatId, extensionId, badge) — every dock of that extension in that chat.
export function setDockBadge(projectDir, chatId, extensionId, badge) {
  for (const e of surfacesOf(projectDir, chatId, extensionId)) if (e.setBadge) e.setBadge(badge);
}

// Chat.jsx registers how to open a sheet: opener({ extensionId, surfaceId }) -> boolean.
export function registerSheetOpener(fn) { sheetOpeners.add(fn); return () => sheetOpeners.delete(fn); }
export function openExtensionSheet(target) {
  for (const fn of sheetOpeners) if (fn(target)) return true;
  return false;
}

// forwardHostEvent(projectDir, chatId, event, payload) — a chat event to every
// live view whose surface declared it, as a tool-result notification carrying
// { mouaif: { type: 'event', event, payload } }. Views not mounted get nothing.
export function forwardHostEvent(projectDir, chatId, event, payload) {
  let sent = 0;
  for (const e of surfacesOf(projectDir, chatId)) {
    if (!Array.isArray(e.events) || !e.events.includes(event)) continue;
    const bridge = e.bridge && e.bridge();
    if (!bridge || typeof bridge.sendHostEvent !== 'function') continue;
    bridge.sendHostEvent({ mouaif: { type: 'event', event, payload: payload || {} } }).catch(() => {});
    sent++;
  }
  return sent;
}
