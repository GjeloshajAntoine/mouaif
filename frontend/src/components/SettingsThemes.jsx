// mouaif web — Settings → Themes (docs/features/themes.md)
//
// Pick the app's theme from the built-in set or your own, import a theme
// file, or start a new one. Selecting a card applies it at once and saves it
// app-wide; the editor lives in SettingsThemeEdit.jsx.
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { nav } from '../router.js';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '../theme/builtin.js';
import { refreshTheme, saveTheme, safeMode, setActiveTheme, themeError, themeState } from '../theme/runtime.js';
import { parseThemeFile } from '../theme/file.js';
import { ThemeCard } from './settings/ThemeCard.jsx';
import './settings/themes.css';

export function SettingsThemesView() {
  const [status, setStatus] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);
  const state = themeState.value;
  const active = state.active || DEFAULT_THEME_ID;
  const error = themeError.value;

  useEffect(() => { refreshTheme().catch((e) => setStatus({ text: 'Could not load themes: ' + e.message, kind: 'error' })); }, []);

  async function select(id) {
    if (busy || id === active) return;
    setBusy(true);
    try {
      await setActiveTheme(id);
      setStatus({ text: '', kind: '' });
    } catch (e) {
      setStatus({ text: 'Could not switch theme: ' + e.message, kind: 'error' });
    }
    setBusy(false);
  }

  async function onImport(event) {
    const file = event.currentTarget.files && event.currentTarget.files[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const theme = parseThemeFile(await file.text());
      const saved = await saveTheme('', theme);
      // Open the import in the editor instead of switching to it: a theme
      // file can carry a script, and the user should see it before it runs.
      nav('settings/themes/' + encodeURIComponent(saved.id));
    } catch (e) {
      setStatus({ text: 'Import failed: ' + e.message, kind: 'error' });
    }
  }

  const errorTheme = error && state.themes.find((t) => t.id === error.themeId);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'Themes')
    ),
    h('section', { class: 'settings-themes' },
      safeMode ? h('div', { class: 'settings-themes__notice', role: 'status' },
        h('strong', null, 'Safe mode'),
        h('span', null, ' — themes and theme scripts are off while the address has ?safe. '),
        h('a', { href: window.location.pathname + '#/settings/themes' }, 'Leave safe mode')
      ) : null,
      error ? h('div', { class: 'settings-themes__notice settings-themes__notice--error', role: 'alert' },
        h('strong', null, 'Theme script failed'),
        h('span', null, ' — ' + (errorTheme ? errorTheme.name : error.themeId) + ': ' + error.message + ' '),
        errorTheme ? h('a', { href: '#/settings/themes/' + encodeURIComponent(errorTheme.id) }, 'Edit script') : null
      ) : null,

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Built-in'),
        h('ul', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Built-in themes' },
          BUILTIN_THEMES.map((theme) => h(ThemeCard, {
            key: theme.id,
            theme: { ...theme, builtin: true },
            selected: active === theme.id,
            onSelect: select,
            editHref: '#/settings/themes/new?from=' + encodeURIComponent(theme.id),
            editLabel: 'Customize'
          }))
        )
      ),

      h('div', { class: 'group' },
        h('div', { class: 'group__title' }, 'Your themes', h('span', { class: 'group__title-note' }, 'colours, CSS & JS')),
        state.themes.length
          ? h('ul', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Your themes' },
              state.themes.map((theme) => h(ThemeCard, {
                key: theme.id,
                theme,
                selected: active === theme.id,
                onSelect: select,
                editHref: '#/settings/themes/' + encodeURIComponent(theme.id),
                editLabel: 'Edit'
              }))
            )
          : h('p', { class: 'hint hint--compact' }, state.loaded ? 'No custom themes yet. Customize a built-in one, start from scratch, or import a theme file.' : 'Loading…'),
        h('div', { class: 'settings-themes__actions' },
          h('a', { class: 'btn btn--primary', href: '#/settings/themes/new' }, 'New theme'),
          h('button', { type: 'button', class: 'btn', onClick: () => fileInput.current && fileInput.current.click() }, 'Import file'),
          h('input', { ref: fileInput, type: 'file', accept: '.json,application/json', hidden: true, onChange: onImport })
        )
      ),

      h('p', { class: 'status', 'data-state': status.kind, 'aria-live': 'polite' }, status.text),
      h('p', { class: 'hint hint--compact' },
        'The theme applies to every device signed in to this mouaif. A custom theme can run its own JavaScript for animations and effects. If a script ever breaks the app, open ',
        h('code', null, window.location.origin + '/?safe#/settings/themes'),
        ' to load without themes and fix or delete it.')
    )
  );
}
