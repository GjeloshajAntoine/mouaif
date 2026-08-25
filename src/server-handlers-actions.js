'use strict';
// Project custom-action CRUD + execution REST handlers.
const { sendJSON, qs, readJsonOr400, chats, mcp, shellTool } = require('./server-shared.js');
const customActions = require('./custom-actions.js');
function statusFor(error) {
if (error && ['EBADINPUT', 'MOUAIF_PROJECT_PARSE_ERROR'].includes(error.code)) return 400;
if (error && (error.code === 'ETOOL_DISABLED' || error.code === 'EDENIED')) return 403;
if (error && error.code === 'EMCP_NOTFOUND') return 404;
return 500;
}
function findAction(projectDir, id) {
return customActions.listActions(projectDir).find((action) => action.id === id) || null;
}
async function handleActions(req, res, parsed) {
const urlPath = parsed.pathname;
const method = req.method;
const q = parsed.query || {};
if (urlPath === '/api/actions' && method === 'GET') {
const projectDir = qs(q, 'projectDir');
if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
try { return sendJSON(res, 200, { actions: customActions.listActions(projectDir) }); }
catch (error) { return sendJSON(res, statusFor(error), { error: error.message, code: error.code || 'INTERNAL' }); }
}
if (urlPath === '/api/actions' && method === 'POST') {
const body = await readJsonOr400(req, res);
if (!body) return;
const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
try {
const action = customActions.normalizeAction(body.action, 0);
const actions = customActions.listActions(projectDir);
const originalId = typeof body.originalId === 'string' ? body.originalId : '';
const index = originalId ? actions.findIndex((item) => item.id === originalId) : -1;
if (index >= 0) actions[index] = action; else actions.push(action);
const saved = customActions.replaceActions(projectDir, actions);
return sendJSON(res, 200, { action, actions: saved });
} catch (error) {
return sendJSON(res, statusFor(error), { error: error.message, code: error.code || 'INTERNAL' });
}
}
let match = urlPath.match(/^\/api\/actions\/([^/]+)$/);
if (match && method === 'DELETE') {
const projectDir = qs(q, 'projectDir');
if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
const id = decodeURIComponent(match[1]);
try {
const actions = customActions.listActions(projectDir);
const next = actions.filter((action) => action.id !== id);
if (next.length === actions.length) return sendJSON(res, 404, { error: 'Action not found', id });
customActions.replaceActions(projectDir, next);
return sendJSON(res, 200, { ok: true, actions: next });
} catch (error) {
return sendJSON(res, statusFor(error), { error: error.message, code: error.code || 'INTERNAL' });
}
}
match = urlPath.match(/^\/api\/actions\/([^/]+)\/run$/);
if (match && method === 'POST') {
const body = await readJsonOr400(req, res);
if (!body) return;
const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
const chatId = body && typeof body.chatId === 'string' ? body.chatId : '';
const callId = body && typeof body.callId === 'string' ? body.callId : '';
if (!projectDir || !chatId || !callId) return sendJSON(res, 400, { error: 'projectDir, chatId, and callId are required' });
if (!chats.getChat(projectDir, chatId)) return sendJSON(res, 404, { error: 'Chat not found', chatId });
try {
const id = decodeURIComponent(match[1]);
const action = findAction(projectDir, id);
if (!action) return sendJSON(res, 404, { error: 'Action not found', id });
if (action.kind === 'cli') {
const authorization = await require('./tools/authorization.js').authorize({
projectDir, chatId, callId, tool: 'shell', cmd: action.command,
summary: action.label + ': ' + action.command, timeoutMs: action.timeoutMs, flow: 'retry'
});
if (authorization.decision === 'prompt') return sendJSON(res, 409, {
ok: false, code: 'EAUTH_REQUIRED', projectDir, chatId, callId,
tool: 'shell', cmd: action.command, timeoutMs: authorization.timeoutMs
});
const result = await shellTool.runShell({ projectDir, cmd: action.command, timeoutMs: authorization.timeoutMs });
return sendJSON(res, 200, { ok: !!result.ok, action, result });
}
const server = mcp.getServer(projectDir, action.serverId);
if (!server) return sendJSON(res, 404, { error: 'MCP server not found', serverId: action.serverId });
const tool = mcp.composedToolName(server.slug, action.toolName);
const authorization = await require('./tools/authorization.js').authorize({
projectDir, chatId, callId, tool, args: action.args,
summary: action.label + ': ' + JSON.stringify(action.args || {}), flow: 'retry'
});
if (authorization.decision === 'prompt') return sendJSON(res, 409, {
ok: false, code: 'EAUTH_REQUIRED', projectDir, chatId, callId, tool,
args: action.args, timeoutMs: authorization.timeoutMs
});
const result = await mcp.callTool(projectDir, server.slug, action.toolName, action.args || {});
return sendJSON(res, 200, { ok: result && result.ok !== false, action, result });
} catch (error) {
return sendJSON(res, statusFor(error), { ok: false, error: error.message, code: error.code || 'INTERNAL' });
}
}
return sendJSON(res, 404, { error: 'Not found', scope: 'actions' });
}
module.exports = { handleActions };
