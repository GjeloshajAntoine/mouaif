# Agent file picker

## Overview

A mobile-first file browser in **Settings → Project → Agent files** that lets a user fill the **File names to look for** textarea by tapping files in the project instead of typing paths by hand. It reuses the existing `/api/files` read-only endpoint (the same contract the in-chat file editor uses), so it adds no new server surface and can never create, edit, or delete anything.

## Usage

1. Open **Settings → Project → Agent files**.
2. Under **File names to look for**, tap **Pick file…**.
3. A full-screen modal opens rooted at the project directory. Navigate folders with taps, the **↑ Up** button, or the breadcrumb path; the **×** closes it.
4. Tap a text file — its project-relative path is appended to the textarea (deduplicated) and the project setting autosaves, exactly as if it had been typed.
5. Directories are navigable; binary files are greyed out and can't be picked (matching the file editor's rule).

Leaving the field empty still uses the defaults (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`). The picker is additive — it only appends, so existing hand-typed entries are preserved.

## Implementation notes

- Component: `frontend/src/components/AgentFilePicker.jsx`. It calls `GET /api/files?projectDir=<abs>&dir=<abs>` (see `src/files.js` `listDir`) and reports the selected entry's `relPath` back to the parent via an `onPick(relPath)` callback.
- Wired in `frontend/src/components/SettingsProject.jsx`: a `Pick file…` button next to the textarea opens the overlay; `onAgentFilePicked` appends the deduped relative path and reuses the existing `saveAgentFiles()` autosave.
- Styles live in `frontend/src/settings.css` (`.afp__*` overlay/rows + `.settings-project__afn-row` layout). The modal mirrors the file-editor overlay: full-screen sheet on mobile, centered dialog on ≥720 px, same `fe__fade-in` animation, and explicit top/bottom safe-area padding so its header stays below the status bar.
- Read-only by design: the picker is a source for the file-name setting only; it never writes files.
