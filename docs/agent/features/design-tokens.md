# Design tokens and shared UI styles — implementation notes

> Agent-facing reference for [`docs/features/design-tokens.md`](../../features/design-tokens.md). The human-facing surface lives in that file; the implementation details, the token contract, and the source paths live here.

## Implementation notes

### Tokens

Tokens are CSS custom properties declared on `:root` in `frontend/src/base.css`.

| Group | Tokens |
|-------|--------|
| Surfaces | `--bg`, `--surface`, `--surface-2`, `--surface-3` |
| Borders | `--border`, `--border-strong` |
| Text | `--fg`, `--fg-soft`, `--muted`, `--muted-2`, `--tab-label` |
| Accent | `--accent`, `--accent-soft`, `--accent-press`, `--accent-hi`, `--accent-hi-2`, `--on-accent` |
| Semantic | `--success`, `--success-soft`, `--warning`, `--warning-soft`, `--danger`, `--danger-soft` |
| Fonts | `--font-sans`, `--font-mono` |
| Radius | `--r-sm`, `--r-md`, `--r-lg`, `--r-pill` |
| Motion | `--dur-fast`, `--dur`, `--dur-slow`, `--ease`, `--ease-out` |
| Touch | `--tap`, `--tap-sm`, `--tap-xs` |

Only reference tokens that exist in this table. A `var()` that names an undefined token silently falls back, which hides drift instead of failing loudly — `tool-cards.css` used to reference a `--font-sans` that the theme never defined, so it fell back to the browser default. `--font-sans` and `--font-mono` are now both declared on `:root`, and inline `font-family` stacks were replaced by them.

```css
.my-path {
  font-family: var(--font-mono);
  color: var(--muted);
}
.my-dot { background: var(--success); }
.my-primary { color: var(--on-accent); background: var(--accent); }
```

### Overflow menu: `.menu-pop`

Declared once in `frontend/src/forms.css`. Each instance adds `menu-pop` and keeps only a position + z-index rule of its own.

```js
h('div', { class: 'menu-pop my-view__menu-pop', hidden: !open, role: 'menu' },
  h('button', { type: 'button', role: 'menuitem' }, 'Rename…'),
  h('div', { class: 'menu-pop__sep', role: 'separator' }),
  h('button', { type: 'button', role: 'menuitem', 'data-danger': '1' }, 'Delete')
);
```

```css
.my-view__menu-pop { right: 0; top: calc(100% + 4px); z-index: 35; }
```

The parent needs `position: relative`. Close-on-outside-tap comes from `useClickOutside` (`frontend/src/hooks/useClickOutside.js`).

Adopters: `frontend/src/components/Projects.jsx` (`project-card__menu-pop`), `frontend/src/components/SettingsProjects.jsx` (`sprojects__menu-pop`), `frontend/src/components/chat/GitModal.jsx` (`gm__commit-menu-pop`), `frontend/src/components/Inspector.jsx` (`inspector__actions-pop`, `inspector__row-menu-pop`). Before this, each shipped its own copy and the copies had drifted (two radii, two item sizes, two danger treatments).

### Spinner: `mouaif-spin`

One `@keyframes mouaif-spin` in `frontend/src/features.css`. Callers choose their own duration.

```css
.my-spinner { animation: mouaif-spin 0.8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .my-spinner { animation: none; } }
```

It replaces three byte-identical copies: `tool-card-spin` (`tool-cards.css`), `gm-spin` (`chat-composer.css`) and `dictation-spin` (`dictation.css`).

### Related shared styles

- `.btn`, `.btn--primary`, `.btn--danger`, `.btn--ghost`, `.btn--small` — `frontend/src/forms.css`.
- `.icon-btn`, `.icon-btn--close`, `.icon-btn--labeled`, `.tap-target` — `frontend/src/base.css`.
- Full-screen modal overlay and sheet — `frontend/src/sheets.css`; see [Modal sheets](../../features/modal-sheets.md).
- Overlay fade — `@keyframes mouaif-overlay-fade-in` in `frontend/src/features.css`.
