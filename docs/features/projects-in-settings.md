# Projects in Settings
## Overview
The Settings tab lists every **registered project** under **Settings → Providers → Projects**. This is the same registry the Chats tab shows as project cards — it is reachable from Settings so the project list is not hidden behind the Chats tab only. Each row opens that project's settings; the row's overflow menu offers the same rename / unregister actions available on the project cards.
## Usage
- Open **Settings → Providers → Projects** to see the registered folders.
- Tap a row to open that project's **Project settings** (prompt style, tools, agents, MCP servers).
- Tap the `⋯` menu on a row to **Rename…** (changes the display label only) or **Unregister** (forgets the folder; the folder on disk is never touched).
- Tap the **+** button to open the existing **new-project folder picker** and register a folder.
- Tap the back arrow to return to Settings.
## HTTP surface
The view uses the existing registered-project endpoints — no new server endpoints:
| Method | Path | Response |
|--------|------|----------|
| GET    | `/api/projects/registered` | `{ projects: [{ id, path, name, createdAt, totalCost }] }` |
| PATCH  | `/api/projects/registered/:id` | `{ project }` (rename) |
| DELETE | `/api/projects/registered/:id` | `{ ok: true }` (unregister) |
## Implementation notes
- Source: [frontend/src/components/SettingsProjects.jsx](../../frontend/src/components/SettingsProjects.jsx).
- Route: `#/settings/projects` maps to `settingsProjects` in [frontend/src/router.js](../../frontend/src/router.js) and renders `SettingsProjectsView` in [frontend/src/components/App.jsx](../../frontend/src/components/App.jsx).
- The Settings home row lives in [frontend/src/components/SettingsHome.jsx](../../frontend/src/components/SettingsHome.jsx) under the **Providers** group.
- Styles are in [frontend/src/settings.css](../../frontend/src/settings.css) (`.sprojects__*`).
- Registered-project storage is unchanged: projects live in app settings under the `projects` key, per [docs/features/folder-picker.md](./folder-picker.md).
## Related
- [New-project folder picker](folder-picker.md)
- [Project card](project-card.md)
- [App and project settings](app-and-project-settings.md)
