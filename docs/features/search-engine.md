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

The fallback is not a degraded mode: it enforces the same caps and the same redaction rules. It is slower and its file set is slightly different, which is documented under *Implementation notes*.

### What the search sees

| Rule | Detail |
| --- | --- |
| Ignore files | The project's `.gitignore` is honored **even when the directory is not a git repository**. ripgrep gets `--no-require-git` plus an absolute `--ignore-file`, because on its own it only reads ignore files inside a repo. |
| Hidden files | Searched. `.github/workflows/ci.yml` is project source. |
| Skipped directories | `node_modules`, `.git`, `.mouaif`, `dist`, `build`, `.cache`. |
| Extensionless files | Searched, so `Dockerfile`, `Makefile` and `LICENSE` are reachable. |
| Unknown extensions | Skipped in the walk backend (a stray `dump.001` or a photo is not source). ripgrep decides by content, so it searches any file that is text. |
| Binary files | Skipped. |
| Global ignore files | Not applied (`--no-ignore-global`): a developer's personal `~/.gitignore` is not part of the project. |
| `.ripgreprc` | Not applied (`--no-config`): a project config file must not silently change what the model sees. |

### Redaction

[hide-file-content](./hide-file-content.md) applies to both backends, unchanged in intent:

- A match on a hidden **line** is dropped.
- A match inside a hidden **character span** is dropped. ripgrep reports byte offsets, which are converted to the 1-indexed character columns the rules are stored in, so a multi-byte character counts as one column.
- If *any* occurrence on a matching line falls inside a hidden span, the whole line is dropped. Printing the line because only one of its three occurrences was hidden would hand the model the redacted text.
- Rules are read **once per search**. This is the fix for the per-line settings re-read that made the old engine slow; it also means a rule saved mid-search applies to the next search, not the running one.
- If the rules cannot be read, the search behaves exactly as if none were configured.

### Arguments

| Argument | Required | Notes |
| --- | --- | --- |
| `query` | yes | A ripgrep-style regular expression. |
| `path` | no | A directory or a single file. `.`, `./`, `src`, `src/`, `src/file.js` are accepted. A path that does not exist yet searches its **nearest existing ancestor**, so `src/util` searches `src/` instead of returning nothing. |
| `include` | no | A glob to filter the files searched: `*.js`, `*.{ts,tsx}`, `src/**/*.test.js`. A leading `!` or `/` is stripped rather than honored, so an `include` can never turn into an exclusion. |

### Regex dialect

The engine speaks the real ripgrep dialect, which is wider than the JavaScript `RegExp` the old documentation described:

- `(?i)foo` — case-insensitive. Peeling this off the front of the pattern into `--ignore-case` makes it work on ripgrep builds compiled without PCRE2.
- `(?s)f.o` — dot matches newline, passed as `--multiline --multiline-dotall`.
- `(?P<name>...)` — named capture groups, passed through.

Two constructs are rejected with a typed `EBADINPUT` error whose message names the problem, rather than a bare regex parse failure:

```text
lookahead / lookbehind are not supported; use a capture group or two searches instead
backreferences (\1) are not supported; rewrite the pattern without them
```

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

## Implementation notes

### Files

- [src/tools/searchEngine.js](../../src/tools/searchEngine.js) — both backends, binary discovery, pattern normalization, path scoping.
- [src/tools/files.js](../../src/tools/files.js) — `runSearchFiles()` is now a thin adapter that delegates to the engine; the formatter is unchanged.
- [src/hideFileContent.js](../../src/hideFileContent.js) — `buildRuleIndex()`, `rulesForPathIn()`, `lineIsHiddenIn()`, `matchIsHiddenIn()`.

### One settings read per search

`buildRuleIndex(projectDir)` reads the project settings once and returns three things: the normalized rules, a `Map` from normalized path to rule, and a `Map` from path **suffix** to the rules that match it. The suffix map is a safety net for the redaction feature: a rule that fails to match its file is a leak, not a cosmetic bug, so a rule written as `src/a.js` also applies to a path reported as `./src/a.js`.

`normalizePath()` gained a leading-`./` strip that previously never ran (the statement preceded its own `let s`), so a rule saved as `./src/a.js` used to be silently dead.

