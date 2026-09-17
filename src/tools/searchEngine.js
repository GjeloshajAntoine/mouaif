'use strict';

// Text-search engine behind the `search_files` tool.
//
// The tool used to run a hand-written JS walker: read every allowlisted file
// in full, split it into lines, and test a RegExp per line, with a call into
// hideFileContent for every line to apply the redaction rules. On this
// repository that meant 843 files / 15 MB of I/O and 27,680 re-reads of
// .mouaif.json to answer one query — 12.6 s for a full walk, ~2 s for a
// single-directory query.
//
// This module replaces that with ripgrep when a binary is available on the
// machine, and keeps a reworked JS walk for the machines where it is not.
// Both engines return the identical result object, so the tool, the formatter
// and the tests cannot tell which one ran.
//
// What the ripgrep path buys, beyond the speed:
//   - .gitignore / .ignore are honored, so a build output tree that is
//     checked in nowhere (`docs-dist/`) stops being searched.
//   - Files with no extension or an extension outside the old allowlist
//     (`Dockerfile`, `Makefile`, `LICENSE`, shell scripts) are searched.
//   - ripgrep skips binary files and detects file encodings itself.
//   - The real ripgrep regex dialect: `(?i)foo` and `(?s)f.o` now work, and
//     `(?i)` is passed through as `--ignore-case` so it also works on the
//     older ripgrep builds that ship without PCRE2.
//
// Redaction is preserved on both paths. ripgrep reports a 1-indexed line
// number and byte offsets for each submatch; the offsets are converted to
// 1-indexed character columns so a match inside a hidden character span is
// suppressed by the same `matchIsHiddenIn` predicate the walker uses. There
// is no "search without redaction" mode, and a search whose redaction rules
// cannot be read behaves exactly as if none were configured.
//
// Public surface:
//   findRipgrepBinary()        -> string | null   (cached for the process)
//   runSearch({ projectDir, args, settings }) -> Promise<result>
//
// `result` is the shape src/tools/files.js formats and the tests assert on:
//   { query, matches: [{ path, line, text }], filesScanned, truncated,
//     engine: 'ripgrep' | 'walk', capMatches?, capBytes?, filesSkipped? }
//
// src/tools/files.js re-exports DEFAULT_MAX_MATCHES / DEFAULT_MAX_BYTES as
// DEFAULT_SEARCH_MAX_MATCHES / DEFAULT_SEARCH_MAX_BYTES and reuses SKIP_DIRS
// and TEXT_EXTS, so the two modules cannot disagree about what a search sees.

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const hideFileContent = require('../hideFileContent.js');
const { err } = require('../util.js');

// Caps applied when the caller did not override them in settings.
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
// The walker still uses the old extension allowlist for files it cannot
// identify, but the list is now a fallback, not the filter: nameless files
// (no extension) are searched too, because that is where Dockerfile and
// friends live.
const TEXT_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.txt', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.yml', '.yaml', '.toml', '.ini', '.sh', '.bash', '.zsh', '.fish',
  '.lua', '.pl', '.r', '.dart', '.ex', '.exs', '.clj', '.scala',
  '.sql', '.graphql', '.vue', '.svelte', '.astro'
]);

// Directories neither engine descends into. ripgrep gets these as `-g`
// exclusions so it never walks them at all.
const SKIP_DIRS = ['node_modules', '.git', '.mouaif', 'dist', 'build', '.cache'];

// Segments the fallback walk drops from its candidate list. ripgrep excludes
// these because the project's own .gitignore lists them; the walk has no
// ignore-file engine, so it matches the generated names directly.
const GENERATED_DIRS = ['docs-dist', 'coverage', '.next', '.nuxt', '.svelte-kit', 'target', 'vendor', '__pycache__', '.venv', 'venv'];

// How many matches ripgrep may print before it stops. We apply the real cap
// ourselves while streaming (so the reported count matches the setting), but
// `--max-count` keeps the child from flooding the pipe on a `(?s).` query.
const RG_MAX_MATCHES = 2000;
const RG_MAX_LINE_BYTES = 500;
const RG_KILL_GRACE_MS = 500;
const RG_HARD_TIMEOUT_MS = 60_000;

