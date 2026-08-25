'use strict';
// Project custom actions: user-authored one-tap shortcuts backed by either
// the native shell runner or a configured MCP tool. The definitions live in
// the project settings under `customActions`; execution still goes through
// the underlying shell/MCP authorization gate.
const settings = require('./settings.js');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS = new Set(['cli', 'mcp']);
function typedError(code, message) {
return Object.assign(new Error(message), { code });
}
function isPlainObject(value) {
return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function cleanText(value, max) {
return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function normalizeAction(raw, index) {
if (!isPlainObject(raw)) throw typedError('EBADINPUT', 'custom action ' + (index + 1) + ' must be an object');
const id = cleanText(raw.id, 64);
if (!ID_RE.test(id)) throw typedError('EBADINPUT', 'custom action id must start with a letter or digit and use only letters, digits, ., _, or -');
const kind = cleanText(raw.kind, 16);
if (!KINDS.has(kind)) throw typedError('EBADINPUT', 'custom action ' + id + ' kind must be "cli" or "mcp"');
const action = {
id,
label: cleanText(raw.label, 120) || id,
description: cleanText(raw.description, 500),
kind
};
if (kind === 'cli') {
action.command = cleanText(raw.command, 16 * 1024);
if (!action.command) throw typedError('EBADINPUT', 'custom action ' + id + ' command is required');
if (Number.isFinite(raw.timeoutMs)) action.timeoutMs = Math.max(1, Math.min(600000, Math.round(raw.timeoutMs)));
} else {
action.serverId = cleanText(raw.serverId, 256);
action.toolName = cleanText(raw.toolName, 256);
if (!action.serverId) throw typedError('EBADINPUT', 'custom action ' + id + ' serverId is required');
if (!action.toolName) throw typedError('EBADINPUT', 'custom action ' + id + ' toolName is required');
action.args = isPlainObject(raw.args) ? raw.args : {};
}
return action;
}
function normalizeActions(raw) {
if (raw == null) return [];
if (!Array.isArray(raw)) throw typedError('EBADINPUT', 'customActions must be an array');
if (raw.length > 100) throw typedError('EBADINPUT', 'customActions is limited to 100 entries');
const actions = raw.map(normalizeAction);
const seen = new Set();
for (const action of actions) {
const key = action.id.toLowerCase();
if (seen.has(key)) throw typedError('EBADINPUT', 'duplicate custom action id: ' + action.id);
seen.add(key);
}
return actions;
}
function listActions(projectDir) {
const project = settings.getProject(projectDir);
return normalizeActions(project && project.customActions);
}
function replaceActions(projectDir, raw) {
const actions = normalizeActions(raw);
settings.setProject(projectDir, { customActions: actions });
return actions;
}
module.exports = { ID_RE, normalizeAction, normalizeActions, listActions, replaceActions };
