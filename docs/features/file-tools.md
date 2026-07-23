# Native file tools

## Overview

`mouaif` ships built-in tools the model can call to read, list, search, create, and safely edit project files — `read_file`, `list_files`, `search_files`, `write_file`, and `edit_file`. They are wired through the same tool pipeline as `shell` (decisions §16), so the model sees them as ordinary function calls and the chat UI renders them as the same tool-call / tool-result cards. Every call is gated by the per-project authorization module (decisions §17) and refuses any path that escapes the project root.

The tools cover the common "find the file, read the file, edit the file" loop without requiring an MCP server. They are not a replacement for `shell` (a model that wants to run a build, install a dep, or `git diff` still uses `shell`) and they are not a replacement for MCP (third-party tool ecosystems — Postgres, Playwright, GitHub — still come in via `mcp__<server>__<tool>`). They are the boring file primitives every agent needs.

## Usage

### Availability

- Native file tools are always included in the base tool declaration.
- **Settings → Project → Tools → File tools authorization** controls execution: `ask` by default, `off` to reject calls, or `allow` to run without prompting.
- Legacy `tools.file.enabled` values remain readable but no longer affect detection.

### Authorization modes

- **off** — the runner returns `ETOOL_DISABLED` for every call.
- **ask** — every call shows an "Authorization required" card. The card carries the path, the tool name, and a preview of the body for `read_file` / `write_file` / `edit_file`. The user picks **Allow once**, **Allow for this session**, or **Deny**.
- **allowlist** — calls whose `path` matches a regex in the per-project allowlist run without prompting. Everything else falls through to `ask`.
- **allow** — every call is auto-approved across chats and restarts. The authorization card's **Always allow** action persists this mode.

The mode, allowlist, and timeouts live in `<projectDir>/.mouaif.json` under `tools.file` (parallel to `tools.shell`). The shape is:

```json
{
  "tools": {
    "file": {
      "enabled": true,
      "mode": "ask",
      "allowlist": ["^src/.*\\.js$", "^README\\.md$"]
    }
  }
}
```

### The file tools

| Tool | Purpose | Required args | Optional args |
|---|---|---|---|
| `read_file` | Read a text file. | `path` (POSIX-relative) | `startLine`, `endLine` (1-indexed inclusive) for slicing large files |
| `list_files` | List text files under the project. | — | `pattern` (glob) |
| `search_files` | ripgrep-style text search. | `query` (regex source) | `path` (scope to a directory or single file; `.`, `./`, `src`, `src/`, and `src/file.js` are accepted) |
| `write_file` | Create or overwrite a text file. | `path`, `content` | — |
| `edit_file` | Replace one unique block in an existing file. Line-ending differences are ignored. | `path` (or `file`), `oldText`, `newText` | — |

Every tool:

- Refuses paths that escape the project root with `EOUTSIDE_PROJECT` (`. .`, absolute paths outside the root, and symlinks that point outside are all rejected).
- Skips generated/private directories during walks (`node_modules`, `.git`, `.mouaif`, `dist`, `build`).
- Refuses whole-file reads over `fileReadMaxLines` (default 10000 lines). A `startLine` / `endLine` slice bypasses the cap.
- Caps `write_file` content at `fileWriteMaxBytes` (default 1 MB).
- Caps `list_files` at `fileListMaxEntries` entries (default 1000) and `search_files` at `fileSearchMaxMatches` matches / `fileSearchMaxBytes` scanned (default 200 / 2 MB).

The caps are app-level knobs. Override them in the app store:

```json
{
  "fileReadMaxLines": 10000,
  "fileListMaxEntries": 500,
  "fileSearchMaxMatches": 100,
  "fileSearchMaxBytes": 1048576,
  "fileWriteMaxBytes": 2097152
}
```

### Result shape (sent back to the model)

The `tool` message the model sees is a small header followed by the body, so the model can read its own response cleanly:

```text
# File: src/index.js
# Lines: 1-72

<file body>
```

```text
# Search: function (login|logout)
# Matches: 2
# Files scanned: 4

src/auth.js:1: export function login() {}
src/logout.js:1: export function logout() {}
```

```text
# Wrote: src/utils/new.js
```