### The end-to-end architecture

```text
search_files(query, path?, include?)
        │
        ├─ normalizePattern()        peel (?i) / (?s) into CLI flags
        ├─ assertPatternSupported()  typed EBADINPUT for lookaround / \1
        ├─ resolveScope()            path -> { root, dir, relDir, relFile }
        │
        ├─ findRipgrepBinary() ── yes ──> runRipgrep()
        │                                   spawn rg --json, stream NDJSON,
        │                                   map byte offsets -> char columns,
        │                                   filter through the rule index
        │                                 └─ any spawn / usage error -> walk
        └───────────────────────── no ──> runWalk()
                                           16 concurrent readers, same caps,
                                           rules read once, same result shape
```

### ripgrep invocation

```text
rg --json --no-config --no-require-git --line-number --with-filename \
   --hidden --no-ignore-global --max-count <n> \
   --max-columns 500 --max-columns-preview \
   [--ignore-case] [--multiline --multiline-dotall] \
   [--ignore-file <root>/.gitignore] \
   -g '!**/node_modules/**' ... [-g '/<single file>'] [-g '<include>'] \
   -- <pattern> .
```

The child's stdout is parsed as NDJSON with a line buffer, because a chunk boundary can split a JSON record. `begin` and `end` records count searched files (so `filesScanned` stays meaningful); `match` records carry the line number, the line text, and the submatches. The regex is passed after `--` so a pattern that begins with `-` is not read as a flag.

The child is bounded three ways: `--max-columns`/`--max-columns-preview` keeps a minified one-line bundle from printing megabytes, `--max-count` keeps a match-everything pattern from flooding the pipe, and a 60 s kill timer plus a 500 ms grace period after the cap is reached keeps a wedged process from hanging the tool call. A child that exits non-zero with a usage error causes a fallback to the walk rather than a failed call, which is what makes an old ripgrep build survivable.

### The walk backend

The fallback keeps the walker's behavior but fixes what made it slow and incomplete:

- The redaction rules are read once per search instead of once per line.
- Files are read through a pool of 16 concurrent readers instead of one at a time.
- Extensionless files are searched.
- `.gitignore` is applied through a deliberately small reader (comments, blank lines, trailing `/`, leading `/`, `**`, and `!` re-includes). It is a best-effort match of git semantics, not a complete implementation: nested `.gitignore` files are not read.

The walk skips `node_modules`, `.git`, `.mouaif`, `dist`, `build`, `.cache`, plus a `GENERATED_DIRS` list (`docs-dist`, `coverage`, `.next`, `target`, `vendor`, `__pycache__`, `.venv`, ...) so a checked-out build tree cannot consume the read ceiling before `src/` is reached.

### Why the byte cap bounds the answer, not the walking

The walk has to read a file to know whether it matches, so the tool-level byte budget cannot be allowed to decide *which* files get looked at. Spending it in directory order meant `docs/features/*.html` exhausted the 2 MB budget before `src/` was reached, and a search for a function in `src/` came back empty. The reported cap therefore bounds the **matched line text** added to the answer, and a separate read ceiling (`WALK_MAX_BYTES`, 64 MB) exists only to stop a pathological tree from being read forever. Being skipped is recorded as `filesSkipped`; being capped is recorded as `truncated`. They are not the same claim, and the model should not act on a truncation notice that did not happen.

### Verifying a change here

```bash
node scripts/test-search-engine.js
```

The suite runs every assertion twice — once per backend — and skips the ripgrep pass on a machine without a binary. It builds a fixture with an extensionless file, a `.gitignore`-excluded tree, a binary file, a hidden directory, a hidden line, and a hidden character span, and covers pattern normalization, `include`, path scoping, both error classes, both redaction forms, and the caps.

For spot checks against ground truth:

```bash
# the walk backend must agree with git for tracked content
MOUAIF_RG_DISABLE=1 node scripts/test-search-engine.js
git grep -n resolveSandbox
```

## Related

- [file-tools.md](./file-tools.md) — the tool family this engine belongs to.
- [hide-file-content.md](./hide-file-content.md) — the redaction rules both backends enforce.
- [trace.md](./trace.md) — where the `engine` field shows up per chat.
