# Native file tools

## Overview

`mouaif` ships built-in tools the model can call to read, list, search, create, and safely edit project files — `read_file`, `list_files`, `search_files`, `write_file`, and `edit_file`. They are wired through the same tool pipeline as `shell` (decisions §16), so the model sees them as ordinary function calls and the chat UI renders them as the same tool-call / tool-result cards. Every call is gated by the per-project authorization module (decisions §17) and refuses any path that escapes the project root.

The tools cover the common "find the file, read the file, edit the file" loop without requiring an MCP server. They are not a replacement for `shell` (a model that wants to run a build, install a dep, or `git diff` still uses `shell`) and they are not a replacement for MCP (third-party tool ecosystems — Postgres, Playwright, GitHub — still come in via `mcp__<server>__<tool>`). They are the boring file primitives every agent needs.

## Usage

### Availability

- Native file tools are always included in the base tool declaration.
- **Settings → Project → Tools → File tools authorization** controls execution for the family: `ask` by default, `off` to reject calls, or `allow` to run without prompting.
- Individual file-tool leaf checkboxes can store a per-operation `off` override. They cannot make a family-level `allow` fall back to `ask`.
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
| `list_files` | List text files under the project. | — | `pattern` (glob; a bare directory like `src` is treated as `src/**`, and matching is case-insensitive) |
| `search_files` | ripgrep-style text search. | `query` (regex source) | `path` (scope to a directory or single file; `.`, `./`, `src`, `src/`, `src/file.js` are accepted, and a misspelled or not-yet-created directory still searches its nearest existing ancestor) |
| `write_file` | Create or overwrite a text file. | `path`, `content` | — |
| `edit_file` | Replace one unique block in an existing file. Line-ending differences are ignored, and formatter-only differences such as indentation, blank lines, line wrapping, and spaces around punctuation are tolerated. A block that matches on trimmed lines is also **re-indented to the file's indentation depth** so the replacement lands where a native edit would. A JSON-escaped block is unescaped and retried once before the match is declared missing. Changed code still fails, ambiguous matches return `EMULTI_MATCH`, and failed matches return `ENO_MATCH` with a line-numbered closest candidate. | `path` (or `file`), `oldText`, `newText` | — |

Every tool:

- Refuses paths that escape the project root with `EOUTSIDE_PROJECT` (`. .`, absolute paths outside the root, and symlinks that point outside are all rejected).
- Skips generated/private directories during walks (`node_modules`, `.git`, `.mouaif`, `dist`, `build`).
- Refuses whole-file reads over `fileReadMaxLines` (default 10000 lines). A `startLine` / `endLine` slice bypasses the cap.
- Honors per-project [hide-file-content](./hide-file-content.md) rules: `read_file` returns `[hidden]` for each marked line, and `search_files` skips matches on marked lines. `write_file` / `edit_file` and `list_files` are unaffected.
- Caps `write_file` content at `fileWriteMaxBytes` (default 1 MB).
- Caps `list_files` at `fileListMaxEntries` entries (default 1000) and `search_files` at `fileSearchMaxMatches` matches / `fileSearchMaxBytes` chars scanned (default 200 / 2 MB; the counter counts characters, not bytes). When a search is truncated, the cap values appear inline in the `# Matches` header line.

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

<file body>
```

`list_files` groups entries by directory (one `# dir/` header per group, then bare filenames) so the path prefix is printed once instead of on every row:

```text

  auth.js
  logout.js
  new.js
```

`search_files` groups matches by file the same way — one `# path` header per file, then `line: text` rows:

```text

1: export function login() {}
1: export function logout() {}
```

```text
```

The chat UI gets a richer object on the `tool_result` SSE event (full result, no header), so it can show the path and a one-line summary on the inline card. When a file-tool result reaches the UI as the plain-text header form above (subagent-nested results, tool-replay from the message store, or the model-facing `content` string), the frontend re-parses it back into the structured shape: it reads the `# Count:` / `# Matches:` (and `# Skipped:`) header lines and rebuilds the `entries` / `matches` arrays from the grouped body, so the card's count and the collapsed "N files" / "N matches" summary are accurate and consistent with the object path.

The collapsed summary flags truncation instead of presenting a capped total as complete. A truncated `list_files` card reads `1000 files (capped at 1000)` and a truncated `search_files` card reads `200 matches (capped at 200)`, matching the inline header the model already receives (`# Count: N (capped at M)` / `# Matches: N (capped at M matches / B chars)`). The text-reparse path extracts the same `truncated` + cap fields from those header lines, so subagent-nested results and message-store replays show the same annotation as the live SSE path.

## Related

- Decisions: [docs/decisions.md §16](../decisions.md) (shell tool), [docs/decisions.md §17](../decisions.md) (tool authorization), [docs/decisions.md §18](../decisions.md) (MCP).
- Shell tool: [docs/features/shell-tool.md](./shell-tool.md). File tools share the same authorization gate and the same UI card shape.
- Tool authorization: [docs/features/tool-authorization.md](./tool-authorization.md). The four modes and the SSE / REST surface.
- File tagging: [docs/features/file-tagging.md](./file-tagging.md). Tagged files are auto-injected into the system prompt — file tools let the model read on demand, which complements tagging for files the user did not pre-attach.
