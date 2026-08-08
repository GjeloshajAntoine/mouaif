---
name: react
description: Write React and Preact code following modern best practices — hooks, functional components, state management, and performance. Use when authoring or reviewing any UI component in the web frontend.
---

# React & Preact development

Use these rules when writing or reviewing UI components in this repository. The web frontend runs Preact + Vite (`frontend/`), which implements the React API, so all standard React patterns apply.

## Components

- Use **function components + hooks**. No class components.
- One component per file, named in PascalCase. Keep files focused and small.
- Destructure props at the function signature and pass only what each component needs — avoid threading large "everything" objects down.
- Name handlers `on<Event>` and expose a matching `onX` prop when a child needs to notify a parent.
- Keep components presentational when possible; lift state up and pass values/events down explicitly.

## Hooks

- Follow the **Rules of Hooks**: call hooks at the top level, never inside loops, conditions, or nested functions.
- Only call hooks from React function components or custom hooks (prefix custom hooks with `use`).
- Use the correct dependency arrays:
  - `useEffect` / `useCallback` / `useMemo` with an accurate dependency list.
  - Prefer `useMemo` for derived values and `useCallback` for stable handlers passed as props.
  - Don't over-lint dependencies, but don't omit real ones — stale closures are bugs.
- Split effects by concern: one `useEffect` per responsibility.
- Clean up subscriptions, timers, and listeners in the effect's return function to avoid leaks.

## State management

- Keep state **local** with `useState` by default; lift it only when siblings actually share it.
- For shared or app-level state, use a minimal approach (context + `useReducer`) and avoid prop-drilling beyond two levels.
- Derive state instead of duplicating it — compute values from existing state rather than storing redundant copies.
- Co-locate related state into a single object or reducer when it updates together.
- Avoid storing values that can be recomputed; keep the single source of truth small.

## Performance

- Memoize expensive computations with `useMemo` only when they actually cost something — don't memoize trivially cheap values.
- Pass stable `useCallback` handlers down to avoid needless re-renders of child components.
- Use `key` correctly on lists (stable, unique per item, never the array index when items can reorder or change).
- Prefer lazy loading for heavy or off-screen sections; defer non-critical work until after paint.
- Avoid setting state in render; derive during render or in effects instead.

## Conventions in this repo

- Mobile first: primary viewport 360–430 px, touch targets ≥ 44 × 44 px, safe-area insets respected, no hover-only affordances.
- Responsive units only (`rem`, `%`, `dvh`); no fixed pixel widths for containers.
- Prefer tab bars, bottom sheets, and stacked cards over multi-pane desktop layouts.
- Import Preact from the app's `preact` alias; follow existing component style in `frontend/src/`.
- Run the project lint on touched files before finishing.
