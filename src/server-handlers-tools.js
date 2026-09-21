'use strict';

// Native tool REST handlers (shell, subagent, tool list). Extracted
// from the original single-file http-server.js. Shared helpers live in
// src/server-shared.js.

const {
  sendJSON,
  qs,
  readJsonOr400,
  resolveModel,
  settings,
  chats,
  messages,
  usage,
  mcp,
  shellTool,
  ai,
  broadcast
} = require('./server-shared.js');

// ---- Interactive CLI session ------------------------------------------------
//
// A single persistent command-line child per project (the platform shell:
// cmd.exe on Windows, the user's $SHELL or /bin/sh on POSIX) with
// stdin/stdout/stderr piped over HTTP. All commands run in the project
// directory ("default path to the project"). The session is created with
// `windowsHide` and no window is ever shown; output streaming rides the
// SSE endpoint (see startCliSession below).
//
// The child is intentionally spawned WITHOUT a TTY (pipe stdio). Commands
// that require an interactive TTY (REPLs, `cmd.exe` interactive prompts
// like `del` confirmation) will fail or exit immediately — a documented
// limitation, same as the native `shell` tool. Everything non-interactive
// works exactly like a real Command Prompt.

const { spawn } = require('node:child_process');

const cliSessions = new Map(); // projectDir -> { child, projectDir, id, startedAt }

// Reap every live CLI child on parent exit so a server shutdown never
// leaves orphaned cmd.exe processes behind (same pattern as the native
// shell tool's liveChildren set).
let cliExitHooked = false;
function hookCliExit() {
  if (cliExitHooked) return;
  cliExitHooked = true;
  const reap = () => {
    for (const s of cliSessions.values()) {
      try { if (s.child && !s.child.killed) s.child.kill(); } catch { /* already gone */ }
    }
    cliSessions.clear();
  };
  process.on('exit', reap);
  process.on('SIGINT', () => { reap(); process.exit(130); });
  process.on('SIGTERM', () => { reap(); process.exit(143); });
}

function cliShellMeta() {
  // Default grid for a PTY-backed session. The modal renders plain text and
  // does not yet report its own size, so this is a sensible fixed terminal
  // size rather than the browser viewport.
  const cols = 100;
  const rows = 30;
  if (process.platform === 'win32') {
    // Windows Terminal Detection: if the session's env already has a WSL
    // or PowerShell default, use it; otherwise cmd.exe (the classic prompt).
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      args: [],
      label: 'Command Prompt (cmd.exe)',
      windows: true,
      cols,
      rows
    };
  }
  const shellPath = process.env.SHELL || '/bin/sh';
  return {
    exe: shellPath,
    args: [],
    label: 'Shell (' + shellPath + ')',
    windows: false,
    cols,
    rows
  };
}

