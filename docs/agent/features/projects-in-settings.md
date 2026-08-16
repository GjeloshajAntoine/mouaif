# Projects in Settings — implementation notes

> Agent-facing reference for [`docs/features/projects-in-settings.md`](../../features/projects-in-settings.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

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
