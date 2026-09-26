# Flush-route scrolling — implementation notes

> Agent-facing reference for [`docs/features/flush-route-scroll.md`](../../features/flush-route-scroll.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

### The rule

Routes without the bottom tab bar are **flush** routes. `frontend/src/components/App.jsx`
adds `app__main--flush` to `<main>`, and `frontend/src/layout.css` gives exactly
one element the job of scrolling:

```css
.app__main--flush > section:not(.chat-view) {
  flex: 1 1 0;
  min-height: 0;
  height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  touch-action: pan-y;
  animation: none;
}
```

That is a **direct child** selector, so a view's content must be wrapped in a
single root `<section>` element, as a sibling of its fixed header:

```js
return h(Fragment, null,
  h('div', { class: 'view-head' }, /* back link + title */),
  h('section', null,              /* the scroll container */
    /* the long content */)
);
```

`.app__main--flush` deliberately sets `overflow: visible` (not `auto`) so a
nested `overflow-y: auto` descendant keeps its iOS touch-pan gesture — see
[`ios-touch-scroll.md`](./ios-touch-scroll.md). That is why the section, not
`<main>`, is the scroller; and why a view with no `<section>` gets *no* scroller
at all rather than falling back to `<main>`.

### The regression

Four views returned a bare `Fragment` of loose `<div>` / `<ul>` children with no
root `<section>`. The content rendered correctly and the Vite build passed, but
no element matched the flush scroll rule, so everything below the fold was
clipped with no way to reach it.

| View | Route | Symptom | Fix |
|------|-------|---------|-----|
| `SettingsDefaultsView` | `#/settings/defaults` | Cards below *Image button* unreachable | wrapped the `.group` in a root `<section>` |
| `SettingsProjectsView` | `#/settings/projects` | Long project list clipped | wrapped hint + page-bar + list in a root `<section>` |
| `SettingsProvidersView` | `#/settings/providers` | Long provider list clipped | wrapped hint + list + page-bar in a root `<section>` |
| `SettingsTagsView` | `#/settings/tags` | Hint rows and the **Scan** bar clipped under the tag list | wrapped the hints + `.tags__list` + page-bar in a root `<section>` |

`SettingsTagsView` owns an internal scroller (`.tags__list`, a fixed-height
virtual list at `height: min(62dvh, 34rem)`). Its root `<section>` is therefore a
plain non-scrolling child in practice — the section reports `overflow-y: auto`
but is sized to `<main>`, and the inner list's own height keeps the outer
section from overflowing. The two do not become competing scroll layers.

### Guards

`scripts/test-flush-scroll.mjs` (static) parses each flush settings view, walks
the top-level children of its returned `Fragment` with a comment- and
string-aware scanner, and asserts a root `<section>` is present. It covers all
14 flush settings views, so a new page cannot reintroduce the bug.

`scripts/test-flush-scroll-ui.mjs` (browser fixture) serves the real views inside
the real `.app__shell` / `.app__main--flush` markup and exposes
`window.__mount(name, props)`. A check renders a view, asserts its section
reports `overflow-y: auto`, and asserts `scrollTop` actually advances once the
content overflows.

Wire-up lives in `package.json`:

- `npm run test:flush-scroll` → `node scripts/test-flush-scroll.mjs`
- the `lint` script `node --check`s both scripts.