function capFor(settings) {
  return {
    matches: (settings && settings.fileSearchMaxMatches) || DEFAULT_MAX_MATCHES,
    bytes: (settings && settings.fileSearchMaxBytes) || DEFAULT_MAX_BYTES
  };
}

// ---- ripgrep discovery -------------------------------------------------

let rgCache;

// Find a ripgrep binary. Checked in order: an explicit override, then PATH,
// then the copies that ship inside the tools this app already integrates
// with (VS Code / Cursor ship one, the packaged codex CLI ships one). The
// answer is cached for the process — the binary does not move while the
// server runs.
function findRipgrepBinary() {
  if (rgCache !== undefined) return rgCache;
  rgCache = resolveRipgrepBinary();
  return rgCache;
}

function resolveRipgrepBinary() {
  // An explicit opt-out, for the two cases where the walker is the right
  // answer: a machine whose bundled rg turns out to be incompatible, and the
  // test that has to prove the fallback still passes the same assertions.
  if (process.env.MOUAIF_RG_DISABLE) return null;
  const explicit = process.env.MOUAIF_RG_PATH;
  if (explicit && isExecutableFile(explicit)) return explicit;
  const onPath = whichRg();
  if (onPath) return onPath;
  for (const candidate of bundledRgCandidates()) {
    if (candidate && isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function whichRg() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function bundledRgCandidates() {
  const out = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.env.VSCODE_SERVER_PATH) {
    out.push(path.join(process.env.VSCODE_SERVER_PATH, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'));
  }
  if (home) {
    // VS Code server installs: ~/.vscode-server/bin/<commit>/node_modules/@vscode/ripgrep/bin/rg
    for (const base of ['.vscode-server', '.cursor-server', '.vscode-remote']) {
      const bin = path.join(home, base, 'bin');
      for (const commit of safeReaddir(bin)) {
        out.push(path.join(bin, commit, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'));
      }
    }
    // The packaged codex CLI keeps an rg next to its own scripts.
    for (const base of [['.opencode', 'bin'], ['.cache', 'opencode', 'bin']]) {
      out.push(path.join(home, ...base, 'rg'));
    }
  }
  return out;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// ---- regex handling ----------------------------------------------------

// ripgrep speaks Rust's regex dialect. Two syntaxes that are valid in the
// JavaScript RegExp the tool schema documents are not valid there:
//
//   (?i)  inline case-insensitive — PCRE2-only on old ripgrep builds
//   (?s)  inline dot-matches-newline — same
//
// Both are handled here: the flag is peeled off the front of the pattern and
// turned into real CLI flags. That makes them work regardless of whether the
// installed ripgrep was built with PCRE2. Any other inline group (e.g. the
// valid Rust `(?P<name>...)`) is left untouched.
//
// Returns { pattern, ignoreCase, multiline }.
function normalizePattern(query) {
  let pattern = String(query);
  let ignoreCase = false;
  let multiline = false;
  // Peel leading inline flags in any order: (?i), (?s), or (?is).
  for (;;) {
    const m = /^\(\?([is]+)\)/.exec(pattern);
    if (!m) break;
    if (m[1].includes('i')) ignoreCase = true;
    if (m[1].includes('s')) multiline = true;
    pattern = pattern.slice(m[0].length);
  }
  // Only peel the JS-style flags when a real pattern is left, so a query
  // that is *only* the flags falls through to a normal syntax error.
  if (!pattern) return { pattern: String(query), ignoreCase: false, multiline: false };
  return { pattern, ignoreCase, multiline };
}

// Reject a pattern both engines would choke on, and report it as EBADINPUT
// with a message that names the construct — the schema documents JavaScript
// regular expressions, so a model that sends a lookaround deserves to be told
// it is unsupported rather than getting a bare "regex parse error".
function assertPatternSupported(pattern, multiline) {
  // `\1` .. `\9` are backreferences; `\0` and `\n` are ordinary escapes.
  if (/(?<![\\[])\\[1-9]/.test(pattern)) {
    throw err('EBADINPUT', 'backreferences (\\1) are not supported; rewrite the pattern without them');
  }
  if (/\(\?<?[=!]/.test(pattern)) {
    throw err('EBADINPUT', 'lookahead / lookbehind are not supported; use a capture group or two searches instead');
  }
  if (multiline) return; // `--multiline` is enabled for (?s)
  const named = /\(\?P?<([^>]*)>/.exec(pattern);
  if (named) {
    // Rust accepts (?P<name>...) and JS accepts (?<name>...); both engines
    // accept this form, so nothing to do.
    return;
  }
}

// ---- search entry point ------------------------------------------------

// Run a search with the best engine available. Falls back to the JS walk if
// ripgrep is missing, fails to start, or exits with a usage error (an old
// build that does not understand a flag we pass).
async function runSearch(opts) {
  const cap = capFor(opts.settings);
  const query = (opts.args && typeof opts.args.query === 'string') ? opts.args.query : '';
  if (!query) throw err('EBADINPUT', 'query is required');

  const { pattern, ignoreCase, multiline } = normalizePattern(query);
  assertPatternSupported(pattern, multiline);

  const scope = resolveScope(opts.projectDir, opts.args && opts.args.path);
  const include = sanitizeInclude(opts.args && opts.args.include);

  const rg = findRipgrepBinary();
  if (rg) {
    try {
      return await runRipgrep({ ...opts, query, pattern, ignoreCase, multiline, scope, include, cap, rg });
    } catch (e) {
      if (e && e.code === 'EBADINPUT') throw e;
      // Any other failure (spawn error, unexpected exit code) is a reason to
      // use the walker, not to fail the tool call.
    }
  }
  return runWalk({ ...opts, query, pattern, ignoreCase, cap, scope, include });
}

// ---- path scope --------------------------------------------------------

// Sanitize the model-supplied `include` glob. The value reaches ripgrep as a
// `-g` argument, so a leading `!` (which would turn it into an exclusion) and
// a leading `/` (which anchors it somewhere unexpected) are stripped rather
// than honored. The rest is passed through: ripgrep's glob grammar is what
// the tool description promises.
function sanitizeInclude(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  while (s.startsWith('!')) s = s.slice(1);
  s = s.replace(/^\/+/, '');
  return s.trim() || null;
}

// Does a project-relative path match a simple include glob? Used by the walk
// engine; ripgrep applies the same glob itself.
function includeMatches(glob, rel) {
  if (!glob) return true;
  const re = includeToRegExp(glob);
  return re ? re.test(rel) : true;
}

const includeRegExpCache = new Map();

function includeToRegExp(glob) {
  if (includeRegExpCache.has(glob)) return includeRegExpCache.get(glob);
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      src += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      src += '[^/]*';
    } else if (c === '?') {
      src += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      src += '\\' + c;
    } else {
      src += c;
    }
  }
  // A bare `*.js` is a name pattern: it should match at any depth, which is
  // what the ripgrep `-g` behavior gives and what a model means by it.
  const prefix = glob.includes('/') ? '^' : '(?:^|/)';
  let re = null;
  try { re = new RegExp(prefix + src + '$'); } catch { re = null; }
  includeRegExpCache.set(glob, re);
  return re;
}

// Resolve the `path` argument to an absolute directory to search plus the
// relative prefix its results carry.
//
// Semantics, unchanged from the walker:
//   - omitted / "." / "./"  -> the whole project
//   - an existing directory -> that directory ("src" or "src/")
//   - an existing file      -> just that file
//   - a path that does not exist -> its longest existing ancestor, so a
//     typo or a not-yet-created directory still searches something
//     (`src/util` searches `src/`) instead of silently returning nothing.
function resolveScope(projectDir, rawPath) {
  const root = fs.realpathSync(projectDir);
  const cleaned = cleanRelPath(rawPath);
  if (!cleaned) return { root, dir: root, relDir: '', relFile: null };

  let abs;
  try { abs = toAbsInside(root, cleaned); }
  catch (e) {
    if (e && e.code === 'EOUTSIDE_PROJECT') return { root, dir: root, relDir: '', relFile: null };
    throw e;
  }

  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (st && st.isFile()) {
    return { root, dir: path.dirname(abs), relDir: relRelOf(root, path.dirname(abs)), relFile: relRelOf(root, abs) };
  }
  if (st && st.isDirectory()) {
    return { root, dir: abs, relDir: relRelOf(root, abs), relFile: null };
  }

  // Does not exist: climb to the longest existing ancestor directory.
  let probe = abs;
  for (;;) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
    try {
      if (fs.statSync(probe).isDirectory()) {
        return { root, dir: probe, relDir: relRelOf(root, probe), relFile: null };
      }
    } catch { /* keep climbing */ }
  }
  return { root, dir: root, relDir: '', relFile: null };
}

function cleanRelPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+/g, '/');
  if (s === '.' || s === '') return null;
  return s.replace(/\/+$/, '');
}

function toRelPath(root, p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: p });
  }
  return rel.split(path.sep).join('/');
}

function toAbsInside(root, rel) {
  const abs = path.resolve(root, rel);
  let real;
  try { real = fs.realpathSync(abs); } catch { real = null; }
  const check = real || abs;
  const relOut = path.relative(root, check);
  if (relOut && (relOut.startsWith('..') || path.isAbsolute(relOut))) {
    throw err('EOUTSIDE_PROJECT', 'Path escapes the project root', { path: rel });
  }
  return check;
}

function relRelOf(root, abs) {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

// ---- ripgrep engine ----------------------------------------------------

function buildRgArgs({ scope, pattern, ignoreCase, multiline, include, cap }) {
  const args = [
    '--json',
    '--no-config',            // the project's .ripgreprc must not change results
    // Read the project's own .gitignore / .ignore files even when the
    // directory is not a git repository. Without this a plain folder of
    // sources gets its generated trees searched.
    '--no-require-git',
    '--line-number',
    '--with-filename',
    '--hidden',               // .github/ and friends are project source
    '--no-ignore-global',     // a user's global ignore file is not part of this project
    '--max-count', String(Math.max(RG_MAX_MATCHES, cap.matches)),
    '--max-columns', String(RG_MAX_LINE_BYTES),
    '--max-columns-preview'
  ];
  if (ignoreCase) args.push('--ignore-case');
  if (multiline) { args.push('--multiline', '--multiline-dotall'); }
  // Belt and braces next to --no-require-git: pass the root .gitignore
  // explicitly. The path must be absolute because ripgrep resolves
  // `--ignore-file` against its cwd (the scope directory), not the project
  // root, and a project-scoped search runs from a subdirectory.
  const rootIgnore = path.join(scope.root, '.gitignore');
  if (fs.existsSync(rootIgnore)) {
    args.push('--ignore-file', rootIgnore);
  }
  // Generated / vendored trees are excluded before ripgrep walks them.
  for (const d of SKIP_DIRS) {
    args.push('-g', '!**/' + d + '/**');
    if (scope.relDir) args.push('-g', '!' + scope.relDir + '/' + d + '/**');
  }
  // A single-file scope restricts ripgrep to that file. The glob is
  // project-relative and anchored, so a same-named file elsewhere in the
  // tree cannot leak into the results.
  if (scope.relFile) {
    args.push('-g', '/' + escapeGlob(scope.relFile));
  }
  // The `include` filter from the tool call.
  if (include) {
    args.push('-g', include);
  }
  const target = scope.relFile
    ? path.relative(scope.dir, path.join(scope.root, scope.relFile)) || '.'
    : '.';
  args.push('--', pattern, target);
  return args;
}

function escapeGlob(s) {
  return String(s).replace(/([*?\[\]{}()!+@\\])/g, '\\$1');
}

// Spawn ripgrep and turn its NDJSON stream into the shared result shape.
async function runRipgrep(ctx) {
  const { scope, cap, rg } = ctx;
  const args = buildRgArgs(ctx);
  const matches = [];
  let filesScanned = 0;
  let truncated = false;
  let stderr = '';
  let exited = false;
  let exitCode = null;
  let exitSignal = null;

  // Redaction rules are read once for the whole search. This is the fix for
  // the per-line settings re-read that made the old engine slow.
  const ruleIndex = hideFileContent.buildRuleIndex(ctx.projectDir);

  const child = spawn(rg, args, { cwd: scope.dir, windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
  child.on('error', (e) => { stderr += String(e && e.message); });

  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; resolve(); });
  });

  const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, RG_HARD_TIMEOUT_MS);
  killTimer.unref && killTimer.unref();

  let buffered = '';
  try {
    for await (const chunk of child.stdout) {
      buffered += chunk;
      let nl;
      // Process whole lines only; a chunk boundary can split a JSON record.
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const stop = consumeRgLine(line, {
          matches, cap, ruleIndex, scope,
          onBegin: () => { filesScanned++; },
          onEnd: () => { filesScanned++; }
        });
        if (stop) { truncated = true; break; }
      }
      if (truncated) break;
    }
  } catch { /* stream torn down by the kill timer */ }

  if (truncated) {
    // ripgrep counts `begin`+`end` per searched file; keep the child from
    // doing any more work now that the cap is reached.
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }

  // Wait for the process, but never hang the tool call on a wedged child.
  await Promise.race([done, new Promise((r) => setTimeout(r, RG_KILL_GRACE_MS))]);
  clearTimeout(killTimer);
  if (!exited) { try { child.kill('SIGKILL'); } catch { /* gone */ } }

  // A usage error means this build does not understand our arguments (very
  // old ripgrep). Signal the caller to fall back to the walker.
  if (!truncated && exitCode !== 0 && exitCode !== 1 && exited && !exitSignal) {
    if (/unrecognized|invalid|unknown flag|error:/i.test(stderr)) {
      const e = err('ERGFALLBACK', 'ripgrep rejected the arguments');
      e.stderr = stderr;
      throw e;
    }
  }
  if (!exited && !truncated) {
    const e = err('ERGFALLBACK', 'ripgrep did not exit in time');
    e.stderr = stderr;
    throw e;
  }

  const result = { query: ctx.query, matches, filesScanned, truncated, engine: 'ripgrep' };
  if (truncated) {
    result.capMatches = cap.matches;
    result.capBytes = cap.bytes;
  }
  return result;
}

