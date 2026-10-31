// frontend/src/theme/file.js — theme files for sharing (export / import).
//
// A theme file is JSON: { "mouaifTheme": 1, name, base, vars, css, js }.
// Import only reads those keys; the server validates them again on save.

const FORMAT = 1;

export function themeFileText(theme) {
  return JSON.stringify({
    mouaifTheme: FORMAT,
    name: theme.name,
    base: theme.base === 'light' ? 'light' : 'dark',
    vars: theme.vars || {},
    css: theme.css || '',
    js: theme.js || ''
  }, null, 2) + '\n';
}

export function downloadThemeFile(theme) {
  const blob = new Blob([themeFileText(theme)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (String(theme.name || 'theme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme') + '.mouaif-theme.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseThemeFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('not a JSON file'); }
  if (!data || typeof data !== 'object' || data.mouaifTheme !== FORMAT) throw new Error('not a mouaif theme file');
  if (typeof data.name !== 'string' || !data.name.trim()) throw new Error('the theme has no name');
  return {
    name: data.name.trim(),
    base: data.base === 'light' ? 'light' : 'dark',
    vars: data.vars && typeof data.vars === 'object' && !Array.isArray(data.vars) ? data.vars : {},
    css: typeof data.css === 'string' ? data.css : '',
    js: typeof data.js === 'string' ? data.js : ''
  };
}
