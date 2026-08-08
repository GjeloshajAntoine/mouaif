---
name: mouaif-dev
description: Follow mouaif project conventions when writing or changing code here — commit style, mobile-first UI, and per-feature docs. Use when implementing a feature or fix in this repo.
---

# Coding for mouaif

Use these rules whenever implementing or modifying code in this repository.

## Commit discipline

- Work autonomously on small details; don't stop to ask for confirmation on routine decisions.
- **One feature = one commit.** Keep commits small, focused, and revertible. Split work that spans multiple features.
- Use Conventional Commits for every message:
  - `feat:` new user-facing feature
  - `fix:` bug fix
  - `refactor:` internal change with no behavior change
  - `docs:` documentation only
  - `chore:` tooling, deps, config
  - `perf:` performance improvement
  - `test:` adding or fixing tests
- Before finishing, run `node -c` (or the project's lint) on touched files and confirm the `mouaif serve` flow still works.

## UI is mobile first

- Primary viewport 360–430 px wide, single column.
- Touch targets ≥ 44 × 44 px; respect safe-area insets.
- No hover-only affordances — everything must work on tap.
- Use system font stacks and responsive units (`rem`, `%`, `dvh`); no fixed pixel widths for containers.
- Prefer tab bars, bottom sheets, and stacked cards over multi-pane desktop layouts. Desktop is "the mobile UI with extra room."
- Test at narrow widths before calling a UI feature done.

## Every feature ships with docs

- Add a self-contained static-page doc at `docs/features/<kebab-case-name>.md`.
- Structure: single H1 title, H2 sections (Overview / Usage / Implementation notes), fenced code samples, relative image paths, no SSG shortcodes.
- Update the doc in the **same commit** as the code change — docs and code drift is a bug.
- Add a one-line entry to `docs/README.md` the first time a feature doc is created.

## Stack and architecture

- CLI is Node.js + `commander`; HTTP server with REST + SSE in `src/index.js`, entry `bin/mouaif.js`.
- Default port is **5732** — never change it silently.
- UI is Preact + Vite served at `/` (lives in `frontend/` at the repo root, not under `src/`).
- Keep the existing REST + SSE surface stable unless a feature requires a new endpoint; if so, document it in the matching feature doc.

## Key subsystems to respect

- Providers global, models per project (SQLite store); see `docs/decisions.md`.
- AI providers are localized: a `buildRequest` + `parseEvent` in `src/ai.js`, a row in `frontend/src/api.js` `SETTINGS_PROVIDERS`, and if auth differs, an entry in `src/auth.js` `AI_TO_AUTH_PROVIDER`. PKCE/OAuth/device-code providers add `src/oauth-<name>.js` exporting `register()`, called from `src/index.js`.
- Skills live in `.agents/skills/<name>/SKILL.md` (see this file) and are parsed by `src/agentSkills.js`.
- Settings can be app-level (SQLite) or per-project (`.mouaif.json`); project overrides app.