// Fold one NDJSON record into the running result. Returns true when the
// caller should stop reading.
function consumeRgLine(line, ctx) {
  let rec;
  try { rec = JSON.parse(line); } catch { return false; }
  if (!rec || typeof rec !== 'object') return false;

  if (rec.type === 'begin') { ctx.onBegin(); return false; }
  if (rec.type === 'end') { ctx.onEnd(rec.data && rec.data.stats); return false; }
  if (rec.type !== 'match') return false;

  const data = rec.data || {};
  const absPath = data.path && data.path.text;
  if (!absPath) return false;
  const relPath = toRel(ctx.scope, absPath);
  const lineNumber = data.line_number;
  const rawLine = (data.lines && data.lines.text) || '';
  const text = trimLine(rawLine);
  // One row per matching line, like every other search surface here and in
  // the peer tools: ripgrep reports a submatch per occurrence, and a line
  // with the pattern three times must not become three rows.
  //
  // Redaction is the reason the check stays per submatch: if *any* occurrence
  // on the line falls on a hidden line or inside a hidden character span, the
  // whole row is dropped. Printing the line because only one of its three
  // occurrences was hidden would hand the model the redacted text.
  const submatches = Array.isArray(data.submatches) ? data.submatches : [];
  if (submatches.length) {
    for (const sm of submatches) {
      const cols = submatchColumns(rawLine, sm);
      if (!cols) continue;
      if (hideFileContent.matchIsHiddenIn(ctx.ruleIndex, relPath, lineNumber, cols.start, cols.end)) return false;
    }
  } else if (hideFileContent.matchIsHiddenIn(ctx.ruleIndex, relPath, lineNumber)) {
    // No submatch detail available: treat the line as wholly suspect.
    return false;
  }

  ctx.matches.push({ path: relPath, line: lineNumber, text: text.slice(0, 240) });
  return ctx.matches.length >= ctx.cap.matches;
}

