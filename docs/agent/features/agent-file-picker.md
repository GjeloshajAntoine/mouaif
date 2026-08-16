# Agent file picker — implementation notes

> Agent-facing reference for [`docs/features/agent-file-picker.md`](../../features/agent-file-picker.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Implementation notes

- Component: `frontend/src/components/AgentFilePicker.jsx`. It calls `GET /api/files?projectDir=<abs>&dir=<abs>` (see `src/files.js` `listDir`) and reports the selected entry's `relPath` back to the parent via an `onPick(relPath)` callback.
- Wired in `frontend/src/components/SettingsProject.jsx`: a `Pick file…` button next to the textarea opens the overlay; `onAgentFilePicked` appends the deduped relative path and reuses the existing `saveAgentFiles()` autosave.
- Styles live in `frontend/src/settings.css` (`.afp__*` overlay/rows + `.settings-project__afn-row` layout). The modal mirrors the file-editor overlay: full-screen sheet on mobile, centered dialog on ≥720 px, same `fe__fade-in` animation, and explicit top/bottom safe-area padding so its header stays below the status bar.
- Read-only by design: the picker is a source for the file-name setting only; it never writes files.
