# Project search engine — implementation notes

> Agent-facing reference for [`docs/features/search-engine.md`](../../features/search-engine.md). The human-facing surface lives in that file; the implementation details, wire shapes, and source paths live here.

## Files and ownership

| File | Owns |
| --- | --- |
| [src/tools/searchEngine.js](../../src/tools/searchEngine.js) | Both backends, ripgrep discovery, pattern normalization, path scoping, the `include` glob, the walk's ignore reader. |
| [src/tools/files.js](../../src/tools/files.js) | `runSearchFiles()` adapter, the OpenAI function spec, `formatSearchFilesResult()` (unchanged), the `SPECS` export. |
| [src/hideFileContent.js](../../src/hideFileContent.js) | `buildRuleIndex()`, `rulesForPathIn()`, `ruleForPathIn()`, `lineIsHiddenIn()`, `matchIsHiddenIn()`. |
| [scripts/test-search-engine.js](../../../scripts/test-search-engine.js) | The per-backend suite. |

`searchEngine.js` exports `runSearch`, `findRipgrepBinary`, `normalizePattern`, `resolveScope`, `sanitizeInclude`, `includeMatches`, `escapeGlob`, `collectCandidates`, `loadGitignore`, `_clearRipgrepCache`, `TEXT_EXTS`, `SKIP_DIRS`, `DEFAULT_MAX_MATCHES`, `DEFAULT_MAX_BYTES`. The last two are internal-but-exported so a test can drive a backend directly.

## Result shape

```js
{
  query: 'resolveSandbox',
  matches: [{ path: 'src/tools/files.js', line: 93, text: 'function resolveSandbox(projectDir) {' }],
  filesScanned: 10,
  truncated: false,
  engine: 'ripgrep',        // or 'walk'
  capMatches: 200,          // only when truncated
  capBytes: 2097152,        // only when truncated
  filesSkipped: 4           // walk backend only, and only when it skipped any
}
```

`filesScanned` counts files the backend actually looked at: `begin` + `end` records for ripgrep, read attempts for the walk. `filesSkipped` is walk-only and never implies `truncated` — those files were untried, not reported as matches.

## Redaction — the safety-critical part

The rule index is built once per search:

```js
const ruleIndex = hideFileContent.buildRuleIndex(projectDir);
// { rules, byPath: Map<path, rule>, bySuffix: Map<suffix, rule[]> }
```

Three properties matter, and a change to any of them is a redaction-leak change:

1. **Suffix matching.** `rulesForPathIn()` tries an exact normalized match, then a suffix match on a `/` boundary. The two backends can report a path differently (`./src/a.js` vs `src/a.js`, absolute vs project-relative), and a rule that fails to match its file is a leak, not a cosmetic bug.
2. **Per-submatch checking, per-line reporting.** ripgrep emits one `match` record per line with a `submatches` array. If **any** submatch on the line falls on a hidden line or inside a hidden character span, the whole row is dropped. Printing the line because only one of three occurrences was hidden would hand over the redacted text.
3. **Byte offsets are not columns.** A `match` record's `absolute_offset` is a byte offset into the file; `submatches[].start/end` are byte offsets into `data.lines.text`. `submatchColumns()` converts each to 1-indexed **character** columns by decoding the byte prefix, which is the unit the stored rules use. Multi-byte characters count once. `\r` is left in place so CRLF files keep their column numbering.

`lineIsHidden()`, `matchIsHidden()`, and `ruleForPath()` keep their single-path signatures for callers that have one path and no index; they build an index internally. Do not call them per line — that is the per-line settings re-read that made the old engine slow.

## ripgrep invocation

```text
rg --json --no-config --no-require-git --line-number --with-filename \
   --hidden --no-ignore-global --max-count <max(2000, capMatches)> \
   --max-columns 500 --max-columns-preview \
   [--ignore-case] [--multiline --multiline-dotall] \
   [--ignore-file <root>/.gitignore] \
   -g '!**/<skip dir>/**' ... [-g '/<single file>'] [-g '<include>'] \
   -- <pattern> .
```

Why each non-obvious flag is there:

- `--no-config` — a project `.ripgreprc` must not silently change what the model sees.
- `--no-require-git` + `--ignore-file <absolute root>/.gitignore` — ripgrep reads ignore files natively only inside a git repository, so a plain folder of sources would get its generated trees searched. The `--ignore-file` path must be **absolute**: ripgrep resolves it against its cwd, which is the scope directory (a subdirectory), not the project root.
- `--no-ignore-global` — a developer's personal `~/.gitignore` is not part of the project.
- `--max-columns 500 --max-columns-preview` — a minified one-line bundle prints one enormous JSON record that dominates the result; the preview keeps the line while capping the payload.
- `--max-count` set to `max(2000, capMatches)` — a flood guard that leaves our own cap authoritative while streaming, so the reported count matches the setting.
- `--` before the pattern — a pattern starting with `-` is not read as a flag.
- The search root is always `.` with cwd = `scope.dir`. ripgrep's `--json` has no `--no-messages` equivalent, so progress messages cannot contaminate stdout; the parsers credit `begin`/`end` records for `filesScanned`.

