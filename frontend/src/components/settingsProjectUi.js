// mouaif web — SettingsProject UI helpers
//
// Pure, state-free helpers used by SettingsProjectView. Extracted from
// SettingsProject.jsx so that file stays under ~1 000 lines. These
// functions take their inputs as arguments and return Preact vnodes /
// values; they never touch component refs or state, so they are safe to
// hoist out of the component.
import { h } from 'preact';
import { ToolAuthSeg, TOOL_MODE_CHOICES } from './settings/toolAuth.js';

// Section icons — small glyphs that mark each settings card so the
// page scans faster. Shapes (not emoji) to keep them monochrome and
// consistent with the rest of the UI.
export function sectionIcon(kind) {
  const attrs = { class: 'settings-project__section-icon settings-project__section-icon--' + kind, 'aria-hidden': 'true' };
  switch (kind) {
    case 'general': return h('span', attrs, h('span', { class: 'ico-sliders' }));
    case 'chat': return h('span', attrs, h('span', { class: 'ico-chat' }));
    case 'tools': return h('span', attrs, h('span', { class: 'ico-wrench' }));
    case 'files': return h('span', attrs, h('span', { class: 'ico-doc' }));
    case 'agents': return h('span', attrs, h('span', { class: 'ico-people' }));
    case 'skills': return h('span', attrs, h('span', { class: 'ico-spark' }));
    case 'more': return h('span', attrs, h('span', { class: 'ico-grid' }));
    default: return h('span', attrs);
  }
}

// Tool permission model (see docs/features/tool-authorization.md):
// exactly three primary choices per tool — Off (hidden from the
// model, zero tokens), Ask on use, Allow (auto-approved). An
// allowlist is an advanced refinement of Ask: matching calls run
// without prompting, the rest still ask. Entering patterns flips
// the server mode to `allowlist`; clearing them flips back to
// `ask`. The segmented control never shows "allowlist" as a fourth
// option — Ask stays selected — so the row reads as one choice.
//
// The control itself is the shared ToolAuthSeg (./settings/toolAuth.js),
// the same component the chat tools card and the composer tool popup
// render, so `subagent` and every other tool row are built by one code
// path. This wrapper only adapts the settings call signature (a display
// name plus a one-argument picker) to the component's props.
export function toolModeSegs(name, activeMode, onPick, modes) {
  return h(ToolAuthSeg, {
    tool: name,
    name,
    mode: activeMode,
    namePrefix: 'sp',
    modes: modes || TOOL_MODE_CHOICES,
    onPick: (mode) => onPick(mode)
  });
}