// Convert a submatch's byte range in the record's line into 1-indexed
// inclusive character columns, which is what the redaction rules are stored
// in. Multi-byte characters are counted once, matching how the editor counts
// a selection.
function submatchColumns(rawLine, sm) {
  const startByte = sm.start;
  const endByte = sm.end;
  if (!Number.isInteger(startByte) || !Number.isInteger(endByte)) return null;
  const buf = Buffer.from(rawLine, 'utf8');
  if (endByte > buf.length) return null;
  const startChar = buf.subarray(0, startByte).toString('utf8').length;
  const endChar = buf.subarray(0, endByte).toString('utf8').length;
  if (endChar <= startChar) return null;
  return { start: startChar + 1, end: endChar };
}

function trimLine(raw) {
  return String(raw).replace(/\r?\n$/, '');
}

// ripgrep paths are relative to its cwd (the scope directory), except with
// an absolute or single-file target. Normalize to project-relative POSIX,
// and reject anything the scope did not authorize.
function toRel(scope, absPath) {
  let abs = absPath;
  if (!path.isAbsolute(abs)) abs = path.resolve(scope.dir, abs);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* keep the lexical path */ }
  const rel = path.relative(scope.root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    // Outside the project root: the walker never returns these, and neither
    // should the engine. Returning a marker makes the leak visible instead
    // of silently dropping or silently including it.
    return path.relative(scope.root, abs).split(path.sep).join('/');
  }
  return rel.split(path.sep).join('/');
}