The chat UI gets a richer object on the `tool_result` SSE event (full result, no header), so it can show the path and a one-line summary on the inline card.

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/api/settings/project` | Toggle `tools.file.enabled` (same payload as `tools.shell.enabled`) |
| `GET` | `/api/tools/authorization?projectDir=…` | Read the resolved `tools.file` config |
| `PUT` | `/api/tools/authorization` | Set `tools.file.mode` / `allowlist` (same shape as `tools.shell`) |
| `GET` | `/api/chats/:id/tool-preview?projectDir=…` | Returns the file-tool specs the model would see, with `fileToolsEnabled: true/false` and the five entries listed in `tools` |

The file tools are dispatched by the same `tool_call` flow as the shell tool inside the AI client. There is no separate `/api/tools/file/*` HTTP endpoint — the model-facing tools all run in-process through the same dispatcher.

## Implementation notes

- New module: [src/tools/files.js](../../src/tools/files.js). Public surface: `SPECS` (five OpenAI-compatible function specs), `FILE_TOOL_NAMES` (frozen array of the five), `isFileToolName(name)`, `runFileTool(name, opts)`, `resolveSandbox(projectDir)` (re-export of the shell tool's helper for parity).
- The AI client collects file-tool specs alongside shell and MCP specs in [src/ai.js](../../src/ai.js) `streamChat` and reduces them through `promptProfiles.reduceToolSpecs` like every other advertised tool, so the per-profile tool budget is uniform across shell, file, and MCP.
- The dispatcher in `streamChat` (`dispatchTool` in [src/ai.js](../../src/ai.js)) routes all five names to `runFileTool`. `write_file` intentionally writes the complete supplied body. `edit_file` is a distinct, non-destructive replacement operation: it accepts `path` or `file`, requires `oldText` and `newText`, and returns `ENO_MATCH` or `EMULTI_MATCH` without changing the file when the target is stale or ambiguous. Matching treats `LF`, `CRLF`, and legacy `CR` as equivalent, then maps the match back to the original source offsets; replacement lines use the target file's dominant line ending, so an LF payload can safely edit a CRLF checkout without producing mixed endings. It writes through a temporary sibling and rename so interruption cannot leave a partial file.
- The authorization module ([src/tools/authorization.js](../../src/tools/authorization.js)) now treats `file` as a native tool alongside `shell`. The `NATIVE_TOOLS = new Set(['shell', 'file'])` set is the single source of truth; adding a future native tool is a one-line addition. The per-tool summary on the "Authorization required" card is `args.path` for file tools (so the allowlist regex can match the path), `args.cmd` for `shell`, and the first string argument for MCP tools.
- The path-safety contract is the same as [src/tags.js](../../src/tags.js): every model-supplied path is normalized to POSIX-relative, then resolved back through `realpath` (walking up to the first existing ancestor for `write_file`-style paths that don't exist yet), with the same `EOUTSIDE_PROJECT` error shape. Symlinks that point outside the project root are rejected.
- Mobile UI ([src/web/src/components/SettingsProject.jsx](../../src/web/src/components/SettingsProject.jsx)): a second card under the shell tool, "File tools", with the same toggle, mode `<select>`, allowlist `<textarea>`, and Save button. The same `card` / `row` / `hint` styles as the shell tool.
- Tests: [scripts/test-file-tools.js](../../scripts/test-file-tools.js). Coverage includes glob compilation, OpenAI spec shape, `resolveSandbox`, every tool's happy path and error paths (`EOUTSIDE_PROJECT`, `EBADINPUT`, `ETOOL_CAP`, `EUNKNOWN_TOOL`, `ENOENT`), line-ending-tolerant `edit_file` matching in both directions, mixed-ending ambiguity detection, the `list_files` skip-dir behavior, the `search_files` path-filter and bad-regex paths, the `write_file` overwrite + nested-directory creation, and the `fileReadMaxBytes` cap override.

## Related

- Decisions: [docs/decisions.md §16](../decisions.md) (shell tool), [docs/decisions.md §17](../decisions.md) (tool authorization), [docs/decisions.md §18](../decisions.md) (MCP).
- Shell tool: [docs/features/shell-tool.md](./shell-tool.md). File tools share the same authorization gate and the same UI card shape.
- Tool authorization: [docs/features/tool-authorization.md](./tool-authorization.md). The four modes and the SSE / REST surface.
- File tagging: [docs/features/file-tagging.md](./file-tagging.md). Tagged files are auto-injected into the system prompt — file tools let the model read on demand, which complements tagging for files the user did not pre-attach.
