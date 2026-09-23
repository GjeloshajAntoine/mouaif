# Web preview page (project settings) — implementation notes

> Agent-facing reference for [`docs/features/webpreview-project-page.md`](../../features/webpreview-project-page.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- `frontend/src/components/SettingsProject.jsx` renders the new `page === 'preview'` branch and reuses `PreviewUrlPrompt.jsx` (URL entry) and `WebpreviewModal.jsx` (full-screen viewer).
- Capture runs through `requestWebpreview()` (the same client helper the chat viewer uses) from `frontend/src/api.js`.
- The endpoint is scoped to a chat for the authorization session and trace. The page resolves a chat quietly: it prefers the chat it was opened from (via `?chatId=`), otherwise the most recently opened chat for the project (`GET /api/chats?projectDir=...&limit=1`).
- `frontend/src/routes.js` maps `#/settings/project/preview` to `settingsProjectPreview`; `frontend/src/components/App.jsx` routes it to `SettingsProjectView` with `page: 'preview'`.
- `frontend/src/settings.css` adds `.settings-project__preview-*` styles for the capture thumbnail.