// ---- JS walk engine (fallback) -----------------------------------------

// Used when no ripgrep binary is available. Keeps the walker's behavior
// (skip dirs, text-extension allowlist, byte cap, same result shape) but
// fixes what made it slow and incomplete:
//   - the redaction rules are read once per search instead of once per line
//   - files are read with a bounded thread pool instead of one at a time
//   - .gitignore is honored for the files it covers, so a git-ignored build
//     tree is not searched
//   - files with no extension are searched (Dockerfile, Makefile, ...)
async function runWalk(ctx) {
  const { scope, cap } = ctx;
  let re;
  try { re = new RegExp(ctx.pattern, ctx.ignoreCase ? 'i' : ''); }
  catch (e) { throw err('EBADINPUT', 'invalid regex: ' + e.message); }

  const ruleIndex = hideFileContent.buildRuleIndex(ctx.projectDir);
  const ignored = loadGitignore(scope.root);
  const matches = [];
  let matchedChars = 0;
  let bytesRead = 0;
  let filesScanned = 0;
  let filesSkipped = 0;
  let truncated = false;

  const candidates = [];
  await collectCandidates(scope, ignored, candidates);
  // A single-file scope reads exactly that file, whatever the size.
  const fileScoped = Boolean(scope.relFile);

  const CONCURRENCY = 16;
  let next = 0;
  async function worker() {
    for (;;) {
      if (matches.length >= cap.matches || matchedChars >= cap.bytes) { truncated = true; return; }
      const idx = next++;
      if (idx >= candidates.length) return;
      const rel = candidates[idx];
      if (!includeMatches(ctx.include, rel)) continue;
      let content;
      try { content = await fsp.readFile(path.join(scope.root, rel), 'utf8'); }
      catch { continue; }
      // Re-check after the await: 16 workers run concurrently, so several can
      // pass the cap check above before any of them appends a match. Without
      // this the result overshoots the cap by up to one row per worker.
      if (matches.length >= cap.matches || matchedChars >= cap.bytes) { truncated = true; return; }
      // Read ceiling, separate from the reported cap and not tied to the
      // directory order: the walk has to read a file to know whether it
      // matches, so the tool-level byte budget cannot be allowed to decide
      // *which* files get looked at — spending it alphabetically meant
      // `docs/features/*.html` exhausted the budget before `src/` was ever
      // reached, and a search for a function in `src/` came back empty. The
      // budget below bounds the answer instead, and this ceiling only stops
      // a pathological tree from being read forever.
      if (!fileScoped && bytesRead > WALK_MAX_BYTES) { truncated = true; filesSkipped++; return; }
      filesScanned++;
      bytesRead += content.length;
      matchedChars += scanContent(content, rel, re, ruleIndex, matches, cap);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const result = { query: ctx.query, matches, filesScanned, truncated, engine: 'walk' };
  if (filesSkipped) result.filesSkipped = filesSkipped;
  if (truncated) { result.capMatches = cap.matches; result.capBytes = cap.bytes; }
  return result;
}

// Ceiling on how much the fallback walk will read for one call. Deliberately
// far above the reported cap: it exists to stop a runaway tree, not to pick
// which files are searched.
const WALK_MAX_BYTES = 64 * 1024 * 1024;

// Scan one file body and append its non-redacted matching lines. Returns the
// number of characters of matched line text, which is what the tool's byte
// budget bounds.
function scanContent(content, rel, re, ruleIndex, matches, cap) {
  const lines = content.split('\n');
  let matched = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    re.lastIndex = 0;
    const m = re.exec(lines[i]);
    if (!m) continue;
    // A match on a hidden line or inside a hidden character span is dropped,
    // not redacted in place: the model must not be able to infer it.
    if (hideFileContent.matchIsHiddenIn(ruleIndex, rel, lineNumber, m.index + 1, m.index + m[0].length)) continue;
    // Hard stop: the cap is a promise to the caller, so it must not be
    // exceeded even by one row.
    if (matches.length >= cap.matches) return matched;
    matches.push({ path: rel, line: lineNumber, text: lines[i].slice(0, 240) });
    matched += lines[i].length;
  }
  return matched;
}

async function collectCandidates(scope, ignored, out) {
  async function walk(dirAbs, dirRel) {
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const childAbs = path.join(dirAbs, ent.name);
      const childRel = dirRel ? dirRel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.includes(ent.name)) continue;
        if (ignored && ignored.ignores(childRel)) continue;
        await walk(childAbs, childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (scope.relFile && childRel !== scope.relFile) continue;
      if (ignored && ignored.ignores(childRel)) continue;
      const ext = path.extname(ent.name).toLowerCase();
      // A file with no extension has no way to be identified as text, so it
      // is searched (that is where Dockerfile lives). An unrecognized
      // extension with a dot is still skipped, which keeps a stray
      // `dump.001` or a photo out of the walk.
      if (ext && !TEXT_EXTS.has(ext)) continue;
      // The walk has no ignore-file engine of its own, so the trees every
      // project treats as output are excluded here by name. Without this a
      // checked-out build output (`docs-dist/`) doubles the walk and can
      // consume the read ceiling before `src/` is reached.
      if (GENERATED_DIRS.some((d) => childRel === d || childRel.startsWith(d + '/') || childRel.includes('/' + d + '/'))) continue;
      out.push(childRel);
    }
  }
  await walk(scope.dir, scope.relDir);
}

