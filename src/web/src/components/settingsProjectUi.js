// mouaif web — SettingsProject UI helpers
//
// Pure, state-free helpers used by SettingsProjectView. Extracted from
// SettingsProject.jsx so that file stays under ~1 000 lines. These
// functions take their inputs as arguments and return Preact vnodes /
// values; they never touch component refs or state, so they are safe to
// hoist out of the component.
import { h } from 'preact';

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
export function segMode(mode) { return mode === 'allowlist' ? 'ask' : mode; }

// One-tap segmented control for a tool's permission mode. Segments
// are radio inputs so keyboard and screen-reader users get the
// same "pick one of N" semantics as the tap targets.
export function toolModeSegs(name, activeMode, onPick, modes) {
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name },
    modes.map((m) =>
      h('label', { key: m.value, class: 'seg__item' + (activeMode === m.value ? ' seg__item--on' : '') },
        h('input', {
          type: 'radio',
          name: 'sp-' + name.replace(/\s+/g, '-').toLowerCase(),
          value: m.value,
          checked: activeMode === m.value,
          onChange: () => onPick(m.value)
        }),
        h('span', { class: 'seg__pill' }, m.label)
      )
    )
  );
}
