// Flush-route scroll regression check (static).
//
// Flush routes (no tab bar) render into `.app__main--flush`, and the only
// element that becomes their scroll container is a *direct `<section>` child
// of `<main>` — the `.app__main--flush > section` rule in layout.css. A view
// that returns a bare Fragment gets no scroll container and everything below
// the fold is clipped with no way to reach it.
//
// Four views shipped that way (SettingsDefaults, SettingsProjects,
// SettingsProviders, SettingsTags). A Vite build cannot catch it — the JSX
// compiles fine and the component renders; only the resulting DOM is wrong.
// This test pins the contract so a new settings view cannot reintroduce it.
//
// The matching browser fixture is scripts/test-flush-scroll-ui.mjs, which
// renders the real views in the real shell and asserts the section actually
// scrolls.
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Every route listed in App.jsx's FULL_PAGE_ROUTES renders without the tab
// bar. The settings views are the ones that each own their own back link and
// scroll region, so each must return a Fragment whose *second* child (after
// the fixed view-head or first hint row) is a root <section>.
const FLUSH_SETTINGS_VIEWS = [
  ['SettingsDefaults.jsx', 'App defaults'],
  ['SettingsProjects.jsx', 'Projects'],
  ['SettingsProviders.jsx', 'Providers'],
  ['SettingsTags.jsx', 'File tags'],
  ['SettingsNotifications.jsx', 'Notifications'],
  ['SettingsAbout.jsx', 'About'],
  ['SettingsPricing.jsx', 'Model pricing'],
  ['SettingsPrompts.jsx', 'Custom prompts'],
  ['SettingsAgents.jsx', 'Agents'],
  ['SettingsMcp.jsx', 'MCP servers'],
  ['SettingsMcpEdit.jsx', 'MCP editor'],
  ['SettingsMcpRegistry.jsx', 'MCP store'],
  ['SettingsActions.jsx', 'Custom actions'],
  ['SettingsHiddenContent.jsx', 'Hidden file content']
];

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL - ' + name + ' :: ' + err.message.split('\n')[0]);
  }
}

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// The scroll rule that makes a flush route scroll: only a direct <section>
// child of <main> is sized as the scroll container.
check('the layout gives flush routes a <section>-shaped scroll container', () => {
  const css = read('frontend/src/layout.css');
  const selector = '.app__main--flush > section:not(.chat-view) {';
  const at = css.indexOf(selector);
  assert.ok(at > -1, 'the `.app__main--flush > section` rule is what turns a flush view into a scroller');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /overflow-y:\s*auto/, 'and it scrolls internally');
  assert.match(rule, /flex:\s*1 1 0/, 'the section is sized to main rather than to its content');
});

// Remove `//` and `/* */` comments without touching string literals, so the
// parser below sees only code. The copy in these views is full of
// apostrophes, backticks and parens, so a regex pass would corrupt it.
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      for (; i < src.length; i++) {
        out += src[i];
        if (src[i] === '\\') { i++; out += src[i] || ''; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// Find the top-level children of the view's `return h(Fragment, null, …)`,
// so a `<section>` only counts when it is a *sibling* of the fixed view-head
// rather than one nested inside a card.
function fragmentChildren(src) {
  const code = stripComments(src);
  const marker = 'return h(Fragment, null,';
  const start = code.indexOf(marker);
  if (start < 0) return [];
  let i = start + marker.length;
  let depth = 0;
  let childStart = i;
  const children = [];
  for (; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { children.push(code.slice(childStart, i)); break; }
      depth--;
    } else if (ch === ',' && depth === 0) {
      children.push(code.slice(childStart, i));
      childStart = i + 1;
    }
  }
  return children.map((c) => c.trim()).filter(Boolean);
}

for (const [file, label] of FLUSH_SETTINGS_VIEWS) {
  check(label + ' renders a root <section> scroll container', () => {
    const src = read('frontend/src/components/' + file);
    const children = fragmentChildren(src);
    assert.ok(children.length >= 2, file + ' must return a Fragment with the fixed head first');
    const hasRootSection = children.some((c) => /^h\('section',/.test(c));
    assert.ok(hasRootSection,
      file + ' must render a root <section> — a bare Fragment leaves the page\n'
      + 'clipped below the fold, because `.app__main--flush > section` is the only\n'
      + 'scroll container a flush route gets.');
  });
}

console.log('\ntest-flush-scroll: ' + pass + ' ok, ' + fail + ' failed');
if (fail) process.exitCode = 1;