// A deliberately small .gitignore reader: comments, blank lines, trailing
// slashes, leading slashes and `**` are honored; `!` re-includes. It exists
// so the walker's file set roughly matches ripgrep's on the machines that
// need the fallback, not to be a complete git implementation.
function loadGitignore(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); }
  catch { return null; }
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const body = (negate ? line.slice(1) : line).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!body) continue;
    const anchored = /^\//.test(negate ? line.slice(1) : line) || body.includes('/');
    const re = gitignoreToRegExp(body, anchored);
    if (re) rules.push({ re, negate });
  }
  if (!rules.length) return null;
  return {
    ignores(rel) {
      // Last matching rule wins, git-style: `docs-dist/` then `!docs-dist/keep`
      // re-includes the exception.
      let verdict = false;
      for (const rule of rules) {
        if (rule.re.test(rel)) verdict = !rule.negate;
      }
      return verdict;
    }
  };
}

function gitignoreToRegExp(body, anchored) {
  let src = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*' && body[i + 1] === '*') {
      src += '.*';
      i++;
      if (body[i + 1] === '/') i++;
    } else if (c === '*') {
      src += '[^/]*';
    } else if (c === '?') {
      src += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      src += '\\' + c;
    } else {
      src += c;
    }
  }
  // An unanchored pattern matches at any depth (git semantics); an anchored
  // one starts at the root.
  const prefix = anchored ? '^' : '(?:^|/)';
  try { return new RegExp(prefix + src + '(?:/.*)?$'); } catch { return null; }
}

module.exports = {
  runSearch,
  findRipgrepBinary,
  normalizePattern,
  resolveScope,
  sanitizeInclude,
  includeMatches,
  escapeGlob,
  collectCandidates,
  loadGitignore,
  _clearRipgrepCache: () => { rgCache = undefined; },
  TEXT_EXTS,
  SKIP_DIRS,
  DEFAULT_MAX_MATCHES,
  DEFAULT_MAX_BYTES
};