The spawn is bounded three ways: `--max-columns`, `--max-count`, and a 60 s kill timer plus a 500 ms grace period after the cap is reached. A non-zero exit with a usage-looking stderr (`unrecognized|invalid|unknown flag|error:`) throws `ERGFALLBACK`, which `runSearch()` swallows to run the walk instead. **Any** non-`EBADINPUT` failure falls back; only a caller error aborts.

`consumeRgLine()` parses one NDJSON record and returns `true` when the caller should stop reading. Records are line-buffered in `runRipgrep()` because a chunk boundary can split a JSON record.

## Pattern normalization

`normalizePattern()` peels leading `(?i)` / `(?s)` / `(?is)` groups into `{ pattern, ignoreCase, multiline }`. `ignoreCase` becomes `--ignore-case` rather than staying an inline group so it also works on ripgrep builds compiled without PCRE2. A flags-only query is returned untouched so the syntax error surfaces normally.

`assertPatternSupported()` throws `EBADINPUT` for `\1`-style backreferences and for lookaround, with a message that names the construct (the tool description documents a regex, so a model that sends one deserves to be told what is wrong rather than getting a bare parse error). Named groups `(?P<name>...)` are allowed through — both engines accept them.

## The walk backend

- 16 concurrent readers pull from a pre-collected candidate list. `collectCandidates()` runs single-threaded (directory descent dominates over file reads).
- The match cap is re-checked **after** the `await` in each worker, and again immediately before each push in `scanContent()`. Workers pass the cap check in parallel, so without both checks the result overshoots the cap by up to one row per worker.
- `WALK_MAX_BYTES` (64 MB) is the read ceiling. The tool-level byte budget bounds the **matched line text** added to the answer, because the walk must read a file to know whether it matches: spending the budget alphabetically let `docs/features/*.html` exhaust it before `src/` was reached, which returned zero results for a function that exists.
- `collectCandidates()` skips `GENERATED_DIRS` (`docs-dist`, `coverage`, `.next`, `.nuxt`, `.svelte-kit`, `target`, `vendor`, `__pycache__`, `.venv`, `venv`) on top of `SKIP_DIRS`.
- `loadGitignore()` is a small reader: comments, blank lines, trailing `/`, leading `/`, `**`, and `!` re-includes. Nested `.gitignore` files are not read. It exists so the fallback's file set roughly matches ripgrep's, not to be a complete git implementation.
- Extensionless files are searched; an unknown extension with a dot is skipped.

## Environment variables

| Variable | Effect | Where it is read |
| --- | --- | --- |
| `MOUAIF_RG_PATH` | Explicit binary; wins over everything. | `resolveRipgrepBinary()` |
| `MOUAIF_RG_DISABLE` | Never use ripgrep; force the walk. This is how the suite exercises the fallback. | `resolveRipgrepBinary()` |

The resolved binary is memoized in a module-level `rgCache`; `_clearRipgrepCache()` exists only for tests.

## Things that will bite

- **ripgrep path form.** With `--json` and a `.` root, paths come back as `src/a.js` (no `./`); with a single-file target they come back as the argument, which can be `./src/a.js`. Always normalize before matching a rule.
- **`begin`/`end` counting.** `begin` records appear only for files that produce output, so a match-free search reports `stats.searches === 0`. `filesScanned` is therefore a lower bound on files visited; it is the number of files ripgrep touched and reported.
- **`docs/agent/features/*.md` is a second document tree.** A public feature doc must be mirrored here, and `scripts/build-docs.js --with-internal` is what emits it.
- **Do not "optimize" away the after-await cap check.** It is load-bearing for the cap being a hard promise.
- **Do not call `lineIsHidden(projectDir, ...)` inside a loop.** Build the index once.

## Tests

```bash
node scripts/test-search-engine.js        # both backends
node scripts/test-file-tools.js           # the tool family contract
node scripts/test-hide-file-content.js    # the REST surface + search redaction
npm run test:hidden-content               # the hidden-content stack
```

`test-search-engine.js` runs every per-engine assertion twice through `forEachEngine()`, skipping the ripgrep pass when `findRipgrepBinary()` returns null. Its fixture deliberately contains an extensionless file, a `.gitignore`-excluded tree, a `node_modules` tree, a binary file, a hidden directory, a nested directory, a hidden whole line, and a hidden character span, so a regression in any of the behaviors listed above fails the suite rather than passing silently.

Ground-truth spot check for the walk backend (tracked files only, so `.mouaif.json` and ignored trees are absent from both sides):

```bash
MOUAIF_RG_DISABLE=1 node -e "
const t=require('./src/tools/files.js');
t.runFileTool('search_files',{projectDir:process.cwd(),args:{query:'resolveSandbox'}})
 .then(r=>console.log(r.result.matches.map(m=>m.path+':'+m.line).sort().join('\n')));
"
git grep -n resolveSandbox | cut -d: -f1,2 | sort
```
