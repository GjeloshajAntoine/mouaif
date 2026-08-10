# Agent file picker

## Overview

A mobile-first file browser in **Settings → Project → Agent files** that adds project-relative instruction-file paths to the agent-file list by tapping files in the project. It reuses the existing `/api/files` read-only endpoint, so it adds no new server surface and can never create, edit, or delete anything.

## Usage

1. Open **Settings → Project → Agent files**.
2. Under **File names to look for**, review the current item list.
3. Type a relative path and tap **Add**, or tap **Pick** to open the project file browser.
4. In the picker, navigate folders with taps, the **↑ Up** button, or the breadcrumb path; the **×** closes it.
5. Tap a text file — its project-relative path is appended to the list (deduplicated) and the project setting autosaves.
6. Tap **Remove** on a row to delete one path, or **Use defaults** to clear the custom list.

Leaving the list empty uses the defaults (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`). Settings no longer includes a project-wide agent-file disable switch; chats control their own on/off state from the chat card or Tools popup.

## Implementation notes

- Component: `frontend/src/components/AgentFilePicker.jsx`. It calls `GET /api/files?projectDir=<abs>&dir=<abs>` (see `src/files.js` `listDir`) and reports the selected entry's `relPath` back to the parent via an `onPick(relPath)` callback.
- Wired in `frontend/src/components/SettingsProject.jsx`: the **Pick** button opens the overlay; `onAgentFilePicked` appends the deduped relative path and reuses the `agentFileNames` autosave path.
- The item list persists only `agentFileNames` in `.mouaif.json`. Saving the list also unsets the removed `agentFiles` project gate, and an empty list unsets `agentFileNames` to restore the defaults.
- Styles live in `frontend/src/settings.css` (`.afp__*` overlay/rows plus `.settings-project__file-*` list rows and `.settings-project__afn-row` layout). The modal mirrors the file-editor overlay: full-screen sheet on mobile, centered dialog on ≥720 px, same `fe__fade-in` animation, and explicit top/bottom safe-area padding so its header stays below the status bar.
- Read-only by design: the picker is a source for the file-name setting only; it never writes files.