// Load node-pty once. It is an optional native dependency: a platform with
// no prebuilt binary (and no C++ toolchain) still installs mouaif, and the
// session silently falls back to the piped spawn below. `require` is
// wrapped so a missing/broken addon is a degraded mode, not a crash.
let ptyModule = null;
let ptyLoadAttempted = false;
function loadPty() {
  if (ptyLoadAttempted) return ptyModule;
  ptyLoadAttempted = true;
  try {
    ptyModule = require('node-pty');
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

// Start the persistent session (idempotent) and return the session handle.
//
// The session runs on a pseudo-terminal when node-pty is available. That
// matters for prompting programs: over pipes (`stdio: ['pipe', ...]`) the
// child's stdin is not a TTY, so a program that asks a question either gets
// an immediate EOF or refuses to prompt at all — `npm publish` under 2FA
// answers `EOTP` with a masked auth URL instead of asking for a code, and
// `read` returns an empty answer. With a PTY the prompt is written to the
// screen, the user types the answer into the modal's prompt line, and it is
// delivered to the still-running child.
//
// A PTY merges stdout and stderr into one stream, so `attachCliStream`
// labels every chunk `stdout`; there is no separate stderr channel to
// preserve. When the PTY is unavailable the old piped triple is used and
// stderr keeps its own channel.
function ensureCliSession(projectDir) {
  const key = String(projectDir || '');
  const existing = cliSessions.get(key);
  if (existing && existing.child && !existing.child.killed) return existing;
  const meta = cliShellMeta();
  const pty = loadPty();
  let child;
  let isPty = false;
  if (pty && typeof pty.spawn === 'function') {
    try {
      // The shell is only interactive once it has a TTY, so ask for `-i`
      // here rather than in cliShellMeta (the piped fallback must not: bash
      // warns about job control with no TTY).
      const ptyArgs = (!meta.windows && meta.args.indexOf('-i') === -1)
        ? meta.args.concat('-i')
        : meta.args;
      child = pty.spawn(meta.exe, ptyArgs, {
        name: 'xterm-256color',
        cols: meta.cols,
        rows: meta.rows,
        cwd: projectDir,
        // The child inherits the server's env; force a colour-capable TERM
        // so utilities that gate formatting on terminfo behave.
        env: Object.assign({}, process.env, { TERM: process.env.TERM || 'xterm-256color' })
      });
      isPty = true;
    } catch {
      child = null;
    }
  }
  if (!child) {
    child = spawn(meta.exe, meta.args, {
      cwd: projectDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }
  const session = {
    id: 'cli_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    projectDir,
    child,
    startedAt: Date.now(),
    // True when the child runs on a pseudo-terminal (see loadPty above).
    pty: isPty,
    // Record the platform so command writes use the correct line
    // terminator: CRLF for cmd.exe on Windows, LF for sh/bash on POSIX.
    windows: !!meta.windows
  };
  hookCliExit();
  cliSessions.set(key, session);
  // Reap on exit so a closed session doesn't leak. node-pty reports exit
  // through `onExit`; a piped child uses the standard `exit` event.
  if (isPty) child.onExit(() => { if (cliSessions.get(key) === session) cliSessions.delete(key); });
  else child.on('exit', () => { if (cliSessions.get(key) === session) cliSessions.delete(key); });
  return session;
}

function closeCliSession(projectDir) {
  const key = String(projectDir || '');
  const session = cliSessions.get(key);
  if (!session) return false;
  try {
    if (session.child && !session.child.killed) session.child.kill();
  } catch { /* already gone */ }
  cliSessions.delete(key);
  return true;
}

// Write one command line to the session's stdin. Shared by the HTTP handler
// and the tests so the terminator rule lives in exactly one place: CRLF for
// cmd.exe on Windows, LF for sh/bash on POSIX. A PTY in canonical mode also
// accepts CR to submit, but LF is what the piped path needs and what the
// shell consumes cleanly under both.
//
// `raw` writes the text with no terminator: an interactive program waiting on
// a single key (a `y/n` confirmation, a pager, a TUI) needs the byte alone,
// where appending a newline would answer a *second* prompt.
function writeCliCommand(session, cmd, raw) {
  if (!session || !session.child) return false;
  const newline = session.windows ? '\r\n' : '\n';
  const line = String(cmd) + (raw ? '' : newline);
  if (session.pty) {
    if (typeof session.child.write !== 'function') return false;
    session.child.write(line);
    return true;
  }
  if (!session.child.stdin || !session.child.stdin.writable) return false;
  session.child.stdin.write(line);
  return true;
}

// Forward a session's stdout/stderr to the SSE broadcast channel. The
// browser opens GET /events, receives the session id, and listens for
// `cli_output` frames tagged with that id.
function attachCliStream(session, broadcast) {
  if (!session || !session.child || !broadcast) return;
  const emit = (stream, d) => {
    broadcast('cli_output', { id: session.id, stream, data: Buffer.isBuffer(d) ? d.toString('utf8') : String(d) });
  };
  if (session.pty) {
    // A PTY merges stdout and stderr into one readable stream and reports
    // the exit code through onExit (the child has no `exit` event). Every
    // chunk is labelled stdout because the two channels are no longer
    // distinguishable.
    session.child.onData((d) => emit('stdout', d));
    session.child.onExit(({ exitCode }) => emit('exit', String(exitCode)));
    return;
  }
  session.child.stdout.on('data', (d) => emit('stdout', d));
  session.child.stderr.on('data', (d) => emit('stderr', d));
  session.child.on('exit', (code) => emit('exit', String(code)));
}

// ---- Tools API ---------------------------------------------------------------
//
// REST surface for the native tool set (shell, file tools).
// Routes:
//   GET  /api/tools/list?projectDir=<abs>
//        Catalog of every tool the model can be advertised to use on
//        this project: native shell + file tools, plus MCP-discovered
//        tools whose server is currently running. The chat UI reads
//        this to render the per-chat tool toggles shown below the
//        system prompt on a brand-new chat.
//   POST /api/tools/shell  body: { projectDir, cmd, timeoutMs? }
//     -> NDJSON stream (application/x-ndjson): `output` lines while the
//        command runs, then `result` line with
//        { ok, stdout, stderr, exitCode, durationMs } | { ok:false, error, code }
// The tool is off unless the project's resolved settings enable it
// (settings.tools.shell.enabled). A disabled project returns
// ETOOL_DISABLED with HTTP 403.

// pushNativeTool(tools, opts) — append one built-in tool entry to the
// catalog. All the single native tools advertise the same shape
// ({ name, kind: 'native', source, description }); only the module to
// load, its spec accessor and the fallback description differ, so the
// six repetitive try/catch + push blocks collapse into one loader.
// `opts.spec(mod)` returns the tool's `function` block (or undefined).
// If the module cannot be loaded the tool is silently omitted.
function pushNativeTool(tools, opts) {
  try {
    const mod = require(opts.load);
    const fn = opts.spec(mod) || {};
    tools.push({
      name: opts.name,
      kind: 'native',
      source: opts.source,
      description: fn.description || opts.fallback
    });
  } catch { /* module unavailable; omit */ }
}

async function handleTools(req, res, parsed) {
  const urlPath = parsed.pathname;
  const method = req.method;
  const q = parsed.query || {};

  // GET /api/tools/list?projectDir=<abs>
  // The catalog is read-only; it does not require a chat id. Native
  // tools are always present; MCP tools are filtered to servers
  // whose session is currently 'ready' (decisions §18: tools belong
  // to a running session). A server that is not running is not
  // listed — the user can start it from Settings → MCP, and a
  // subsequent call will pick up the newly discovered tools.
  if (urlPath === '/api/tools/list' && method === 'GET') {
    const projectDir = qs(q, 'projectDir');
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    // A chat opening (or the mobile UI re-loading a project) should
    // re-attach the MCP servers it needs. The Settings UI documents
    // this as "open a chat that references a stopped server" — without
    // it, the tool list comes back empty after a server restart.
    // Wait for discovery so this response is authoritative. Returning
    // before the servers finish starting makes a fresh .mcp.json
    // configuration disappear from the first tool catalog (there may be
    // no cache yet), and callers have no completion signal to know when
    // to retry. ensureServersRunning isolates failures per server, so one
    // broken MCP process does not fail the native-tool catalog.
    await mcp.ensureServersRunning(projectDir).catch(() => []);
    const tools = [];
pushNativeTool(tools, { load: './tools/shell.js', name: 'shell', source: 'shell', fallback: 'Run a shell command in the project directory.', spec: (m) => m.SPEC && m.SPEC.function });
pushNativeTool(tools, { load: './tools/progress.js', name: 'report_progress', source: 'progress', fallback: 'Report real-time progress on a long-running operation.', spec: (m) => m.SPEC && m.SPEC.function });
pushNativeTool(tools, { load: './tools/subagent.js', name: 'subagent', source: 'subagent', fallback: 'Delegate a focused task to a nested AI call.', spec: (m) => m.SPEC && m.SPEC.function });
pushNativeTool(tools, { load: './agentFeatures.js', name: 'list_features', source: 'features', fallback: 'Describe mouaif feature state.', spec: (m) => m.LIST_FEATURES_SPEC && m.LIST_FEATURES_SPEC.function });
pushNativeTool(tools, { load: './tools/ask.js', name: 'ask_user', source: 'ask_user', fallback: 'Ask the user a structured question with options.', spec: (m) => m.SPEC && m.SPEC.function });
pushNativeTool(tools, { load: './tools/task.js', name: 'task', source: 'task', fallback: 'Create, update, track progress on, and list structured tasks with subtasks.', spec: (m) => m.SPEC && m.SPEC.function });
pushNativeTool(tools, { load: './tools/webpreview.js', name: 'webpreview', source: 'webpreview', fallback: 'Open a web URL in the debug Chrome and return a small screenshot of the page.', spec: (m) => m.SPEC && m.SPEC.function });
pushNativeTool(tools, { load: './tools/restart.js', name: 'restart_app', source: 'restart', fallback: 'Gracefully restart mouaif from the current chat.', spec: (m) => m.SPEC && m.SPEC.function });
try {

      const ft = require('./tools/files.js');
      for (const name of ft.FILE_TOOL_NAMES) {
        const spec = ft.SPECS && ft.SPECS[name];
        tools.push({
          name,
          kind: 'native',
          source: 'files',
          description: (spec && spec.function && spec.function.description) || '',
          parameters: (spec && spec.function && spec.function.parameters) || null
        });
      }
    } catch { /* files module unavailable; omit */ }
    try {
      const mcpMod = require('./mcp.js');
      const specs = mcpMod.listComposedToolSpecs(projectDir);
      for (const s of (specs || [])) {
        tools.push({
          name: s.name,
          kind: 'mcp',
          source: s.serverSlug || '',
          serverId: s.serverId || '',
          description: s.description || '',
          parameters: s.parameters || null
        });
      }
    } catch { /* mcp module not loaded; no MCP tools */ }
    return sendJSON(res, 200, { tools });
  }

  if (urlPath === '/api/tools/shell' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const cmd = body && typeof body.cmd === 'string' ? body.cmd : '';
    const shellOverride = body && typeof body.shell === 'string' ? body.shell : '';
    const timeoutMs = body && typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
    const chatId = body && typeof body.chatId === 'string' ? body.chatId : '';
    const callId = body && typeof body.callId === 'string' ? body.callId : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!cmd) return sendJSON(res, 400, { error: 'cmd is required' });
    if (!chatId || !callId) return sendJSON(res, 400, { error: 'chatId and callId are required' });
    if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId });

    // The authorization gate owns enablement. A legacy `tools.shell.enabled`
    // check used to short-circuit here, but the authorization refactor
    // stores enablement as `mode` (off = disabled, ask/allow/allowlist =
    // enabled) with no `enabled` field — so that stale check always read
    // `false` and every direct `/shell` call failed with ETOOL_DISABLED
    // before ever reaching the prompt. authorize() below rejects `off` mode
    // itself (defense-in-depth), so the pre-check is dropped entirely.

    let authorization;
    try {
      authorization = await require('./tools/authorization.js').authorize({
        projectDir, chatId, callId, tool: 'shell', cmd, summary: cmd, timeoutMs, flow: 'retry'
      });
    } catch (e) {
      const status = e.code === 'ETOOL_DISABLED' || e.code === 'EDENIED' ? 403 : 400;
      return sendJSON(res, status, { ok: false, error: e.message, code: e.code || 'EAUTH' });
    }
    if (authorization.decision === 'prompt') {
      return sendJSON(res, 409, {
        ok: false,
        code: 'EAUTH_REQUIRED',
        chatId,
        callId,
        tool: 'shell',
        cmd,
        timeoutMs: authorization.timeoutMs,
        projectDir
      });
    }

    // Streamed NDJSON response (Content-Type: application/x-ndjson):
    // one line per live output chunk while the command is still running,
    // then a final `result` line with the complete tool result. The chat
    // composer's /shell card renders the output lines into its live
    // preview, so a direct run behaves exactly like a model-driven run
    // (which streams `shell_output` SSE frames). Error frames never
    // appear here — the pre-run failures above (authorization, bad
    // input) are plain JSON responses; only the run itself streams.
    // The client treats a non-NDJSON body as a fallback and reads it as
    // JSON, so an older server still works.
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    const out = await shellTool.runShell({
      projectDir, cmd,
      shell: shellOverride || undefined,
      timeoutMs: authorization.timeoutMs,
      // Live output deltas for the composer card, mirroring the
      // `shell_output` SSE event of the model-driven path.
      onOutput: (stream, delta) => {
        try {
          res.write(JSON.stringify({ type: 'output', stream, delta }) + '\n');
        } catch { /* client disconnected; the run keeps going server-side */ }
      }
    });
    // Same identity header the model-facing tool message carries, so a
    // composer /shell run reads exactly like a model-driven run.
    if (out && typeof out === 'object' && !out.identity) out.identity = 'mouaif shell';
    try {
      res.end(JSON.stringify({ type: 'result', result: out }) + '\n');
    } catch { /* client gone */ }
    return;
  }

  // GET /api/tools/cli/session?projectDir=<abs>
  // Start (or reuse) the persistent interactive terminal session for the
  // project and return its id. The browser then opens GET /events and
  // listens for `cli_output` frames tagged with that id.
  if (urlPath === '/api/tools/cli/session' && method === 'GET') {
    const projectDir = qs(q, 'projectDir');
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    const fs = require('node:fs');
    let real;
    try { real = fs.realpathSync(projectDir); } catch { return sendJSON(res, 400, { error: 'project directory not found', code: 'ENOENT' }); }
    let st;
    try { st = fs.statSync(real); } catch { return sendJSON(res, 400, { error: 'project directory not found', code: 'ENOENT' }); }
    if (!st.isDirectory()) return sendJSON(res, 400, { error: 'projectDir is not a directory', code: 'ENOTDIR' });
    const session = ensureCliSession(real);
    // Attach the SSE output stream to the newly created (or reused)
    // session. Re-used sessions already have their stream attached —
    // attaching twice would double every output frame in the browser.
    if (!session._streamAttached) {
      session._streamAttached = true;
      attachCliStream(session, broadcast);
    }
    const meta = cliShellMeta();
    return sendJSON(res, 200, {
      id: session.id,
      projectDir: real,
      shell: meta.label,
      // True when the session runs on a pseudo-terminal, so prompting
      // programs (npm under 2FA, git, sudo) can ask a question and read
      // the answer. The modal surfaces this so a user knows interactive
      // input is supported.
      interactive: !!session.pty,
      startedAt: session.startedAt,
      defaultDir: real
    });
  }

  // POST /api/tools/cli/command  body: { projectDir, cmd }
  // Write one command to the persistent session's stdin. The session
  // stays open; the next command appends after it.
  if (urlPath === '/api/tools/cli/command' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const cmd = body && typeof body.cmd === 'string' ? body.cmd : '';
    // `raw` sends the text with no line terminator (a single-key answer).
    const raw = !!(body && body.raw);
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    const session = cliSessions.get(String(projectDir));
    if (!session) return sendJSON(res, 404, { error: 'cli session not found — reopen the command prompt', code: 'ENOSESSION' });
    try {
      if (!writeCliCommand(session, cmd, raw)) {
        return sendJSON(res, 410, { ok: false, error: 'cli session is not accepting input — reopen the command prompt', code: 'ENOWRITE' });
      }
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/tools/cli/close  body: { projectDir }
  // Kill the persistent session (idempotent).
  if (urlPath === '/api/tools/cli/close' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    closeCliSession(projectDir);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/tools/webpreview  body: { projectDir, chatId, url, viewport? }
  // Direct user-facing refresh of the web preview from the full-screen
  // viewer (and the dock's Dismiss/Refresh cycle). The user may change the
  // capture resolution with `viewport` (preset id or "WIDTHxHEIGHT"). The
  // run goes through the same webpreview authorization gate as the
  // model-driven path, so a disabled tool (mode 'off') is refused and an
  // 'ask'-gated project still prompts. The result is returned as plain JSON
  // (no SSE stream) — the chat UI publishes the fresh screenshot into its
  // preview dock exactly as a model-driven capture does.
  if (urlPath === '/api/tools/webpreview' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const chatId = body && typeof body.chatId === 'string' ? body.chatId : '';
    const url = body && typeof body.url === 'string' ? body.url.trim() : '';
    const viewport = body && typeof body.viewport === 'string' ? body.viewport : '';
    const callId = (body && typeof body.callId === 'string' && body.callId) ||
      ('ui_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!url) return sendJSON(res, 400, { error: 'url is required' });
    if (!chatId) return sendJSON(res, 400, { error: 'chatId is required' });
    if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId });
    // Gate through the same authorization module the model path uses. The URL
    // is the summary (matching the allowlist by hostname / full URL) and the
    // flow is 'retry' so a prompt resolves as a normal user decision.
    let authorization;
    try {
      authorization = await require('./tools/authorization.js').authorize({
        projectDir, chatId, callId, tool: 'webpreview', url, summary: url, flow: 'retry'
      });
    } catch (e) {
      const status = e.code === 'ETOOL_DISABLED' || e.code === 'EDENIED' ? 403 : 400;
      return sendJSON(res, status, { ok: false, error: e.message, code: e.code || 'EAUTH' });
    }
    if (authorization.decision === 'prompt') {
      return sendJSON(res, 409, {
        ok: false,
        code: 'EAUTH_REQUIRED',
        chatId,
        callId,
        tool: 'webpreview',
        url,
        projectDir
      });
    }
    // Run the native capture. Only the user-facing result is returned; the
    // screenshot is published to the dock by the same tool-publish hook the
    // model path uses.
    let wp;
    try { wp = require('./tools/webpreview.js'); }
    catch (e) {
      return sendJSON(res, 500, { ok: false, error: 'webpreview tool module unavailable: ' + (e.message || e), code: 'EMODULE' });
    }
    try {
      const out = await wp.runWebpreview({ url, viewport: viewport || undefined });
      return sendJSON(res, 200, out);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message || String(e), code: e.code || 'EWEBPREVIEW' });
    }
  }
// POST /api/tools/subagent  body: { projectDir, chatId, task, agent?, context?, modelId?, providerId? }
// Direct subagent dispatch from the composer (@agent <task>). Runs the
// native subagent tool through the same authorization gate and the
  // same dispatcher the model-driven loop uses — one tool_call +
  // tool_result pair, returned in the JSON body (no SSE stream).
  if (urlPath === '/api/tools/subagent' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const chatId = body && typeof body.chatId === 'string' ? body.chatId : '';
    const task = body && typeof body.task === 'string' ? body.task.trim() : '';
    const agentName = body && typeof body.agent === 'string' ? body.agent.trim() : '';
    const context = body && typeof body.context === 'string' ? body.context : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    if (!chatId) return sendJSON(res, 400, { error: 'chatId is required' });
    if (!task) return sendJSON(res, 400, { error: 'task is required' });
    const chat = chats.getChat(projectDir, chatId);
    if (!chat) return sendJSON(res, 404, { error: 'Chat not found', chatId });

    // Model: explicit body.modelId wins, else the chat's current model.
    const modelId = typeof body.modelId === 'string' && body.modelId ? body.modelId : (chat.modelId || '');
    const providerId = typeof body.providerId === 'string' && body.providerId ? body.providerId : (chat.providerId || '');
    if (!modelId) return sendJSON(res, 400, { error: 'No model selected for this chat' });
    let model;
    try { model = resolveModel(modelId, projectDir, providerId); }
    catch (e) { return sendJSON(res, e.code === 'EMODEL_NOT_FOUND' || e.code === 'EPROVIDER_NOT_FOUND' ? 404 : 400, { error: e.message, code: e.code || 'EBADMODEL' }); }
    // Inherit the chat's thinking level so a delegated run (agent pin or
    // generic) matches what a normal chat turn would send. An agent's own
    // thinkingLevel still wins inside the dispatcher.
    if (typeof chat.thinkingLevel === 'string' && chat.thinkingLevel) model.thinkingLevel = chat.thinkingLevel;

    let appSettings;
    try { appSettings = settings.getApp(); } catch { /* defaults apply */ }
    const args = { task };
    if (agentName) args.agent = agentName;
    if (context) args.context = context;

    const callId = 'direct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const events = [];
    try {
      const out = await ai.runSingleToolCall(
        { id: callId, name: 'subagent', arguments: JSON.stringify(args) },
        {
          opts: {
            projectDir,
            chatId,
            appSettings,
            promptSize: chat.promptSize,
            enabledTools: Array.isArray(chat.tools) ? chat.tools : null,
            model
          },
          onEvent: (name, data) => events.push({ name, data }),
          convo: null,
          toolSpecs: [],
          promptProfilesMod: null,
          discoveredToolNames: null,
          modelContentForTool: (name, exec) => (exec && exec.content) || '',
          getLastToolCallKey: () => null,
          setLastToolCallKey: () => {},
          getRepeatedToolCallCount: () => 0,
          setRepeatedToolCallCount: () => {},
          REPEATED_TOOL_CALL_LIMIT: 3
          }
      );
      const exec = out && out.exec;
      const result = exec && exec.result;
      const toolCall = events.find((e) => e.name === 'tool_call');
      if (exec && exec.ok && result && typeof result.text === 'string' && result.text) {
        let total = Number(result.totalCost);
        if (!(isFinite(total) && total >= 0) && result.model && result.usage) {
          try {
            const estimated = usage.computeCost({ model: result.model, usage: result.usage, app: appSettings });
            total = estimated.known ? estimated.total : NaN;
          } catch { total = NaN; }
        }
        const cost = isFinite(total) && total >= 0
          ? { known: true, input: 0, output: 0, total, currency: 'USD' }
          : { known: false, input: 0, output: 0, total: 0, currency: 'USD' };
        try {
          messages.appendMessage(projectDir, chatId, {
            role: 'assistant',
            content: result.text,
            usage: result.usage || undefined,
            cost,
            modelId: result.model && result.model.id ? result.model.id : model.id
          });
        } catch { /* direct dispatch still returns its result if persistence fails */ }
        result.cost = cost;
      }
      const payload = {
        ok: !!(exec && exec.ok),
        id: callId,
        name: 'subagent',
        args,
        result,
        toolCall: toolCall ? { id: toolCall.data && toolCall.data.id, name: toolCall.data && toolCall.data.name, args: toolCall.data && toolCall.data.args } : { id: callId, name: 'subagent', args }
      };
      return sendJSON(res, 200, payload);
    } catch (e) {
      const status = e && (e.code === 'ETOOL_DISABLED' || e.code === 'EDENIED') ? 403 : 500;
      return sendJSON(res, status, { ok: false, error: (e && e.message) || String(e), code: (e && e.code) || 'ESUBAGENT' });
    }
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

module.exports = { handleTools, ensureCliSession, closeCliSession, writeCliCommand, cliShellMeta, attachCliStream };
