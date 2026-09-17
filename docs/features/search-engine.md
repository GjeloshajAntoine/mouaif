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
  [--ignore-case] \
  [--ignore-file <root>/.gitignore] \
  [-g '<include>'] -g '!**/node_modules/**' ... [-g '/<single file>'] \
  -- <pattern> .
```

The child's stdout is parsed as NDJSON with a line buffer, because a chunk boundary can split a JSON record. A `match` record per matching line carries the line number, the line text, and the submatches, and it is the only record type this engine reads: ripgrep emits its per-file `begin` / `end` records **lazily**, so they only appear for files that matched and cannot be used to count the files that were searched. See *`filesScanned`* below. The regex is passed after `--` so a pattern that begins with `-` is not read as a flag.

There is no `--multiline`: `(?s)` is refused before the child is spawned.

`-g` order is load-bearing. ripgrep applies globs in sequence and a later one can re-include what an earlier one excluded, so the caller's `include` is pushed **before** the `SKIP_DIRS` exclusions and the single-file anchor. With the include last, `include: "**/node_modules/**"` returned vendored files that this tool documents as never searched.

The child is bounded three ways: `--max-count` keeps a match-everything pattern from flooding the pipe, and a 60 s kill timer plus a 500 ms grace period after the cap is reached keeps a wedged process from hanging the tool call. A child that exits non-zero with a usage error causes a fallback to the walk rather than a failed call, which is what makes an old ripgrep build survivable.

`--max-columns` is **not** one of those bounds on the JSON path. It limits what ripgrep prints on a plain-text run; a `--json` record still carries the whole `lines.text` (measured: a 160 KB single line arrived in full). What keeps a minified one-line bundle from running away is the line cap in `scanContent`/`consumeRgLine` — a row's text is truncated to 240 characters before it is returned — plus the match cap and the kill timer.

### `filesScanned`

`filesScanned` is the number of files that produced **at least one match** — the "N files" the chat card shows beside "N matches" — and both backends compute it the same way: a `Set` of the matched paths.

It briefly counted ripgrep's `begin` **and** `end` records, which reported double the real file count, and it could not have meant "files opened" anyway: ripgrep emits `begin` lazily, so the files it opened without matching are never mentioned in the NDJSON at all. "Files opened" is a number only the walk backend can honestly produce, and a field that means two different things per backend is worse than one that means one thing.

### The walk backend

The fallback keeps the walker's behavior but fixes what made it slow and incomplete:

- The redaction rules are read once per search instead of once per line.
- Files are read through a pool of 16 concurrent readers instead of one at a time.
- Extensionless files are searched.
- `.gitignore` is applied through a deliberately small reader (comments, blank lines, trailing `/`, leading `/`, `**`, and `!` re-includes). It is a best-effort match of git semantics, not a complete implementation: nested `.gitignore` files are not read.
- The `include` glob is translated by the same module the ripgrep path relies on, so brace alternation (`*.{ts,tsx}`) and character classes (`src/[ab].js`) select the same files on both backends. The walker used to escape `{`, `}`, `[` and `]`, which meant a glob the documentation advertises returned matches under ripgrep and nothing at all without it.
- Redaction is checked the way ripgrep's is: a hidden **line** drops the row even when the pattern matched elsewhere on that line, and **every** occurrence on the line is tested against the hidden character spans. The walker used to test only the first occurrence, because `RegExp.exec` on a non-global pattern always reports the first one — so a line reading `const DUP = 1; const DUP = 2;` with the second `DUP` hidden returned the line, hidden copy and all. A per-occurrence scan needs a global clone of the pattern, and a zero-width match (`^`, `x?`) is tested against the single column it sits at. Files with no redaction rule skip all of this.

The walk skips `node_modules`, `.git`, `.mouaif`, `dist`, `build`, `.cache`, plus a `GENERATED_DIRS` list (`docs-dist`, `coverage`, `.next`, `target`, `vendor`, `__pycache__`, `.venv`, ...) so a checked-out build tree cannot consume the read ceiling before `src/` is reached.

### Why the byte cap bounds the answer, not the walking

The walk has to read a file to know whether it matches, so the tool-level byte budget cannot be allowed to decide *which* files get looked at. Spending it in directory order meant `docs/features/*.html` exhausted the 2 MB budget before `src/` was reached, and a search for a function in `src/` came back empty. The reported cap therefore bounds the **matched line text** added to the answer, and a separate read ceiling (`WALK_MAX_BYTES`, 64 MB) exists only to stop a pathological tree from being read forever. Being skipped is recorded as `filesSkipped`; being capped is recorded as `truncated`. They are not the same claim, and the model should not act on a truncation notice that did not happen.

### Verifying a change here

```bash
node scripts/test-search-engine.js
```

The suite runs every assertion twice — once per backend — and skips the ripgrep pass on a machine without a binary. It builds a fixture with an extensionless file, a `.gitignore`-excluded tree, a binary file, a hidden directory, a hidden line, and a hidden character span, and covers pattern normalization, `include` (braces, character classes, and the skipped-directory guard), path scoping, all three error classes, both redaction forms, `filesScanned`, and the caps.

Anything a backend does differently is a bug, and the way to find one is to run the same query through both:

```bash
node scripts/test-search-engine.js                 # ripgrep, then walk
MOUAIF_RG_DISABLE=1 node scripts/test-search-engine.js   # walk only
```

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
