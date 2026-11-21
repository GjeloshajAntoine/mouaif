'use strict';

// mouaif — the app event stream, GET /events (docs/features/live-events.md)
//
// One SSE stream per tab tells the page that something changed. It carries
// small notices, never the data itself: the page fetches what changed with
// the endpoints it already uses ("rows after my seq", "/pending", …). A notice
// can therefore be dropped or coalesced without losing anything, and a page
// that reconnects catches up with one resync.
//
// Notices are sent from the one write function of each store (the message
// store, the run registry, the approval queue), so every writer is covered:
// an HTTP handler, a background subagent, a hook turn, the CLI.
//
// This module has no dependencies on the rest of the server so the stores can
// require it without a cycle.

const clients = new Set();

// handleSSE(req, res, filter?) — attach a client. `filter(event, data)` limits
// what one client receives: a share caller only gets its own project's
// notices (src/http-server.js → dispatchShareRequest).
function handleSSE(req, res, filter) {
  if (typeof filter === 'function') res.__eventFilter = filter;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Ask buffering proxies (nginx) to pass frames through as they come.
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);
  clients.add(res);
  // Heartbeat every 30 s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* closed */ }
  }, 30000);
  req.on('close', () => {
    clients.delete(res);
    clearInterval(heartbeat);
  });
}

// broadcast(event, data) — send one named event to every client whose filter
// lets it through.
function broadcast(event, data) {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (client.__eventFilter) {
      let pass = false;
      try { pass = client.__eventFilter(event, data); } catch { pass = false; }
      if (!pass) continue;
    }
    try { client.write(payload); } catch { /* closed; its close handler removes it */ }
  }
}

// ---- Chat notices -----------------------------------------------------------

// chat_rows is coalesced per chat to one notice per turn of the event loop: a
// tool round writes several rows back to back, and the page only needs to
// know the newest cursor (it always fetches "rows after my seq").
const rowsQueue = new Map();
let rowsFlush = null;

function chatKey(projectDir, chatId) {
  return String(projectDir) + '\0' + String(chatId);
}

function flushChatRows() {
  rowsFlush = null;
  const list = Array.from(rowsQueue.values());
  rowsQueue.clear();
  if (!clients.size) return;
  for (const { projectDir, chatId } of list) {
    let nextSeq;
    try { nextSeq = require('./chatdb.js').messageCursorDb(projectDir, chatId).nextSeq; } catch { continue; }
    broadcast('chat_rows', { projectDir, chatId, nextSeq });
  }
}

// chatRowsChanged(projectDir, chatId) — a chat's saved rows were appended,
// replaced or cleared.
function chatRowsChanged(projectDir, chatId) {
  if (!clients.size || !projectDir || !chatId) return;
  rowsQueue.set(chatKey(projectDir, chatId), { projectDir, chatId });
  if (!rowsFlush) rowsFlush = setImmediate(flushChatRows);
}

// chatRunChanged(projectDir, chatId, running) — a turn started or ended.
// Sent after the rows queued so far, so a page that reacts to "ended" already
// sees the turn's last rows.
function chatRunChanged(projectDir, chatId, running) {
  if (!clients.size || !projectDir || !chatId) return;
  if (rowsFlush) { clearImmediate(rowsFlush); flushChatRows(); }
  broadcast('chat_run', { projectDir, chatId, running: !!running });
}

// chatCostChanged(projectDir, chatId) — a chat's saved Total moved without a
// new row (addChatCost: a background subagent billed after its turn ended,
// dictation, a shell review). Coalesced per chat like chat_rows.
const costQueue = new Map();
let costFlush = null;

function flushChatCost() {
  costFlush = null;
  const list = Array.from(costQueue.values());
  costQueue.clear();
  for (const data of list) broadcast('chat_cost', data);
}

function chatCostChanged(projectDir, chatId) {
  if (!clients.size || !projectDir || !chatId) return;
  costQueue.set(chatKey(projectDir, chatId), { projectDir, chatId });
  if (!costFlush) costFlush = setImmediate(flushChatCost);
}

// authPendingChanged(projectDir, chatId, callId, open) — an approval prompt
// was parked (`open`) or settled.
function authPendingChanged(projectDir, chatId, callId, open) {
  if (!clients.size || !projectDir || !chatId) return;
  broadcast('auth_pending', { projectDir, chatId, callId: String(callId || ''), open: !!open });
}

// ---- Project and app notices -------------------------------------------------

// projectChanged(projectDir, what, chatId?) — something project-scoped
// changed: `hooks` (project hook trust or list), `extensions` (project
// extension trust or switch), `app_context` (a chat's extension-view context,
// with its chatId). Coalesced per (project, what, chat) like chat_rows.
const projectQueue = new Map();
let projectFlush = null;

function flushProject() {
  projectFlush = null;
  const list = Array.from(projectQueue.values());
  projectQueue.clear();
  for (const data of list) broadcast('project_changed', data);
}

function projectChanged(projectDir, what, chatId) {
  if (!clients.size || !projectDir || !what) return;
  const data = chatId ? { projectDir, what, chatId } : { projectDir, what };
  projectQueue.set(String(projectDir) + '\0' + what + '\0' + (chatId || ''), data);
  if (!projectFlush) projectFlush = setImmediate(flushProject);
}

// appChanged(what) — something app-wide changed: `share` (shares, peers,
// whether a peer is online), `extensions` (app extensions), `mcp_auth` (an
// MCP server sign-in). Coalesced per `what`. Never sent to a share caller.
const appQueue = new Set();
let appFlush = null;

function flushApp() {
  appFlush = null;
  const list = Array.from(appQueue);
  appQueue.clear();
  for (const what of list) broadcast('app_changed', { what });
}

function appChanged(what) {
  if (!clients.size || !what) return;
  appQueue.add(what);
  if (!appFlush) appFlush = setImmediate(flushApp);
}

// The events a share caller may receive for its own project.
const PROJECT_EVENTS = new Set(['chat_rows', 'chat_cost', 'chat_run', 'auth_pending', 'project_changed']);

module.exports = {
  clients,
  handleSSE,
  broadcast,
  chatRowsChanged,
  chatRunChanged,
  chatCostChanged,
  authPendingChanged,
  projectChanged,
  appChanged,
  PROJECT_EVENTS
};
