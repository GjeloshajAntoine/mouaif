// The window event that tells the chat's hooks bar (HooksDock.jsx) to reload
// now, sent by stream.js when the model's hook_create / hook_delete finished.
// Its own module so stream.js does not import the dock component.
export const CHAT_HOOKS_CHANGED = 'mouaif:chat-hooks-changed';

// The hook glyph (a fish hook), one SVG path on a 24×24 box: the hooks bar
// and the chat list's Hooks filter and row icon.
export const HOOK_ICON_PATH = 'M15 3v11a5 5 0 0 1-10 0v-3l3 3M13 3h4';
