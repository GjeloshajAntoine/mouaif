// mouaif web — Settings → Themes → edit (docs/features/themes.md)
//
// Edits one custom theme: colours, shape, type, extra tokens, CSS and a
// JavaScript module. The page previews the draft live on the real UI (tokens
// and CSS only); the script runs once the theme is saved and in use, because
// the page CSP only lets same-origin script files execute.
import { h, Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { nav } from '../router.js';
import { COLOR_TOKENS, DEFAULT_THEME_ID, findBuiltin } from '../theme/builtin.js';
import { SCRIPT_EXAMPLES, SCRIPT_TEMPLATE } from '../theme/examples.js';
import { downloadThemeFile } from '../theme/file.js';
import {
  deleteTheme, loadThemeSource, previewTheme, restoreTheme, safeMode,
  saveTheme, setActiveTheme, themeError, themeState
} from '../theme/runtime.js';
import './settings/themes.css';

const RADII = {
  sharp: { '--r-sm': '2px', '--r-md': '3px', '--r-lg': '4px' },
  round: { '--r-sm': '10px', '--r-md': '18px', '--r-lg': '24px' }
};
const FONTS = {
  serif: 'ui-serif, "New York", Georgia, Cambria, "Times New Roman", serif',
  mono: 'var(--font-mono)'
};
const SHAPE_KEYS = ['--r-sm', '--r-md', '--r-lg', '--font-sans'];
const COLOR_NAMES = new Set(COLOR_TOKENS.map((t) => t.name));

const emptyDraft = () => ({ name: 'My theme', base: 'dark', vars: {}, css: '', js: '' });

function hex6(value) {
  const v = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return ('#' + v.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  return null;
}

// Tokens the colour, shape and type controls do not own, as editable text.
function otherTokensText(vars) {
  return Object.entries(vars)
    .filter(([name]) => !COLOR_NAMES.has(name) && !SHAPE_KEYS.includes(name))
    .map(([name, value]) => name + ': ' + value + ';')
    .join('\n');
}

function parseOtherTokens(text) {
  const vars = {};
  let bad = 0;
  for (const part of text.split(/;|\n/)) {
    const line = part.trim();
    if (!line) continue;
    const m = /^(--[A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line);
    if (m && !/[{}<>]/.test(m[2])) vars[m[1]] = m[2].trim();
    else bad += 1;
  }
  return { vars, bad };
}

function radiusChoice(vars) {
  if (vars['--r-md'] === RADII.sharp['--r-md']) return 'sharp';
  if (vars['--r-md'] === RADII.round['--r-md']) return 'round';
  return vars['--r-md'] ? 'custom' : 'default';
}

function fontChoice(vars) {
  const f = vars['--font-sans'];
  if (!f) return 'system';
  if (f === FONTS.mono) return 'mono';
  if (f === FONTS.serif) return 'serif';
  return 'custom';
}

function Seg({ name, label, value, options, onChange }) {
  return h('div', { class: 'row' },
    h('span', { class: 'label' }, label),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
      options.map(([key, text]) => h('label', { key, class: 'seg__item' + (value === key ? ' seg__item--on' : '') },
        h('input', { type: 'radio', name, value: key, checked: value === key, onChange: () => onChange(key) }),
        h('span', { class: 'seg__pill' }, text)
      ))
    )
  );
}

function ColorRow({ token, value, onChange }) {
  const swatch = hex6(value) || hex6(token.value) || '#000000';
  const id = 'theme-token-' + token.name.slice(2);
  return h('div', { class: 'theme-color' },
    h('input', {
      type: 'color',
      class: 'theme-color__swatch',
      value: swatch,
      'aria-label': token.label + ' colour picker',
      onInput: (e) => onChange(e.currentTarget.value)
    }),
    h('label', { class: 'theme-color__label', for: id },
      h('span', null, token.label),
      h('code', null, token.name)
    ),
    h('input', {
      id,
      class: 'input theme-color__value',
      value: value || '',
      placeholder: token.value,
      autocapitalize: 'off',
      spellcheck: false,
      onInput: (e) => onChange(e.currentTarget.value)
    }),
    value ? h('button', { type: 'button', class: 'btn btn--ghost theme-color__reset', 'aria-label': 'Reset ' + token.label, onClick: () => onChange('') }, '×') : null
  );
}

export function SettingsThemeEditView({ id = '', from = '' }) {
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState('');
  const [others, setOthers] = useState('');
  const [othersBad, setOthersBad] = useState(0);
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState(false);
  const isNew = !id;
  const active = themeState.value.active || DEFAULT_THEME_ID;
  const isActive = !isNew && active === id;
  const error = themeError.value && themeError.value.themeId === id ? themeError.value : null;

  // ---- Load ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      let next;
      try {
        if (id) {
          const theme = await loadThemeSource(id);
          next = { name: theme.name, base: theme.base, vars: theme.vars || {}, css: theme.css || '', js: theme.js || '' };
        } else if (from) {
          const builtin = findBuiltin(from);
          const source = builtin || await loadThemeSource(from);
          next = { name: source.name + ' copy', base: source.base, vars: { ...(source.vars || {}) }, css: source.css || '', js: source.js || '' };
        } else {
          next = emptyDraft();
        }
      } catch (e) {
        if (!cancelled) setStatus({ text: 'Could not load the theme: ' + e.message, kind: 'error' });
        return;
      }
      if (cancelled) return;
      setDraft(next);
      // A new theme is always unsaved; an existing one is clean until edited.
      setSaved(id ? JSON.stringify(next) : '');
      setOthers(otherTokensText(next.vars));
    }
    load();
    return () => { cancelled = true; };
  }, [id, from]);

  const dirty = useMemo(() => !!draft && JSON.stringify(draft) !== saved, [draft, saved]);

  // ---- Live preview ------------------------------------------------------
  // A draft previews without its script. Once it matches the saved theme
  // and that theme is in use, show the real thing, script included, so
  // "Save & use" visibly runs the code.
  useEffect(() => {
    if (!draft || safeMode) return undefined;
    if (!dirty && isActive) { restoreTheme(); return undefined; }
    const timer = setTimeout(() => previewTheme({ id: id || 'draft', name: draft.name, base: draft.base, vars: draft.vars, css: draft.css }), 120);
    return () => clearTimeout(timer);
  }, [draft && draft.base, draft && draft.vars, draft && draft.css, dirty, isActive]);
  useEffect(() => () => restoreTheme(), []);

  if (!draft) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings/themes', class: 'view-back', 'aria-label': 'Back to themes' }, '←'),
        h('h2', { class: 'view-title' }, 'Theme')
      ),
      h('p', { class: 'status', 'data-state': status.kind, 'aria-live': 'polite' }, status.text || 'Loading…')
    );
  }

  const patch = (fields) => setDraft((d) => ({ ...d, ...fields }));
  const setVars = (fn) => setDraft((d) => ({ ...d, vars: fn({ ...d.vars }) }));
  const setVar = (name, value) => setVars((vars) => {
    if (value && value.trim()) vars[name] = value.trim(); else delete vars[name];
    return vars;
  });

  function onRadius(choice) {
    setVars((vars) => {
      for (const key of ['--r-sm', '--r-md', '--r-lg']) delete vars[key];
      return Object.assign(vars, RADII[choice] || {});
    });
  }
  function onFont(choice) { setVar('--font-sans', FONTS[choice] || ''); }

  function onOthers(text) {
    setOthers(text);
    const parsed = parseOtherTokens(text);
    setOthersBad(parsed.bad);
    setVars((vars) => {
      for (const name of Object.keys(vars)) {
        if (!COLOR_NAMES.has(name) && !SHAPE_KEYS.includes(name)) delete vars[name];
      }
      return Object.assign(vars, parsed.vars);
    });
  }

  function insertExample(exampleId) {
    const example = exampleId === 'template' ? { code: SCRIPT_TEMPLATE } : SCRIPT_EXAMPLES.find((e) => e.id === exampleId);
    if (!example) return;
    if (draft.js.trim() && !window.confirm('Replace the current script with this example?')) return;
    patch({ js: example.code });
  }

  async function save({ use = false } = {}) {
    if (!draft.name.trim()) { setStatus({ text: 'Give the theme a name.', kind: 'error' }); return; }
    setBusy(true);
    setStatus({ text: 'Saving…', kind: 'busy' });
    try {
      const theme = await saveTheme(id, draft);
      setSaved(JSON.stringify(draft));
      if (use) await setActiveTheme(theme.id);
      const live = use || isActive;
      setStatus({ text: live ? 'Saved and in use.' : 'Saved.', kind: 'success' });
      // saveTheme() re-applies the active theme; keep previewing the draft
      // when it is not the one in use (the effect above covers the other case).
      if (!live) previewTheme({ id: theme.id, name: draft.name, base: draft.base, vars: draft.vars, css: draft.css });
      if (isNew) nav('settings/themes/' + encodeURIComponent(theme.id));
    } catch (e) {
      setStatus({ text: 'Save failed: ' + e.message, kind: 'error' });
    }
    setBusy(false);
  }

  async function remove() {
    if (!window.confirm('Delete the theme "' + draft.name + '"?')) return;
    setBusy(true);
    try {
      await deleteTheme(id);
      nav('settings/themes');
    } catch (e) {
      setStatus({ text: 'Delete failed: ' + e.message, kind: 'error' });
      setBusy(false);
    }
  }

  const jsBytes = new Blob([draft.js]).size;

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/themes', class: 'view-back', 'aria-label': 'Back to themes' }, '←'),
      h('h2', { class: 'view-title' }, isNew ? 'New theme' : draft.name || 'Theme')
    ),
    h('section', { class: 'settings-theme-edit' },
      h('p', { class: 'hint hint--compact' },
        safeMode
          ? 'Safe mode is on, so this page does not preview the theme.'
          : 'The app around you previews the colours and CSS as you type. The script runs when the theme is saved and in use.'),

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Theme'),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'theme-name' }, 'Name'),
          h('input', { id: 'theme-name', class: 'input', value: draft.name, maxLength: 60, onInput: (e) => patch({ name: e.currentTarget.value }) })
        ),
        h(Seg, { name: 'theme-base', label: 'Base', value: draft.base, options: [['dark', 'Dark'], ['light', 'Light']], onChange: (base) => patch({ base }) }),
        h(Seg, {
          name: 'theme-radius', label: 'Corners', value: radiusChoice(draft.vars),
          options: [['sharp', 'Sharp'], ['default', 'Default'], ['round', 'Round']].concat(radiusChoice(draft.vars) === 'custom' ? [['custom', 'Custom']] : []),
          onChange: onRadius
        }),
        h(Seg, {
          name: 'theme-font', label: 'Type', value: fontChoice(draft.vars),
          options: [['system', 'System'], ['serif', 'Serif'], ['mono', 'Mono']].concat(fontChoice(draft.vars) === 'custom' ? [['custom', 'Custom']] : []),
          onChange: onFont
        })
      ),

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Colours', h('span', { class: 'group__title-note' }, 'empty = default')),
        h('div', { class: 'theme-colors' },
          COLOR_TOKENS.map((token) => h(ColorRow, { key: token.name, token, value: draft.vars[token.name] || '', onChange: (value) => setVar(token.name, value) }))
        ),
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'theme-other' }, 'More tokens'),
          h('textarea', {
            id: 'theme-other', class: 'input theme-code', rows: 4, value: others, spellcheck: false, autocapitalize: 'off',
            placeholder: '--accent-soft: rgba(110, 168, 254, .16);\n--shadow-md: 0 4px 16px rgba(0,0,0,.35);',
            onInput: (e) => onOthers(e.currentTarget.value)
          }),
          h('p', { class: 'hint hint--compact' + (othersBad ? ' theme-warn' : '') },
            othersBad
              ? othersBad + ' line(s) are not "--name: value" and are ignored.'
              : 'Any design token from base.css, one "--name: value;" per line. Soft tints and press shades follow the main colours unless set here.')
        )
      ),

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'CSS'),
        h('div', { class: 'row' },
          h('textarea', {
            class: 'input theme-code', rows: 8, value: draft.css, spellcheck: false, autocapitalize: 'off', 'aria-label': 'Theme CSS',
            placeholder: '.chat-view__bubble { backdrop-filter: blur(8px); }\n@keyframes pulse { … }',
            onInput: (e) => patch({ css: e.currentTarget.value })
          }),
          h('p', { class: 'hint hint--compact' }, 'Loaded after the app styles. Use it for anything tokens cannot reach: backgrounds, keyframes, per-component tweaks.')
        )
      ),

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'JavaScript', h('span', { class: 'group__title-note' }, jsBytes ? Math.ceil(jsBytes / 1024) + ' KB' : 'optional')),
        error ? h('p', { class: 'status', 'data-state': 'error', role: 'alert' }, 'Script error: ' + error.message) : null,
        h('div', { class: 'row' },
          h('label', { class: 'label', for: 'theme-example' }, 'Start from'),
          h('select', {
            id: 'theme-example', class: 'input', value: '',
            onChange: (e) => { insertExample(e.currentTarget.value); e.currentTarget.value = ''; }
          },
            h('option', { value: '' }, 'Insert an example…'),
            h('option', { value: 'template' }, 'Empty template'),
            SCRIPT_EXAMPLES.map((example) => h('option', { key: example.id, value: example.id }, example.label + ' — ' + example.note))
          )
        ),
        h('div', { class: 'row' },
          h('textarea', {
            class: 'input theme-code theme-code--js', rows: 14, value: draft.js, spellcheck: false, autocapitalize: 'off', 'aria-label': 'Theme JavaScript',
            placeholder: SCRIPT_TEMPLATE,
            onInput: (e) => patch({ js: e.currentTarget.value })
          }),
          h('p', { class: 'hint hint--compact' },
            'An ES module: ', h('code', null, 'export default function setup(ctx)'),
            '. ctx gives you addStyle, setVar, onRoute, onFrame, signal and reducedMotion, and undoes them when the theme changes. Return a function to clean up anything else.'),
          h('p', { class: 'hint hint--compact theme-warn' },
            'The script runs inside mouaif with full access to your chats and settings. Only use code you wrote or trust.')
        )
      ),

      h('div', { class: 'settings-theme-edit__bar' },
        h('button', { type: 'button', class: 'btn btn--primary', disabled: busy || (!dirty && !isNew), onClick: () => save() }, 'Save'),
        !isActive ? h('button', { type: 'button', class: 'btn', disabled: busy, onClick: () => save({ use: true }) }, dirty || isNew ? 'Save & use' : 'Use') : null,
        h('button', { type: 'button', class: 'btn', disabled: busy, onClick: () => downloadThemeFile(draft) }, 'Export'),
        !isNew ? h('button', { type: 'button', class: 'btn btn--danger', disabled: busy, onClick: remove }, 'Delete') : null
      ),
      h('p', { class: 'status', 'data-state': status.kind, 'aria-live': 'polite' }, status.text || (dirty && !isNew ? 'Unsaved changes.' : ''))
    )
  );
}
