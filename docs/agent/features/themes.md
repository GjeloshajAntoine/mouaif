# Themes — implementation notes

> Agent-facing reference for [`docs/features/themes.md`](../../features/themes.md). The human-facing surface lives in that file; the source paths, wire shapes, and limits live here.

## Implementation notes

### Where things live

- `frontend/src/theme/builtin.js`: the built-in themes and the colour tokens the editor shows. Built-in themes are data only (tokens and CSS) and carry no script.
- `frontend/src/theme/runtime.js`: applies a theme and runs its script.
- `frontend/src/theme/examples.js`: the starter scripts.
- `frontend/src/theme/file.js`: export and import.
- `frontend/src/components/SettingsThemes.jsx`, `SettingsThemeEdit.jsx` and `settings/ThemeCard.jsx`, with `settings/themes.css`: the two pages.
- `src/themes.js`: the store and validation. `src/server-handlers-themes.js`: the REST routes.

### How a theme is applied

1. **Tokens**: one `<style id="mouaif-theme-tokens">` with an `html:root { ... }` rule. It outranks base.css's plain `:root` whatever order the stylesheets load in. The rule also sets `color-scheme`, and the runtime updates `<meta name="theme-color">` to the theme's `--bg`.
2. **CSS**: the theme's stylesheet goes in `<style id="mouaif-theme-css">`. The page CSP already allows inline styles (`style-src 'unsafe-inline'`).
3. **Script**: imported with `import('/api/themes/<id>/script.js?v=<hash>')`. The page CSP is `script-src 'self'`, so inline script, `eval` and `blob:` scripts cannot run. Serving the code as a same-origin file keeps that policy unchanged. `?v=` is a content hash, so an edited script gets a new module URL instead of the copy the browser already imported.

To avoid a flash of the default palette, `main.jsx` calls `bootTheme()` before the first render. It repaints the last theme's tokens and CSS from `localStorage` (`mouaif.theme.v1`), but not its script. `App` then calls `refreshTheme()` once it mounts, which is after the access gate. That call fetches the active theme and starts the script.

### Storage and API

Themes live in the app store under one key, `themes: { active, custom: [...] }`. The key is not in `CLIENT_SETTINGS_KEYS`, so `GET /api/settings` stays small. The UI uses these routes instead:

```text
GET    /api/themes                  { active, themes: [{ id, name, base, vars, css, hasJs, jsBytes, version, updatedAt }] }
PUT    /api/themes/active   {id}    { active }            built-in or custom id; "" = default
POST   /api/themes          {theme} { theme }             create; returns the new id
GET    /api/themes/<id>             { theme }             includes js
PUT    /api/themes/<id>     {theme} { theme }             replace
DELETE /api/themes/<id>             { active }            clears active if it was this theme
GET    /api/themes/<id>/script.js   text/javascript, Cache-Control: no-store, nosniff
```

All of these routes are under `/api/`, so the same-origin and access-session gates apply, including to the script. The server keeps only `name`, `base`, `vars`, `css` and `js`, and limits them as follows:

- `name`: up to 60 characters.
- `vars`: up to 80 tokens. Each name must be a `--token`, and each value may not contain `; { } < >`.
- `css`: up to 100 KB.
- `js`: up to 200 KB.
- At most 50 custom themes.

### Tests

```sh
node scripts/test-themes.js   # store, validation, REST routes, script endpoint
node scripts/test-routes.js   # #/settings/themes, /new, /new?from=, /<id>
```
