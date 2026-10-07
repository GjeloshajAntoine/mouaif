# Built-in skill: mouaif config — implementation notes

> Agent-facing reference for [`docs/features/mouaif-config-skill.md`](../../features/mouaif-config-skill.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

The skill ships as a package directory, `src/skills/mouaif-config/SKILL.md`. `discover(projectDir)` in [src/agentSkills.js](../../../src/agentSkills.js) merges two roots into one name-keyed map: the bundled `src/skills` directory first, then `<projectDir>/.agents/skills`, so a project skill named `mouaif-config` replaces the bundled entry instead of appearing twice. The merged list is sorted by name, and the result is what `resolve`, `available`, `catalogMessage`, `buildSpec` and `activate` already worked from, so the catalog, the `activate_skill` enum, the per-chat / per-project `disabledSkills` opt-out and the system-prompt response need no changes of their own.

`safeSkillFile(baseDir, root, entry)` took a `projectDir` before; it now takes the containment base. `baseDir` is used twice: as the boundary the entry and file must resolve inside (`isInside(dir, base)` — plain `startsWith(base + sep)` is wrong when `realpath` returns the base unchanged, which is exactly the bundled case), and as the base of the relative `path` a skill reports. That also fixed a latent no-op: the old check was `if (realFile !== realRoot && !startsWith(realRoot + sep))`, and `realRoot` was the *project* dir, so a symlinked project root that `realpath` resolved differently than `realFile` passed the test either way. User skills still report a project-relative `path`, because their base is still the project dir. Nothing consumes the field: `server-handlers-chats.js` sends only `{ id, name, description, enabled, disabled, chatDisabled }` per skill, and `cards.js` / `ToolPopup.jsx` read those.

Packaging needed no change. `package.json` `files` already lists `src/`, and `scripts/prepare-web.js` only rewrites `frontend/` and `bin/`, so an npm install and the web prepare step both keep `src/skills/`.

### Content provenance

The skill body's settings key table, provider list, provider id descriptions (key-based versus plan sign-in, key-optional) and tool-family gate description were read from `src/settings.js` `DEFAULTS`, `src/tools/authorization.js` `TOOL_FAMILIES` / `FAMILY_EXTRAS` / `NATIVE_TOOLS`, `src/tools/appToolNames.js` `DEFINITIONS.source`, `frontend/src/api.js` `SETTINGS_PROVIDERS` and `src/tools/mouaif.js` `PERMISSION_KEYS`. The gate table it prints is the shape a project file actually stores (`tools.<gate>.mode`), which is what `get_settings({ scope: "project" })` returns. Two behaviours the skill states as rules are enforced in `src/tools/mouaif.js` `runSettings`: an `apiKey` anywhere in a patch is refused with `EBADINPUT`, and a patch touching `tools`, `mcp`, `authAccounts` or `authPending` always needs a user decision — a model holding `update_settings: allow` cannot widen its own reach.

### Tests

`npm run test:skills` runs three files:

- `scripts/test-agent-skills.js` — a `projectSkills(dir)` helper filters the bundled name out of the project assertions, and a `---- Bundled catalog ----` section asserts that a project with no `.agents/skills` discovers exactly `mouaif-config`, that `absPath` resolves under `src/skills/mouaif-config/`, that `path` is `mouaif-config/SKILL.md`, that `activate` returns the body, and that a same-named project skill replaces it with one row.
- `scripts/test-agent-skills-stream.js` — `projectSkillNames(req)` filters the bundled name out of every `activate_skill` enum assertion; the `on` case additionally asserts `mouaif-config` is present, and the family-toggle-off case asserts the bundled name is gone too.
- `scripts/test-agent-skills-ui.mjs` — unchanged; it exercises the save queue and rendering, not discovery.

### Related

- [Skills](./skills.md)
- [Native chat and app tools](./mouaif-tool.md)
