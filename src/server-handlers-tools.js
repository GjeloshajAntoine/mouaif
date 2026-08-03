'use strict';

// Native tool REST handlers (shell, subagent, tool list). Extracted
// from the original single-file http-server.js. Shared helpers live in
// src/server-shared.js.

const {
  sendJSON,
  readJsonBody,
  resolveModel,
  settings,
  chats,
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
  if (process.platform === 'win32') {
    // Windows Terminal Detection: if the session's env already has a WSL
    // or PowerShell default, use it; otherwise cmd.exe (the classic prompt).
    return {
      exe: process.env.ComSpec || 'cmd.exe',
      args: [],
      label: 'Command Prompt (cmd.exe)',
      windows: true
    };
  }
  const shellPath = process.env.SHELL || '/bin/sh';
  return {
    exe: shellPath,
    args: [],
    label: 'Shell (' + shellPath + ')',
    windows: false
  };
}

// Start the persistent session (idempotent) and return the session handle.
function ensureCliSession(projectDir) {
  const key = String(projectDir || '');
  const existing = cliSessions.get(key);
  if (existing && existing.child && !existing.child.killed) return existing;
  const meta = cliShellMeta();
  const child = spawn(meta.exe, meta.args, {
    cwd: projectDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const session = {
    id: 'cli_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    projectDir,
    child,
    startedAt: Date.now()
  };
  hookCliExit();
  cliSessions.set(key, session);
  // Reap on exit so a closed session doesn't leak.
  child.on('exit', () => { if (cliSessions.get(key) === session) cliSessions.delete(key); });
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

// Forward a session's stdout/stderr to the SSE broadcast channel. The
// browser opens GET /events, receives the session id, and listens for
// `cli_output` frames tagged with that id.
function attachCliStream(session, broadcast) {
  if (!session || !session.child || !broadcast) return;
  session.child.stdout.on('data', (d) => {
    broadcast('cli_output', { id: session.id, stream: 'stdout', data: Buffer.isBuffer(d) ? d.toString('utf8') : String(d) });
  });
  session.child.stderr.on('data', (d) => {
    broadcast('cli_output', { id: session.id, stream: 'stderr', data: Buffer.isBuffer(d) ? d.toString('utf8') : String(d) });
  });
  session.child.on('exit', (code) => {
    broadcast('cli_output', { id: session.id, stream: 'exit', data: String(code) });
  });
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
//     -> { ok, stdout, stderr, exitCode, durationMs } | { ok:false, error, code }
// The tool is off unless the project's resolved settings enable it
// (settings.tools.shell.enabled). A disabled project returns
// ETOOL_DISABLED with HTTP 403.
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
    const projectDir = typeof q.projectDir === 'string' ? q.projectDir : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    // A chat opening (or the mobile UI re-loading a project) should
    // re-attach the MCP servers it needs. The Settings UI documents
    // this as "open a chat that references a stopped server" — without
    // it, the tool list comes back empty after a server restart even
    // though the servers are enabled, which reads as "not saved".
    // Wait for discovery so this response is authoritative. Returning
    // before enabled servers finish starting makes a fresh .mcp.json
    // configuration disappear from the first tool catalog (there may be
    // no cache yet), and callers have no completion signal to know when
    // to retry. ensureEnabledServers isolates failures per server, so one
    // broken MCP process does not fail the native-tool catalog.
    await mcp.ensureEnabledServers(projectDir).catch(() => []);
    const tools = [];
    try {
      const shell = require('./tools/shell.js');
      tools.push({
        name: 'shell',
        kind: 'native',
        source: 'shell',
        description: (shell.SPEC && shell.SPEC.function && shell.SPEC.function.description) || 'Run a shell command in the project directory.'
      });
    } catch { /* shell module unavailable; omit */ }
    try {
      const prog = require('./tools/progress.js');
      tools.push({
        name: 'report_progress',
        kind: 'native',
        source: 'progress',
        description: (prog.SPEC && prog.SPEC.function && prog.SPEC.function.description) || 'Report real-time progress on a long-running operation.'
      });
    } catch { /* progress module unavailable; omit */ }
    try {
      const subagent = require('./tools/subagent.js');
      tools.push({
        name: 'subagent',
        kind: 'native',
        source: 'subagent',
        description: (subagent.SPEC && subagent.SPEC.function && subagent.SPEC.function.description) || 'Delegate a focused task to a nested AI call.'
      });
    } catch { /* subagent module unavailable; omit */ }
    try {
      const af = require('./agentFeatures.js');
      tools.push({
        name: 'list_features',
        kind: 'native',
        source: 'features',
        description: (af.LIST_FEATURES_SPEC && af.LIST_FEATURES_SPEC.function && af.LIST_FEATURES_SPEC.function.description) || 'Describe mouaif feature state.'
      });
    } catch { /* feature module unavailable; omit */ }
    try {
      const ask = require('./tools/ask.js');
      tools.push({
        name: 'ask_user',
        kind: 'native',
        source: 'ask_user',
        description: (ask.SPEC && ask.SPEC.function && ask.SPEC.function.description) || 'Ask the user a structured question with options.'
      });
    } catch { /* ask_user module unavailable; omit */ }
    try {
      const taskMod = require('./tools/task.js');
      tools.push({
        name: 'task',
        kind: 'native',
        source: 'task',
        description: (taskMod.SPEC && taskMod.SPEC.function && taskMod.SPEC.function.description) || 'Create, update, track progress on, and list structured tasks with subtasks.'
      });
    } catch { /* task module unavailable; omit */ }
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
          description: s.description || '',
          parameters: s.parameters || null
        });
      }
    } catch { /* mcp module not loaded; no MCP tools */ }
    return sendJSON(res, 200, { tools });
  }

  if (urlPath === '/api/tools/shell' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
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

    // Gate on the per-project enable flag.
    let enabled = false;
    try {
      const resolved = settings.getResolved(projectDir || null);
      enabled = !!(resolved && resolved.tools && resolved.tools.shell && resolved.tools.shell.enabled);
    } catch { /* stays disabled */ }
    if (!enabled) {
      return sendJSON(res, 403, { ok: false, error: 'shell tool is disabled for this project', code: 'ETOOL_DISABLED' });
    }

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

    const out = await shellTool.runShell({ projectDir, cmd, shell: shellOverride || undefined, timeoutMs: authorization.timeoutMs });
    // Same identity header the model-facing tool message carries, so a
    // composer /shell run reads exactly like a model-driven run.
    if (out && typeof out === 'object' && !out.identity) out.identity = 'mouaif shell';
    const status = out.ok ? 200 : (out.code === 'EOUTSIDE_PROJECT' || out.code === 'ENOENT' ? 400 : 200);
    return sendJSON(res, status, out);
  }

  // GET /api/tools/cli/session?projectDir=<abs>
  // Start (or reuse) the persistent interactive terminal session for the
  // project and return its id. The browser then opens GET /events and
  // listens for `cli_output` frames tagged with that id.
  if (urlPath === '/api/tools/cli/session' && method === 'GET') {
    const projectDir = typeof q.projectDir === 'string' ? q.projectDir : '';
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
      startedAt: session.startedAt,
      defaultDir: real
    });
  }

  // POST /api/tools/cli/command  body: { projectDir, cmd }
  // Write one command to the persistent session's stdin. The session
  // stays open; the next command appends after it.
  if (urlPath === '/api/tools/cli/command' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const cmd = body && typeof body.cmd === 'string' ? body.cmd : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    const session = cliSessions.get(String(projectDir));
    if (!session) return sendJSON(res, 404, { error: 'cli session not found — reopen the command prompt', code: 'ENOSESSION' });
    try {
      session.child.stdin.write(cmd + '\r\n');
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/tools/cli/close  body: { projectDir }
  // Kill the persistent session (idempotent).
  if (urlPath === '/api/tools/cli/close' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
    const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
    closeCliSession(projectDir);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/tools/subagent  body: { projectDir, chatId, task, agent?, context?, modelId?, providerId? }
  // Direct subagent dispatch from the composer (@agent <task>). Runs the
  // native subagent tool through the same authorization gate and the
  // same dispatcher the model-driven loop uses — one tool_call +
  // tool_result pair, returned in the JSON body (no SSE stream).
  if (urlPath === '/api/tools/subagent' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJSON(res, e.status || 400, { error: e.message }); }
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
          REPEATED_TOOL_CALL_LIMIT: 3,
          onDelegatedUsage: null
        }
      );
      const exec = out && out.exec;
      const toolCall = events.find((e) => e.name === 'tool_call');
      const payload = {
        ok: !!(exec && exec.ok),
        id: callId,
        name: 'subagent',
        args,
        result: exec && exec.result,
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

module.exports = { handleTools };
