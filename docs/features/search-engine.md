# Project search engine

## Overview

`search_files` — the built-in tool the model uses to grep the project — runs on **ripgrep** when a binary is available on the machine, and on a bounded JavaScript walk when it is not. Both backends return the identical result object, so the tool, the chat card, and the redaction rules cannot tell which one ran.

The rewrite replaced a hand-written walker that read every allowlisted file in full with a `RegExp.test` per line. On this repository that walker needed 843 file reads and 27,680 re-reads of `.mouaif.json` to answer one query: 12.6 s for a whole-project search. The same query now takes ~30 ms.

## Usage

### Nothing to configure

The engine is a drop-in replacement for the previous walker. The tool name, its arguments, its result shape, and its authorization gate are unchanged, so existing chats, transcripts, and prompt profiles keep working.

### Which backend ran

The result carries an `engine` field (`"ripgrep"` or `"walk"`). It is sent on the `tool_result` event and is visible in the trace file, which is the fastest way to tell why two machines returned slightly different match sets.

### Binary discovery

The ripgrep binary is looked up in this order, and the answer is cached for the process:

1. `MOUAIF_RG_PATH` — an explicit path, for a machine that keeps its own copy somewhere unusual.
2. `PATH` — a system `rg`.
3. Bundled copies shipped inside tools the app already integrates with: the VS Code / Cursor server's `@vscode/ripgrep`, and the packaged codex CLI's `rg`.

Two environment variables control the lookup:

| Variable | Effect |
| --- | --- |
| `MOUAIF_RG_PATH` | Use this binary. |
| `MOUAIF_RG_DISABLE` | Never use ripgrep; always use the walk. |

The fallback is not a degraded mode: it enforces the same caps and the same redaction rules. It is slower, and it can pick a slightly different set of files: it reads the project's top-level `.gitignore` only, while ripgrep also honours `.gitignore` files in subfolders.

### What the search sees

| Rule | Detail |
| --- | --- |
| Ignore files | The project's `.gitignore` is honored **even when the directory is not a git repository**. ripgrep gets `--no-require-git` plus an absolute `--ignore-file`, because on its own it only reads ignore files inside a repo. |
| Hidden files | Searched. `.github/workflows/ci.yml` is project source. |
| Skipped directories | `node_modules`, `.git`, `.mouaif`, `dist`, `build`, `.cache`. These exclusions are applied **after** the caller's `include`, so no glob can re-include a skipped tree. |
| Extensionless files | Searched, so `Dockerfile`, `Makefile` and `LICENSE` are reachable. |
| Unknown extensions | Skipped in the walk backend (a stray `dump.001` or a photo is not source). ripgrep decides by content, so it searches any file that is text. |
| Binary files | Skipped. |
| Global ignore files | Not applied (`--no-ignore-global`): a developer's personal `~/.gitignore` is not part of the project. |
| `.ripgreprc` | Not applied (`--no-config`): a project config file must not silently change what the model sees. |

### Redaction

[hide-file-content](./hide-file-content.md) applies to both backends, unchanged in intent, and it is **line-granular by construction**: every row a search returns is one line of one file.

- A match on a hidden **line** is dropped.
- A match inside a hidden **character span** is dropped. ripgrep reports byte offsets, which are converted to the 1-indexed character columns the rules are stored in, so a multi-byte character counts as one column.
- If *any* occurrence on a matching line falls inside a hidden span, the whole line is dropped. Printing the line because only one of its three occurrences was hidden would hand the model the redacted text.
- Rules are read **once per search**. This is the fix for the per-line settings re-read that made the old engine slow; it also means a rule saved mid-search applies to the next search, not the running one.
- If the rules cannot be read, the search behaves exactly as if none were configured.

Because a row is a line, a **multi-line match cannot be redacted** and is therefore refused rather than returned. `(?s)` — dot-matches-newline — is rejected with `EBADINPUT`, and the ripgrep backend additionally drops any record whose text contains a newline, in case an engine reports one anyway. See *Regex dialect* below.

### Arguments

| Argument | Required | Notes |
| --- | --- | --- |
| `query` | yes | A ripgrep-style regular expression, matched one line at a time. |
| `path` | no | A directory or a single file. `.`, `./`, `src`, `src/`, `src/file.js` are accepted. A path that does not exist yet searches its **nearest existing ancestor**, so `src/util` searches `src/` instead of returning nothing. |
| `include` | no | A glob to filter the files searched: `*.js`, `*.{ts,tsx}`, `src/**/*.test.js`, `src/[ab].js`. A leading `!` or `/` is stripped rather than honored, so an `include` can never turn into an exclusion — and a skipped directory (`node_modules`, `.git`, `dist`, ...) stays skipped even if the glob names it. |

### Regex dialect

The engine speaks the real ripgrep dialect:

- `(?i)foo` — case-insensitive. Peeling this off the front of the pattern into `--ignore-case` makes it work on ripgrep builds compiled without PCRE2.
- `(?P<name>...)` — named capture groups, passed through.

Three constructs are rejected with a typed `EBADINPUT` error whose message names the problem, rather than a bare regex parse failure:

```text
(?s) / dot-matches-newline is not supported: matches are reported and redacted per line; search for the two anchors separately
lookahead / lookbehind are not supported; use a capture group or two searches instead
backreferences (\1) are not supported; rewrite the pattern without them
```

`(?s)` is refused on **both** backends. It used to be translated into `--multiline --multiline-dotall` on the ripgrep path and silently ignored on the walk path, so one query meant two different things; worse, ripgrep reports a dot-matches-newline match as a single record whose `line_number` is only the *first* line, so a hidden line in the middle of the match was printed verbatim. A per-line engine cannot redact a multi-line result, so it does not accept one.

### Caps

`fileSearchMaxMatches` (default 200) and `fileSearchMaxBytes` (default 2 MB) are app-level settings, overridable in the app store:

```json
{
  "fileSearchMaxMatches": 100,
  "fileSearchMaxBytes": 1048576
}
```

A truncated search says so, and the cap values appear in the header the model reads:

```text
# Search: login
# Matches: 200 (capped at 200 matches / 2097152 chars)
```

## Related

- [file-tools.md](./file-tools.md) — the tool family this engine belongs to.
- [hide-file-content.md](./hide-file-content.md) — the redaction rules both backends enforce.
- [trace.md](./trace.md) — where the `engine` field shows up per chat.
