# App and project settings

## Overview

`mouaif` manages settings through a three-layer hierarchy: **built-in defaults → global app settings → project-level settings**. Project values override app-level defaults when they conflict, giving you shared defaults across your environment while allowing fine-grained customization per codebase.

## How settings work

- **Global app settings** — configured once in the **Settings** tab. These include connected AI provider credentials, global model pricing, default prompt styles, and default tool permissions.
- **Project settings** — configured per project in **Settings → Projects → [Project Name]** (or via the project card menu). These include project custom prompts, prompt size preferences, agent personas, and specific tool permissions.
- **Merge order** — defaults apply first, global settings override defaults, and project settings override global settings.

## Managing settings in the UI

1. **AI Providers & Keys** — open **Settings → Providers** to add or edit API keys and OAuth connections. Provider credentials are global and never committed to individual project folders.
2. **Access & Security** — configure optional password protection, passkeys, and manage sessions from **Settings → Access & passkeys** (see [Access authentication](./access-authentication.md)).
3. **Project Customizations** — open project settings to configure rules, instruction files (such as `AGENTS.md` or `CLAUDE.md`), and tool permissions for that project.
4. **Database-backed settings (Clean tree)** — by default, project settings are stored next to your code in `.mouaif.json`. If you prefer to keep your working directory untouched by tooling files, enable **Store settings in app DB** in project settings.
5. **Chat defaults** — open **Settings → App defaults → Chat defaults** to set the default prompt style and two composer toggles (Enter inserts a newline; Auto-retry failed sends). All three save automatically as soon as you change them; there is no Save button. Each setting is a row card with a per-row status line that confirms the change.

## Related

- [Access authentication](./access-authentication.md) — user login, passwords, and WebAuthn passkeys.
- [Project settings storage](./project-settings-storage.md) — storing project settings without writing files to your git repo.
- [Custom prompts](./custom-prompts.md) — creating and managing prompt presets.
- [Tool authorization](./tool-authorization.md) — configuring tool execution permissions.
