'use strict';

// Chat + message REST handlers, including the SSE streaming loop
// (handleChatStream). Extracted from the original single-file
// http-server.js so no file stays above ~2 000 lines. Shared state
// (runningChats, runningChatCancels) and helpers live in
// src/server-shared.js.

const {
sendJSON,
qs,
readJsonOr400,
runningKey,
runningChats,
runningChatCancels,
resolveModel,
settings,
chats,
messages,
trace,
push,
usage,
promptProfiles,
prompts,
agentFiles,
agentSkills,
agentFeatures,
tags,
mcp,
shellTool,
ai,
liveChat,
safeDecode
} = require('./server-shared.js');
const { resolveNotificationPrefs } = require('./notifications.js');


// resolveNotificationPrefs(saved) now lives in src/notifications.js so the
// access sign-in push and the chat streaming push resolve the same
// preferences (status, authorization, quickActions, and the login alert).
// See that module for the legacy-key fallbacks.


async function handleChats(req, res, parsed, sessionToken, lifecycle = {}) {
const urlPath = parsed.pathname;

  const method = req.method;
  const q = parsed.query || {};

  function chatError(e) {
    if (e && e.code === 'MOUAIF_PROJECT_PARSE_ERROR') return 422;
    if (e && e.code === 'EBADINPUT') return 400;
    return 500;
  }

  function readProjectDir(body) {
    const fromQuery = qs(q, 'projectDir');
    const fromBody = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    const dir = fromQuery || fromBody;
    if (!dir) return null;
    return dir;
  }

  // GET /api/chats?projectDir=<abs>[&offset=0&limit=20]
  if (urlPath === '/api/chats' && method === 'GET') {
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    const offset = Math.max(0, parseInt(typeof q.offset === 'string' ? q.offset : '0', 10) || 0);
    const limitRaw = parseInt(typeof q.limit === 'string' ? q.limit : '0', 10) || 0;
    const limit = limitRaw > 0 ? Math.min(limitRaw, 100) : 0;
    try {
      const page = chats.listChats(dir, { offset, limit });
const total = limit > 0 ? chats.countChats(dir) : page.length;
// Chat cost totals are persisted on chat metadata when cost-bearing
// messages are written. Listing chats never scans message_store.
// `messageCount` is a per-page bulk COUNT (one indexed GROUP BY), so the
// project card can flag a draft-only chat — persisted messages === 0 —
// without any N+1 query and without sending transcript text down.
//
// List rows are summaries (src/chatdb.js#LIST_COLUMNS): a chat's
// `draftSnippet` + `hasDraftImage` stand in for the `draft` and
// `draftAttachments` bodies, which can run to megabytes when a picture sits
// in the composer. The card only previews the draft, so the bodies stay in
// SQLite until a single-chat read (GET /api/chats/:id) asks for them.
const pageCounts = messages.projectMessageCounts(dir, page.map((c) => c.id));
for (const c of page) {
if (runningChats.has(runningKey(dir, c.id))) c.running = true;
c.messageCount = pageCounts[c.id] || 0;
}
      return sendJSON(res, 200, {
        chats: page,
        total,
        offset,
        limit: limit || page.length
      });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/chats/:id?projectDir=<abs>
  let m = urlPath.match(/^\/api\/chats\/([^/]+)$/);
  if (m && method === 'GET') {
    const id = safeDecode(m[1]);
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const chat = chats.getChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id });
      // Response-only liveness marker (never persisted on the record).
      if (runningChats.has(runningKey(dir, id))) chat.running = true;
      return sendJSON(res, 200, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats   body: { projectDir, title?, trace?, promptSize?, promptId? }
if (urlPath === '/api/chats' && method === 'POST') {
const body = await readJsonOr400(req, res);
if (!body) return;
const dir = readProjectDir(body);
if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
try {
if (body.promptId != null && body.promptId !== '') {
if (typeof body.promptId !== 'string' || !prompts.getPrompt(dir, body.promptId)) {
return sendJSON(res, 400, { error: 'Unknown promptId' });
}
}
const chat = chats.createChat(dir, body || {});
      return sendJSON(res, 201, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // PATCH /api/chats/:id   body: { projectDir, title?, trace?, promptSize?, draft?, draftAttachments? }
  m = urlPath.match(/^\/api\/chats\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const id = safeDecode(m[1]);
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = readProjectDir(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    // Strip server-owned fields from the client patch. The generic
    // merge in updateChat absorbs every key, so without this a PATCH
    // could rewrite the chat's id, createdAt, or lastOpenedAt.
    // Internal callers (touchChat, titleChatFromPrompt) set those
    // fields intentionally and don't come through here.
    const safeBody = Object.assign({}, body || {});
    delete safeBody.id;
delete safeBody.createdAt;
delete safeBody.lastOpenedAt;
try {
if (safeBody.promptId != null && safeBody.promptId !== '') {
if (typeof safeBody.promptId !== 'string' || !prompts.getPrompt(dir, safeBody.promptId)) {
return sendJSON(res, 400, { error: 'Unknown promptId' });
}
}
const chat = chats.updateChat(dir, id, safeBody);
      if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id });
      return sendJSON(res, 200, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats/:id/touch   body: { projectDir }
  m = urlPath.match(/^\/api\/chats\/([^/]+)\/touch$/);
  if (m && method === 'POST') {
    const id = safeDecode(m[1]);
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = readProjectDir(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      require('./tools/authorization.js').clearGrants(dir, id);
      const chat = chats.touchChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id });
      return sendJSON(res, 200, { chat });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // DELETE /api/chats/:id?projectDir=<abs>
  m = urlPath.match(/^\/api\/chats\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const id = safeDecode(m[1]);
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const removed = chats.deleteChat(dir, id);
      if (!removed) return sendJSON(res, 404, { error: 'Chat not found', id });
      // Chat storage and trace export are independent. Deleting a chat
      // removes its transcript, but deliberately keeps the user-owned trace
      // file so it can remain committed with the project (decision §5).
      try { require('fs').rmSync(messages.messagesFilePath(dir, id), { force: true }); }
      catch { /* best-effort cleanup after the chat record is gone */ }
      // Clean up in-memory task state.
      try { require('./tools/task.js').clearChat(id); } catch { /* non-fatal */ }
      return sendJSON(res, 200, { ok: true, removed: id });
    } catch (e) {
      return sendJSON(res, chatError(e), { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // ---- Per-chat messages -------------------------------------------
// GET /api/chats/:id/messages?projectDir=[&fromSeq=<seq>]      -> { messages, nextSeq, base }
// GET /api/chats/:id/messages?projectDir=[&limit=<n>[&beforeSeq=<seq>]] -> { messages, total, hasMore, nextSeq, base, beforeSeq }
//
// Two modes share one URL:
//
//   - Tail mode (the stream/recovery hot path): `fromSeq` is the next
//     persisted row the caller has not merged. Append-only — fetch rows
//     with seq >= fromSeq and avoid a full transcript transfer unless the
//     server cursor is behind the local cursor. `since` is a compatibility
//     alias.
//
//   - Window mode (chat backward pagination): `limit` returns only the
//     newest `limit` rows (the first page), and `beforeSeq` returns the
//     `limit` rows strictly below that seq (the previous page). This lets
//     a long transcript open fast with just the tail; older pages load on
//     demand as the user scrolls up. `total` and `hasMore` let the client
//     know when every older row has been reached.
const getMsgsMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/messages$/);
if (getMsgsMatch && method === 'GET') {
const id = safeDecode(getMsgsMatch[1]);
const dir = qs(q, 'projectDir');
if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
try {
const chat = chats.getChat(dir, id);
if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id });
// Snapshot the aggregate alongside this response's cursor. All storage
// reads below are synchronous, so appends cannot interleave the snapshot.
const totalCost = chat.totalCost;
const rawFrom = typeof q.fromSeq === 'string' ? q.fromSeq : q.since;
const fromSeq = typeof rawFrom === 'string' ? parseInt(rawFrom, 10) : NaN;
const rawLimit = typeof q.limit === 'string' ? parseInt(q.limit, 10) : 0;
// Window mode is selected by an explicit `limit` (used by the chat
// pagination loader). It takes precedence over fromSeq so the two
// paths never conflict.
if (rawLimit > 0) {
const limit = Math.min(rawLimit, 200);
const beforeSeqRaw = typeof q.beforeSeq === 'string' ? parseInt(q.beforeSeq, 10) : NaN;
const beforeSeq = (isFinite(beforeSeqRaw) && beforeSeqRaw >= 0) ? beforeSeqRaw : Infinity;
const window = messages.listMessagesWindow(dir, id, { limit, beforeSeq });
const total = messages.getMessageCount(dir, id);
// hasMore: a full page AND the oldest returned row is not the first
// message. Because seq is contiguous from 0, an oldest seq of 0 means
// we already reached the very top.
const hasMore = window.length >= limit && window.length > 0 && window[0].seq > 0;
const nextBeforeSeq = hasMore && window.length ? window[0].seq : null;
return sendJSON(res, 200, {
messages: window,
total,
totalCost,
hasMore,
beforeSeq: nextBeforeSeq,
nextSeq: total,
base: total
});
}
const all = messages.listMessages(dir, id);
if (isFinite(fromSeq) && fromSeq >= 0) {
const tail = fromSeq <= all.length ? all.slice(fromSeq) : [];
return sendJSON(res, 200, { messages: tail, nextSeq: all.length, base: all.length, totalCost });
}
return sendJSON(res, 200, { messages: all, nextSeq: all.length, base: all.length, totalCost });
} catch (e) {
const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
}
}

  // GET /api/chats/:id/revision?projectDir= -> { nextSeq, running }
  // Lightweight run state for the reconcile/recovery poll. `nextSeq` is
  // the append-only transcript cursor; if it is ahead of the client cursor,
  // the client fetches just `/messages?fromSeq=<localNextSeq>`.
  const revMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/revision$/);
  if (revMatch && method === 'GET') {
    const id = safeDecode(revMatch[1]);
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const rev = messages.messageCursor(dir, id);
      rev.running = runningChats.has(runningKey(dir, id));
      return sendJSON(res, 200, rev);
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/chats/:id/system-prompt?projectDir= -> { profile, agentFiles, skills, prompt, text }
  // Returns the effective system context for a chat as it will be sent
  // upstream: the resolved prompt-size profile system message, the
  // agent files (when enabled), and, if the chat references a custom
  // prompt, that prompt's content. The chat UI renders this as the
  // first (collapsible) message in the transcript so the user can see
  // what the model is being told, without the prompt-size picker having
  // to be a permanent fixture.
  const sysPromptMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/system-prompt$/);
  if (sysPromptMatch && method === 'GET') {
    const id = safeDecode(sysPromptMatch[1]);
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const chat = chats.getChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'chat not found' });
      let profile = null;
      try {
        const p = promptProfiles.resolveProfile({ chat, projectDir: dir });
        if (p) profile = { id: p.id, label: p.label, description: p.description, systemMessage: p.systemMessage };
      } catch { /* profile stays null; the stream would fall through too */ }
      let prompt = null;
      // The prompt's optional `preset` (tools + agent-files) is part of
      // the chat's effective config for this request — the same shape the
      // stream uses (see resolveChatEffective). It only ADDS to the
      // per-chat toggle (see prompts.effectivePresetConfig), never
      // overrides the project's authorization gate.
      let effectiveChat = chat;
      if (chat.promptId) {
        try {
          const cp = prompts.getPrompt(dir, chat.promptId);
          if (cp) {
            prompt = { id: cp.id, title: cp.title, role: cp.role, content: cp.content, preset: cp.preset || null };
            if (cp.preset) effectiveChat = Object.assign({}, chat, prompts.effectivePresetConfig(chat, cp.preset));
          }
        } catch { /* custom prompt stays null */ }
      }
      // The combined text mirrors the order handleChatStream uses:
      // profile system message first, then agent files, selected agent,
      // skills, then the custom prompt.
      const parts = [];
      if (profile && profile.systemMessage) parts.push(profile.systemMessage);
      let agentFilesList = null;
      let agentFilesEnabled = false;
      let agentFilesAvailable = [];
      let agentFileNames = [];
      try {
        agentFilesEnabled = agentFiles.resolveEnabled({ chat: effectiveChat, projectDir: dir });
        agentFileNames = agentFiles.resolveFileNames({ chat: effectiveChat, projectDir: dir });
        agentFilesAvailable = agentFiles.discover(dir, agentFileNames).map((f) => ({ name: f.name, size: f.size }));
        if (agentFilesEnabled) {
          agentFilesList = agentFiles.load(dir, agentFileNames);
          for (const af of agentFilesList) parts.push(af.content);
        }
      } catch { /* agent files stay null */ }
      // Agents are subagent delegation targets only — never part of
      // the chat's system prompt. Skills are project instruction files.
      // A prompt preset with `skills: true` rides on the chat for this
      // turn (see prompts.effectivePresetConfig), so the catalog
      // resolution reads `effectiveChat` — not the persisted record —
      // to mirror the live stream's behavior.
      const skillState = agentSkills.resolve({ chat: effectiveChat, projectDir: dir });
      const skillCatalog = agentSkills.catalogMessage(dir, effectiveChat);
      if (skillCatalog) parts.push(skillCatalog);
      if (prompt && prompt.content) parts.push(prompt.content);
      // Also expose the project-level gate so the UI can render the
      // per-chat toggle as locked off when the project has it disabled.
      let projectAgentFiles = null;
      try {
        const project = require('./settings.js').getProject(dir);
        if (project && typeof project.agentFiles === 'boolean') projectAgentFiles = project.agentFiles;
      } catch { /* null */ }
      return sendJSON(res, 200, {
        profile,
        agentFiles: agentFilesList ? agentFilesList.map(m => ({ name: m.name })) : null,
        agentFilesEnabled,
        agentFilesAvailable,
        agentFileNames,
        projectAgentFiles,
        // `disabled` is the project lock (rendered locked with a reason);
        // `chatDisabled` is this chat's own per-skill opt-out, which the
        // transcript row can turn back on without touching the project.
        skills: skillState.skills.map((s) => ({
id: s.id,
name: s.name,
description: s.description,
enabled: skillState.enabled && !skillState.disabled.has(s.id),
disabled: skillState.projectDisabled.has(s.id),
chatDisabled: skillState.chatDisabled.has(s.id)
})),
        projectSkills: skillState.projectEnabled,
        // The family flag as the STREAM resolves it, which is not always the
        // persisted `chat.skills`: a prompt preset with `skills: true` rides
        // on the chat for the turn (see prompts.effectivePresetConfig). The
        // transcript card must show what the model will actually get.
        skillsEnabled: skillState.enabled,
        prompt,
        text: parts.join('\n\n')
      });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/chats/:id/tool-preview?projectDir= -> { profile, tools }
  // Returns the tool-declaration state for the chat's resolved
  // prompt-size profile: which tools are advertised to the model and
  // in what shape (full spec vs. the very-small discover_tool flow).
  // The chat UI shows this as a temporary preview while
  // the chat is still empty, so the user sees the concrete effect of
  // the S/M/L switch on the tool budget before the first message.
  // The collection logic mirrors ai.streamChat (native shell + MCP),
  // then promptProfiles.reduceToolSpecs applies the same reduction the
  // stream will apply — so the preview is always what the model gets.
  const toolPreviewMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/tool-preview$/);
  if (toolPreviewMatch && method === 'GET') {
    const id = safeDecode(toolPreviewMatch[1]);
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      const chat = chats.getChat(dir, id);
      if (!chat) return sendJSON(res, 404, { error: 'chat not found' });
      // Resolve the profile id (chat -> project -> app -> 'average').
      let profileId = promptProfiles.DEFAULT_PROFILE;
      try {
        const p = promptProfiles.resolveProfile({ chat, projectDir: dir });
        if (p && p.id) profileId = p.id;
      } catch { /* fall through to default */ }
      // Collect the tool specs exactly as streamChat does: base shell,
      // progress, subagent, ask_user, and file tools are always
      // advertised, plus ready MCP servers.
      const shellEnabled = true;
      const fileToolsEnabled = true;
      const toolSpecs = [];
      if (shellEnabled) {
        try { toolSpecs.push(shellTool.SPEC); } catch { /* skip */ }
      }
      try { toolSpecs.push(require('./tools/progress.js').SPEC); } catch { /* skip */ }
      try { toolSpecs.push(require('./tools/subagent.js').SPEC); } catch { /* skip */ }
      try { toolSpecs.push(require('./tools/ask.js').SPEC); } catch { /* skip */ }
      try { toolSpecs.push(require('./agentFeatures.js').LIST_FEATURES_SPEC); } catch { /* skip */ }
      try { toolSpecs.push(require('./tools/webpreview.js').SPEC); } catch { /* skip */ }
try { toolSpecs.push(require('./tools/restart.js').SPEC); } catch { /* skip */ }
if (fileToolsEnabled) {

        try {
          const fileTools = require('./tools/files.js');
          for (const n of fileTools.FILE_TOOL_NAMES) toolSpecs.push(fileTools.SPECS[n]);
        } catch { /* skip */ }
      }
      try {
        const specs = mcp.listComposedToolSpecs(dir);
        if (specs && specs.length) {
          for (const s of specs) {
            toolSpecs.push({
              type: 'function',
              function: { name: s.name, description: s.description, parameters: s.parameters }
            });
          }
        }
      } catch { /* no MCP tools */ }
      try {
        const authz = require('./tools/authorization.js');
        const authState = authz.getAuthorization(dir, id);
        for (const family of ['shell', 'subagent', 'file', 'ask_user', 'report_progress', 'task', 'webpreview', 'restart_app']) {
        const cfg = authState.tools[family];
        if (cfg && cfg.mode === 'off') {
        const hidden = family === 'file' ? authz.FILE_FAMILY_TOOLS : new Set([family]);
        for (let i = toolSpecs.length - 1; i >= 0; i--) {
        const spec = toolSpecs[i];
        if (spec && spec.function && hidden.has(spec.function.name)) toolSpecs.splice(i, 1);
        }
        }
        }
        // Per-leaf file overrides (e.g. tools.read_file.mode = "off"
        // with the `file` family enabled) must drop just that operation,
        // matching what streamChat advertises to the model.
        for (let i = toolSpecs.length - 1; i >= 0; i--) {
        const spec = toolSpecs[i];
        if (!spec || !spec.function || !authz.FILE_FAMILY_TOOLS.has(spec.function.name)) continue;
        const cfg = authz.effectiveConfig(dir, spec.function.name, id);
        if (cfg && cfg.mode === 'off') toolSpecs.splice(i, 1);
        }
        for (let i = toolSpecs.length - 1; i >= 0; i--) {
        const spec = toolSpecs[i];
        if (!spec || !spec.function || !String(spec.function.name).startsWith('mcp__')) continue;
        const cfg = authz.effectiveConfig(dir, spec.function.name, id);
        if (cfg && cfg.mode === 'off') toolSpecs.splice(i, 1);
        }
      } catch { /* authorization state unreadable; keep every tool advertised */ }
      // Apply the same per-profile reduction the stream applies. For
      // very-small this is discover_tool plus one compact (name + description,
      // schema-less) entry per tool — a FIXED list, identical on every
      // tool-loop request, so the Anthropic cached prefix stays byte-stable.
      let effective = toolSpecs;
      try { effective = promptProfiles.reduceToolSpecs(toolSpecs, profileId); } catch { /* full specs */ }
      const reduced = profileId === 'very-small';
      const tools = (effective || []).map((s) => {
        const fn = (s && s.function) || {};
        const params = fn.parameters && fn.parameters.properties ? Object.keys(fn.parameters.properties) : [];
        return {
          name: fn.name || '',
          description: typeof fn.description === 'string' ? fn.description : '',
          // hasSchema reflects whether this advertised tool exposes
          // parameter names. For very-small only discover_tool's own
          // schema is present; the other entries are schema-less.
          hasSchema: params.length > 0,
          params
        };
      });
      return sendJSON(res, 200, {
        profile: profileId,
        reduced,
        shellEnabled,
        fileToolsEnabled,
        count: tools.length,
        tools
      });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats/:id/messages  body: { projectDir, role, content }
  // Append a message directly. The /messages/stream endpoint below
  // does the same internally for user / assistant messages; this
  // route is for manual edits and tests.
  if (getMsgsMatch && method === 'POST') {
    const id = safeDecode(getMsgsMatch[1]);
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const msg = messages.appendMessage(dir, id, { role: body.role, content: body.content, ts: body.ts });
      return sendJSON(res, 201, { message: msg });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/chats/:id/messages?projectDir= -> { ok, removed }
  if (getMsgsMatch && method === 'DELETE') {
    const id = safeDecode(getMsgsMatch[1]);
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const removed = messages.clearMessages(dir, id);
return sendJSON(res, 200, { ok: true, removed });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  const exportTraceMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/trace\/export$/);
  if (exportTraceMatch && method === 'POST') {
    const id = safeDecode(exportTraceMatch[1]);
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const file = trace.exportMessages(dir, id, messages.listMessages(dir, id));
      return sendJSON(res, 200, { ok: true, path: file });
    } catch (e) {
      return sendJSON(res, e.code === 'EBADINPUT' ? 400 : 500, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats/import  body: { projectDir, skipExisting?: bool }
  // Re-import chat metadata and messages from JSON files into the DB.
  if (urlPath === '/api/chats/import' && method === 'POST') {
    const body = await readJsonOr400(req, res);
    if (!body) return;
    const dir = readProjectDir(body);
    if (!dir) return sendJSON(res, 400, { error: 'projectDir is required' });
    try {
      const chatdb = require('./chatdb.js');
      const result = chatdb.importFromJson(dir, { skipExisting: !!body.skipExisting });
chats.recomputeProjectTotalCost(dir);
return sendJSON(res, 200, { ok: true, imported: result });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // GET /api/chats/:id/live?projectDir=  (SSE)
  // Per-chat live-replay stream. While a chat is running, a follower
  // client (another tab/device, or this UI returning to a running chat)
  // subscribes here and immediately receives the buffered transient tool
  // events (shell_output / subagent_event / progress_update) for the
  // in-flight run, then continues to receive them as they occur. The
  // stream closes with a `run_end` event when the run finishes. Requires
  // the chat to actually be running — a 404 prevents a client from
  // holding a dead connection waiting for content that will never come.
  const liveMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/live$/);
  if (liveMatch && method === 'GET') {
    const id = safeDecode(liveMatch[1]);
    const dir = qs(q, 'projectDir');
    if (!dir) return sendJSON(res, 400, { error: 'projectDir query param is required' });
    try {
      if (!chats.getChat(dir, id)) return sendJSON(res, 404, { error: 'Chat not found', id });
      const rk = runningKey(dir, id);
      if (!runningChats.has(rk)) return sendJSON(res, 404, { error: 'No live run for this chat', id });
      const fromLiveSeq = typeof q.fromLiveSeq === 'string' ? parseInt(q.fromLiveSeq, 10) : 0;
      return liveChat.addSubscriber(rk, req, res, { fromLiveSeq: isFinite(fromLiveSeq) && fromLiveSeq >= 0 ? fromLiveSeq : 0 });
    } catch (e) {
      const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
      return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
    }
  }

  // POST /api/chats/:id/messages/stream  body: { projectDir, modelId, content }
  // Appends the user message, calls ai.streamChat, streams the
  // response back as SSE, appends the assistant message on done, and
  // writes both events to the trace file (if the chat's trace flag
  // is on). One round-trip per user turn.
  const streamMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/messages\/stream$/);
if (streamMatch && method === 'POST') {
return handleChatStream(req, res, streamMatch[1], sessionToken, lifecycle);
}
return sendJSON(res, 404, { error: 'Not found', scope: 'chats' });
}
// Handles POST /api/chats/:id/messages/stream. Splits out for clarity;
// the route table above stays compact.
async function handleChatStream(req, res, chatId, sessionToken, lifecycle = {}) {
  const _pushSessionId = push.sessionIdFromToken(sessionToken);
  const body = await readJsonOr400(req, res);
  if (!body) return;
  const projectDir = body && typeof body.projectDir === 'string' ? body.projectDir : '';
  const modelId = body && typeof body.modelId === 'string' ? body.modelId : '';
  const providerId = body && typeof body.providerId === 'string' ? body.providerId : '';
  const content = body && typeof body.content === 'string' ? body.content : '';
  const attachments = messages.normalizeAttachments(body && body.attachments);
  const thinkingLevel = body && typeof body.thinkingLevel === 'string' ? body.thinkingLevel : '';
  const maxOutputTokens = body && typeof body.maxOutputTokens === 'string' ? body.maxOutputTokens : '';
  if (!projectDir) return sendJSON(res, 400, { error: 'projectDir is required' });
  if (!modelId) return sendJSON(res, 400, { error: 'modelId is required' });
  if (!content && !attachments.length) return sendJSON(res, 400, { error: 'content or image is required' });

  let chat;
  try { chat = chats.getChat(projectDir, chatId); }
  catch (e) {
    const status = e.code === 'MOUAIF_PROJECT_PARSE_ERROR' ? 422 : 500;
    return sendJSON(res, status, { error: e.message, code: e.code || 'INTERNAL' });
  }
  if (!chat) return sendJSON(res, 404, { error: 'Chat not found', id: chatId });

  // The chat's effective per-chat config. A custom prompt with a `preset`
  // (tools + agent-files) rides on the chat for THIS turn: it is merged
  // into the per-chat tool filter and agent-files toggle (see
  // prompts.effectivePresetConfig) without touching the persisted chat
  // record or the project's authorization gate. Falls back to `chat`
  // when the prompt has no preset.
  let effectiveChat = chat;
  try {
    if (chat.promptId) {
      const preset = prompts.getPromptPreset(projectDir, chat.promptId);
      if (preset) effectiveChat = Object.assign({}, chat, prompts.effectivePresetConfig(chat, preset));
    }
  } catch { /* preset best-effort; fall back to plain chat */ }

  // Reject a second concurrent stream on the same chat. Two in-flight
  // runs interleave appendMessage read-modify-writes and both append
  // assistant messages, corrupting transcript order.
  const runKey = runningKey(projectDir, chatId);
  if (runningChats.has(runKey)) {
    return sendJSON(res, 409, { error: 'A response is already streaming for this chat', code: 'EALREADY_RUNNING', id: chatId });
  }

  // Resolve the project model and hydrate it with its app-level provider
  // connection (credentials, base URL, and auth account).
  let model;
  try { model = resolveModel(modelId, projectDir, providerId); }
  catch (e) { return sendJSON(res, 400, { error: e.message, code: e.code, modelId, providerId: providerId || undefined }); }

  // Append the user message and bump lastOpenedAt BEFORE streaming.
  // If this is the first prompt in a new/default-named chat, also
  // derive a human title from that prompt and persist it immediately.
  let userMsg;
  try { userMsg = messages.appendMessage(projectDir, chatId, { role: 'user', content, attachments }); }
  catch (e) { return sendJSON(res, 400, { error: e.message }); }
  // Read the full transcript once and reuse across the title-derivation
  // check and the upstream message assembly below. Two separate
  // listMessages() calls would read SQLite or the JSON file twice
  // for identical data (the user message was already appended above).
  const history = messages.listMessages(projectDir, chatId);
  try {
    if (history.filter(m => m && m.role === 'user').length === 1 && content) {
      const renamed = chats.titleChatFromPrompt(projectDir, chatId, content);
      if (renamed) chat = renamed;
    }
  } catch { /* non-fatal */ }
  try { chats.touchChat(projectDir, chatId); } catch { /* non-fatal */ }

  // Mark the chat as running for the lifetime of the SSE response so a
  // reloaded client re-enters its busy state and a second stream is
  // rejected (above). Registered only after every failable setup step
  // (model resolution, message append) so an early 4xx cannot leak the
  // marker; cleared at every exit below (normal, error, and throw).
  const runController = new AbortController();
  runningChats.add(runKey);
  runningChatCancels.set(runKey, runController);
  liveChat.ensureLiveChat(runKey);

  // Open SSE.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(': connected\n\n');

  // Open the trace file. No-op writer if trace is off or the file
  // system is read-only.
  const traceStream = chat.trace ? trace.open(projectDir, chatId) : null;
  function emit(name, data) {
    try {
      res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
    } catch { /* socket closed */ }
    if (traceStream) trace.write(traceStream, name, data);
    // Fan transient tool streams out to followers (live-chat.js) so a
    // returning page or a second tab renders them in real time. These
    // are exactly the events that never reach the persisted transcript
    // on their own: buffered until the matching tool_result lands (or
    // the run ends), replayed to late subscribers, and pushed live to
    // connected ones. Conveniently, the run entry also gives us the
    // toolResultId for a later prune on `tool_result`.
    if (name === 'shell_output' || name === 'subagent_event' || name === 'progress_update'
      || name === 'authorization_required' || name === 'ask_user_required') {
      liveChat.pushLive(runKey, name, data);
    } else if (name === 'tool_result') {
      liveChat.pruneLive(runKey, data && data.id);
    }
  }
  if (traceStream) {
    const event = trace.eventForMessage(userMsg);
    trace.write(traceStream, event.type, event.payload);
  }

  // Build the message list to send upstream: existing transcript + the
  // user message we just appended. The list is composed in this order
  // (each block is optional, but the profile block is always present):
  //   1. Prompt-size profile system message (decisions §4 prompt-size
  //      profiles). Resolved from chat.promptSize -> resolved project
  //      settings.promptSize -> 'average'. The profile carries the
  //      model identity + the default guidance. A missing or unknown
  //      value falls through to the default; this code never throws.
  //   2. Agent files (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md),
  //      when enabled for this chat. Each file rides as its own system
  //      message so the model sees the file boundary.
  //   3. Custom prompt (chat.promptId), if the chat references a
  //      project prompt. The custom prompt refines the profile — the
  //      instructions on each prompt say "where they do not conflict
  //      with the active profile".
  //   4. The transcript (user + assistant turns), with the brand-new
  //      user turn already appended by the appendMessage call above.
  const upstreamMessages = [];
  // Resolve the prompt-size profile once. Its id drives BOTH the system
  // message (below) and the tool-declaration reduction passed to
  // streamChat (decisions §4: very-small trims tool schemas).
  let resolvedProfileId = promptProfiles.DEFAULT_PROFILE;
  try {
    const profile = promptProfiles.resolveProfile({ chat, projectDir });
    if (profile) {
      if (profile.id) resolvedProfileId = profile.id;
      if (profile.systemMessage) {
        upstreamMessages.push({ role: 'system', content: profile.systemMessage });
      }
    }
  } catch { /* non-fatal; stream proceeds without a profile system message */ }
  // Resolve the per-project tool output profile (size + structure). The
  // resolved settings are defaults → app → project, so an unset project
  // gets the built-in `{ size: 'average', structure: 'full' }`. This
  // drives how much of each tool result the model sees on BOTH the live
  // tool loop (streamChat) and the reconstructed history (below).
  let resolvedToolOutput = null;
  try {
    resolvedToolOutput = settings.getResolved(projectDir).toolOutput;
  } catch { /* non-fatal; fall back to the defaults in toolFeedback */ }
  // Agent files (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md).
  // Injected after the profile but before tagged files and the custom
  // prompt, so they sit close to the identity block. Each file rides
  // as its own system message. A trace line records what was injected.
  try {
    if (agentFiles.resolveEnabled({ chat: effectiveChat, projectDir })) {
      const names = agentFiles.resolveFileNames({ chat: effectiveChat, projectDir });
      const injected = agentFiles.load(projectDir, names);
      for (const m of injected) upstreamMessages.push({ role: m.role, content: m.content });
      if (traceStream && injected.length) {
        trace.write(traceStream, 'agent-files', {
          files: injected.map(m => m.name)
        });
      }
    }
  } catch { /* non-fatal; stream proceeds without agent files */ }
  // Agents are delegation targets for the `subagent` tool only — they
  // are never injected into the main chat stream (docs/features/agents.md).
  // A prompt preset with `skills: true` rides on the chat for this
  // turn (see prompts.effectivePresetConfig), so the skills catalog
  // resolves against `effectiveChat` — not the persisted record —
  // to match the agent-files / agentFeatures paths above.
  try {
    const catalog = agentSkills.catalogMessage(projectDir, effectiveChat);
    if (catalog) upstreamMessages.push({ role: 'system', content: catalog });
  } catch { /* non-fatal; stream proceeds without skills */ }

  // Agent features summary — a terse list of enabled features and their
  // authorization state in the current project. Tells the model what it
  // can do without the user having to guess or ask. The `list_features`
  // tool gives the full structured state.
  try {
    // Collect what we need for the feature summary.
    const project = require('./settings.js').getProject(projectDir);
    let authz = null;
    try { authz = require('./tools/authorization.js').getAuthorization(projectDir, effectiveChat && effectiveChat.id); } catch { /* safe default */ }
    let mcpServers = null;
    try { mcpServers = require('./mcp.js').listServers(projectDir); } catch { /* safe default */ }
    const featureMsg = agentFeatures.buildFeatureSummary({ chat: effectiveChat, projectDir, project, authz, mcpServers });
    if (featureMsg) {
      upstreamMessages.push({ role: 'system', content: featureMsg });
    }
  } catch { /* non-fatal; stream proceeds without feature summary */ }
  // Tagged files (decisions §15). Injected after the profile but before
  // the custom prompt and the transcript, so they are the deepest
  // context. includeInChat entries ride as `system`; any file the user
  // @-referenced in this turn's message is promoted to `user`. A trace
  // line records what was injected without re-reading disk on replay.
  try {
    const referencedPaths = tags.parseReferences(projectDir, content);
    const injected = tags.resolveForInjection(projectDir, { referencedPaths });
    if (injected.length) {
      for (const m of injected) upstreamMessages.push({ role: m.role, content: m.content });
      if (traceStream) {
        trace.write(traceStream, 'tags', {
          files: injected.map(m => ({ path: m.relPath, role: m.role }))
        });
      }
    }
  } catch { /* non-fatal; stream proceeds without tagged files */ }
  const effectivePromptId = chat.promptId || null;
  if (effectivePromptId) {
    try {
      const prompt = prompts.getPrompt(projectDir, effectivePromptId);
      if (prompt && prompt.content) {
        upstreamMessages.push({ role: prompt.role, content: prompt.content });
      }
    } catch { /* non-fatal; stream proceeds without the prompt */ }
  }
  function upstreamContentForMessage(m) {
    if (!m || m.role !== 'user' || !Array.isArray(m.attachments) || !m.attachments.length) return m && m.content;
    const parts = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (const a of m.attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    return parts;
  }

  // Reconstruct only complete historical tool call/result pairs. An aborted
  // run can leave a persisted call with no result; strict OpenAI-compatible
  // providers reject that orphan on the next send with HTTP 400. The helper
  // also canonicalizes provider-specific call ids for cross-model resumes.
  const supportsOpenAIToolHistory = model.provider === 'openai-compatible'
    || model.provider === 'openrouter'
    || model.provider === 'github-copilot'
    || model.provider === 'anthropic'; // converted to tool_use/tool_result by buildAnthropicRequest
  let toolFeedbackMaxBytes;
  try { toolFeedbackMaxBytes = settings.getApp().toolFeedbackMaxBytes; } catch { /* default applies */ }
  upstreamMessages.push(...messages.reconstructUpstreamHistory(history, upstreamContentForMessage, {
    includeTools: supportsOpenAIToolHistory,
    toolFeedbackMaxBytes,
    toolOutput: resolvedToolOutput
  }));

  let assistantContent = '';
  let assistantReasoning = '';
  let assistantMsg = null;
  // Track the streaming window so the cost line (which is computed
  // server-side from the upstream's authoritative usage block) also
  // carries the streamingMs the chat UI needs for its tok/s counter.
  // (The chat UI independently tracks its own counter for live
  // updates; the server-side number is the fallback when the client
  // missed frames — e.g. when the tab was backgrounded.)
  //
  // streamingMs accumulates ONLY the assistant-streaming windows, not
  // the tool-execution gaps between them. The multi-round tool loop
  // would otherwise stretch the window and under-report tok/s.
  let streamStartedAt = 0;   // set on first message/reasoning delta
  let streamingMs = 0;       // accumulated across streaming windows
  // Per-round usage snapshots from ai.js. Each tool round's upstream
  // call reports its own prompt/completion tokens. When a round ends
  // with tool calls, the pending snapshot is attached to the segment
  // persisted at `assistant_turn_end`, giving it a cost. When the
  // turn ends without tool calls, the snapshot is redundant — the
  // `done` handler computes the final cost from aggregated usage.
  let pendingRoundUsage = null;
  // Running token/cost totals across all upstream rounds in this turn,
  // used by the task progress push notification title ("12.4K tok · $0.0312").
  let turnTokens = 0;
  let turnCost = 0;
  let turnCostKnown = false;
  // Wall-clock start of this turn, for the status block's elapsed-time row.
  // Armed on the first streamed delta and cleared on turn end, so it measures
  // the model's work rather than the user's think time.
  let turnStartedAt = 0;
  // The most recent tool this turn ran, for the status block's activity row.
  // Reset each turn so it never leaks a tool name from the previous turn.
  let lastToolName = '';
  // Cost already persisted on intermediate segments (assistant_turn_end).
  // The final message must carry only the REMAINING cost so the chat
  // total (segment costs + final cost) equals the true per-round sum —
  // otherwise segment completion tokens are billed twice (once on the
  // segment, once inside the final aggregate).
let persistedSegmentCost = 0;
// Nested subagents are separate billed model calls. ai-stream reports their
// fully resolved total independently so it can be added without pretending
// their tokens used the parent model's price.
let delegatedCost = null;
function accumulateRoundUsage(roundUsage) {
    if (!roundUsage) return;
    turnTokens += (Number(roundUsage.promptTokens) || 0) + (Number(roundUsage.completionTokens) || 0);
    const segCost = computeSegmentCost(roundUsage);
    if (segCost && segCost.known) { turnCost += segCost.total; turnCostKnown = true; }
  }
  // The turn usage as the status block's usage row: token count plus price
  // when pricing is known ('12.4K tok · $0.0312'), or '' before any usage has
  // been reported. It rides the notification BODY — never the title, which the
  // OS shows in a fixed slot and clips first.
  function pushUsageLabel() {
    if (!turnTokens) return '';
    return usage.formatTokens(turnTokens) + ' tok' + (turnCostKnown ? ' · ' + usage.formatCost(turnCost) : '');
  }
  // Per-turn enrichment (cost + usage) is computed once on `done`
  // and reused for both the SSE emit and the persisted assistant
  // message. The chat UI's own live counter and the cost line
  // diverge slightly while the stream is in flight (the live counter
  // is per-delta; the cost line is final); that's intentional.
  let lastEnrichment = null;

  // Compute the cost for an intermediate segment from its round's
  // usage snapshot. Returns null when pricing is unavailable.
  function computeSegmentCost(roundUsage) {
    if (!roundUsage) return null;
    try {
      const app = settings.getApp();
      if (typeof roundUsage.providerCost === 'number' && isFinite(roundUsage.providerCost) && roundUsage.providerCost >= 0) {
        // OpenRouter reports a real input/output split under
        // cost_details; fall back to 0 when the round didn't carry it.
        const split = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
        return {
          known: true,
          input: split(roundUsage.providerCostInput),
          output: split(roundUsage.providerCostOutput),
          total: roundUsage.providerCost,
          currency: 'USD'
        };
      }
      const result = usage.computeCost({ model, usage: roundUsage, app });
      return { known: result.known, input: result.input, output: result.output, total: result.total, currency: result.currency };
    } catch { return null; }
  }

  // Built-in shell and file tools are always advertised. Their authorization
  // modes decide whether calls prompt, run automatically, or are disabled.
  const shellEnabled = true;
  const fileToolsEnabled = true;

  // App-level knobs (size caps etc.) are read once and passed through
  // to the file tool dispatcher. The dispatcher itself uses the
  // DEFAULT_* constants when these are missing, so passing the whole
  // app object is fine — only the file-tool keys are consulted.
  let appSettings = {};
  try { appSettings = settings.getApp() || {}; } catch { /* defaults apply */ }

  // Resolve the two-slot notification preferences (status, authorization)
  // plus quickActions. Current settings store the two-key shape directly;
  // older stores only had five booleans (progress/completion/errors and
  // askUser/toolAuthorization). Prefer the new keys when present, else
  // derive from the legacy keys. Mirrors normalizePreferences() in
  // frontend/src/components/SettingsNotifications.jsx.
  const notificationPrefs = resolveNotificationPrefs(appSettings.notifications);
  const chatUrl = `/#/chat/${chatId}?projectDir=${encodeURIComponent(projectDir)}`;
  // Exactly two notification channels exist per chat: one replaceable status
  // slot rendered with an ASCII bar, and one authorization/attention slot.
  const statusPushTag = 'chat-' + chatId + '-status';

  // statusBody(sub, percent, info) -> notification body for one device
  //
  // The whole status lives in the body, under the bar: the running message,
  // the position in the work, the turn usage, the elapsed time, the tool, and
  // the model. The notification TITLE stays the chat name — the OS shows it
  // in a fixed, narrow slot and clips it first, so the facts that used to ride
  // there are far more useful in the body, where a wider device simply shows
  // more of them (src/statusBar.js detailLines()).
  //
  // `info` is the fact object from report_progress / task, enriched with the
  // per-turn usage, start time, tool, and model; see statusInfo().
  function statusBody(sub, percent, info) {
    const plan = push.statusBar.planForSubscription(sub);
    return push.statusBar.composeStatusBody(plan, percent, info);
  }

  // statusInfo(data, extra) -> fact object for statusBody()
  //
  // Merges the stream event with this turn's context. Every field is
  // optional: a fact that is not known yet simply does not appear, so the
  // first update of a turn is just the bar and the message.
  function statusInfo(data, extra) {
    const o = extra || {};
    const modelName = model.label || model.id
      ? ((model.provider ? model.provider + '/' : '') + (model.id || model.label || ''))
      : '';
    return {
      title: data && data.title ? String(data.title) : '',
      message: data && data.message ? String(data.message) : '',
      kind: o.kind || (data && data.kind) || '',
      current: data && data.current != null ? data.current : undefined,
      total: data && data.total != null ? data.total : undefined,
      // The activity row's parts. A tool the stream named wins over the last
      // tool this turn ran. The elapsed time stands on its own (it is useful
      // without a tool), so it does not depend on one.
      tool: o.tool || lastToolName || '',
      model: modelName,
      time: turnStartedAt ? Math.max(1, Math.round((Date.now() - turnStartedAt) / 1000)) + 's' : '',
      // The title is the chat's own name for a task, which reads as the
      // notification title it already is; the running usage is the fact
      // worth a row here.
      usage: pushUsageLabel()
    };
  }

  function sendChatPush(kind, options = {}) {
    if (!_pushSessionId) return;
    const preferenceKey = kind === 'ask_user' || kind === 'tool_authorization'
      ? 'authorization'
      : kind === 'completion' || kind === 'error' || kind === 'progress'
        ? 'status'
        : '';
    if (preferenceKey && notificationPrefs[preferenceKey] === false) return;
    const data = Object.assign({ kind, chatId, projectDir, url: chatUrl }, options.data || {});
    push.sendPushToSession(_pushSessionId, {
      title: options.title || ((chat && chat.title) || 'mouaif'),
      body: options.body || '',
      bodyFor: options.bodyFor,
      chatId,
      projectDir,
      tag: options.tag || `chat-${chatId}-${kind}`,
      data,
      actions: options.actions,
      requireInteraction: options.requireInteraction === true
    });
  }

  function attentionActions(kind, data) {
    const actions = [];
    if (notificationPrefs.quickActions !== false) {
      if (kind === 'tool_authorization') {
        actions.push({ action: 'allow-once', title: 'Allow once' });
        actions.push({ action: 'deny', title: 'Deny' });
      } else if (kind === 'ask_user' && data && data.multiSelect !== true && Array.isArray(data.options) && data.options.length === 2) {
        for (let i = 0; i < data.options.length; i++) {
          const option = data.options[i] || {};
          if (option.label && option.value) actions.push({ action: 'answer-' + i, title: String(option.label).slice(0, 40) });
        }
      }
    }
    if (!actions.length) actions.push({ action: 'open', title: 'Open chat' });
    return actions;
  }

  // formatStreamError(err) — one-line, user-facing summary of a
  // failed turn. Persisted as a system message and shown as the
  // chat's error bubble, so keep it short: code + message + the
  // first line of any upstream detail (provider error bodies can
  // run to a full HTML page — useless in a chat bubble).
  function formatStreamError(err) {
    if (!err || typeof err !== 'object') return 'Request failed';
    const code = err.code ? err.code + ': ' : '';
    const msg = err.message || 'Request failed';
    let detail = '';
    if (typeof err.detail === 'string' && err.detail) {
      detail = ' — ' + err.detail.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 1).join(' ').slice(0, 300);
    }
    return '⚠ ' + code + msg + detail;
  }

  // persistStreamError(err) — write the failure into the transcript
  // as a system message so it survives a reload and lands in the
  // chat history (errors belong in the chat, not just in a transient
  // status line). Kept best-effort: a read-only transcript must not
  // mask the original error.
  function persistStreamError(err) {
    try {
      messages.appendMessage(projectDir, chatId, { role: 'system', content: formatStreamError(err) });
    } catch { /* non-fatal */ }
  }

  // Keep the server-side chat run alive even if the browser tab or SSE
  // connection disappears. All stream writes are best-effort and the
  // transcript remains authoritative, so a reloaded client can catch up by
  // polling persisted messages instead of causing an upstream abort with
  // "client disconnected".

  let result;
  try {
    result = await ai.streamChat({
    model,
    messages: upstreamMessages,
    projectDir,
    chatId, // Pass chatId for authorization gate
    shellEnabled,
    fileToolsEnabled,
    appSettings,
lifecycle,
promptSize: resolvedProfileId,

    toolOutput: resolvedToolOutput,
    thinkingLevel: thinkingLevel || chat.thinkingLevel || '',
    maxOutputTokens: maxOutputTokens || chat.maxOutputTokens || '',
    signal: runController.signal,
    // Per-chat tool filter (decisions: chat.tools). null/undefined
    // means "all tools available to the project"; an array (even an
    // empty one) means "restrict to exactly these tool names". The
    // legacy fields above stay so existing API clients keep working.
    // Chat tool filter wins; otherwise all project tools are offered.
    // `effectiveChat` folds in the prompt's preset tools (if any) the
    // same way it feeds agent-files above.
    enabledTools: Array.isArray(effectiveChat.tools) ? effectiveChat.tools : null,
    chat,
    // Per-round usage snapshot (one per upstream API call, including
    // tool rounds). Stashed so `assistant_turn_end` can attach cost
    // to the intermediate segment it persists.
    onRoundUsage: (roundUsage) => { pendingRoundUsage = roundUsage; accumulateRoundUsage(roundUsage); },
    onEvent: (name, data) => {
      if (name === 'message' && typeof data.delta === 'string') {
        if (!streamStartedAt) streamStartedAt = Date.now();
        if (!turnStartedAt) turnStartedAt = streamStartedAt;
        assistantContent += data.delta;
        try { res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { /* socket closed */ }
        return;
      } else if (name === 'reasoning' && typeof data.delta === 'string') {
        if (!streamStartedAt) streamStartedAt = Date.now();
        if (!turnStartedAt) turnStartedAt = streamStartedAt;
        assistantReasoning += data.delta;
        try { res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { /* socket closed */ }
        return;
      } else if (name === 'assistant_turn_end') {
        // A tool round is starting: fold the window that just ended into
        // the accumulator and clear the start marker. The next assistant
        // delta re-arms streamStartedAt.
        if (streamStartedAt) { streamingMs += Date.now() - streamStartedAt; streamStartedAt = 0; }
        // Persist text produced before a tool call at its real transcript
        // position, then start a fresh segment for the post-tool response.
        // Attach the round's usage/cost so this segment shows its own
        // cost line in the chat UI.
        // The same numbers ride the SSE event so the live bubble can
        // render the round's real cost without waiting for reconciliation.
        let segmentCost = null;
        let segmentUsage;
        if (assistantContent.trim() || assistantReasoning.trim()) {
          try {
            segmentCost = computeSegmentCost(pendingRoundUsage);
            if (segmentCost && segmentCost.known && typeof segmentCost.total === 'number') {
              persistedSegmentCost += segmentCost.total;
            }
            segmentUsage = pendingRoundUsage
              ? {
                  promptTokens: pendingRoundUsage.promptTokens,
                  completionTokens: pendingRoundUsage.completionTokens,
                  cacheReadTokens: pendingRoundUsage.cacheReadTokens || 0,
                  cacheCreationTokens: pendingRoundUsage.cacheCreationTokens || 0
                }
              : undefined;
            assistantMsg = messages.appendMessage(projectDir, chatId, {
              role: 'assistant', content: assistantContent, reasoning: assistantReasoning, modelId: model.id,
              usage: segmentUsage,
              cost: segmentCost || undefined
            });
            if (traceStream && assistantMsg) {
              const event = trace.eventForMessage(assistantMsg);
              trace.write(traceStream, event.type, event.payload);
            }
          } catch { /* non-fatal */ }
        }
        // The snapshot is consumed whether or not this segment had text.
        // Leaving it set on a no-text round would leak round N's tokens
        // into round N+1's segment (double-counted cost in the totals).
        pendingRoundUsage = null;
        assistantContent = '';
        assistantReasoning = '';
        // Emit the enriched frame (cost + usage attached) and skip the
        // generic emit below so the client never sees a cost-less copy.
        emit(name, Object.assign({}, data, {
          usage: segmentUsage,
          cost: segmentCost || undefined,
          modelId: model.id
        }));
        return;
      } else if (name === 'tool_call') {
        // Remember the tool for the status block's activity row: it names
        // what the model is doing, which is more useful in a progress
        // notification than a bare percentage.
        if (data && data.name) lastToolName = String(data.name);
        if (!turnStartedAt) turnStartedAt = Date.now();
        try {
          messages.appendMessage(projectDir, chatId, {
            role: 'tool', phase: 'call', toolCallId: data.id || '', name: data.name || '',
            args: data.args || {}, content: JSON.stringify(data.args || {})
          });
        } catch { /* non-fatal */ }
      } else if (name === 'tool_result') {
        try {
          messages.appendMessage(projectDir, chatId, {
            role: 'tool', phase: 'result', toolCallId: data.id || '', name: data.name || '',
            ok: !!data.ok, content: JSON.stringify(data.result || {})
          });
        } catch { /* non-fatal */ }
      } else if (name === 'authorization_required') {
        const notificationData = {
          callId: data && data.callId,
          tool: data && data.tool
        };
        sendChatPush('tool_authorization', {
          title: 'Authorization needed',
          body: (data && data.tool ? data.tool : 'A tool') + ' is waiting for approval.',
          tag: 'chat-' + chatId + '-attention',
          data: notificationData,
          actions: attentionActions('tool_authorization', data),
          requireInteraction: true
        });
      } else if (name === 'ask_user_required') {
        const quickOptions = data && data.multiSelect !== true && Array.isArray(data.options) && data.options.length === 2
          ? data.options.slice(0, 2).map((option) => ({ label: String(option.label || '').slice(0, 40), value: String(option.value || '').slice(0, 120) }))
          : [];
        const notificationData = {
          callId: data && data.callId,
          tool: 'ask_user',
          options: quickOptions
        };
        sendChatPush('ask_user', {
          title: 'The chat needs your answer',
          body: data && data.question ? String(data.question).slice(0, 240) : 'Open the chat to answer.',
          tag: 'chat-' + chatId + '-attention',
          data: notificationData,
          actions: attentionActions('ask_user', data),
          requireInteraction: true
        });
      } else if (name === 'progress_update') {
      // Updatable per-chat push notification for real-time progress.
      // Uses a stable tag so each new progress_update replaces the
      // previous OS notification for this chat (no notification spam).
      const pctNum = data.current != null && data.total != null
      ? Math.round((Number(data.current) / Math.max(1, Number(data.total))) * 100)
      : null;
      // Everything the status shows rides in the BODY, under the bar, as a
      // set of optional facts (src/statusBar.js detailLines()): the message,
      // the position in the work, the turn usage, the elapsed time, the
      // tool, and the model. The title stays just the chat name — it is the
      // slot the OS clips first, and a wider device shows more detail rows
      // without the title changing. A task update is one row of facts, not a
      // title row plus a separate task row.
      sendChatPush('progress', {
      title: (chat && chat.title) || 'mouaif',
      bodyFor: (sub) => statusBody(sub, pctNum, statusInfo(data)),
      tag: statusPushTag
      });
      } else if (name === 'done') {
      sendChatPush('completion', {
      title: (chat && chat.title) || 'mouaif',
      bodyFor: (sub) => statusBody(sub, 100, statusInfo({
        kind: 'complete',
        message: 'Response complete'
      })),
      tag: statusPushTag
      });
        // Compute the enrichment once. `cost.known` is true when at
        // least one of the four pricing layers (model, app, builtin)
        // had a non-empty entry for this model id. We always emit
        // the enriched event so the UI can render `--` cleanly; the
        // `known: false` flag tells it not to show a dollar sign.
        let enriched = data;
        delegatedCost = data && typeof data.delegatedCost === 'number' && isFinite(data.delegatedCost) && data.delegatedCost >= 0
          ? data.delegatedCost
          : null;
        try {
          const app = settings.getApp();
          const providerCost = data && typeof data.providerCost === 'number' && isFinite(data.providerCost) && data.providerCost >= 0
            ? data.providerCost
            : null;
          const cost = providerCost == null
            ? usage.computeCost({ model, usage: data && data.usage, app })
            : { known: true, input: 0, output: 0, total: providerCost, currency: 'USD' };
          // Fold the still-open window (first delta → done) into the
          // accumulated tool-round windows. Falls back to the full
          // elapsed time when no message delta ever armed the start.
          const finalStreamingMs = streamingMs + (streamStartedAt ? Date.now() - streamStartedAt : 0);
          enriched = Object.assign({}, data, {
            cost: {
              known: cost.known,
              input: cost.input,
              output: cost.output,
              total: cost.total,
              currency: cost.currency
            },
            streamingMs: finalStreamingMs,
            modelId: model.id
          });
        } catch { /* keep data as-is on any pricing resolution error */ }
        // Cost and usage on the final row are REMAINDER values, not the
        // turn aggregate:
        //   - Intermediate segments (assistant_turn_end) already carry
        //     their own round's usage + cost.
        //   - `turnCost` accumulated EVERY round's real cost — including
        //     tool rounds that produced no text and would otherwise
        //     vanish from the chat total.
        //   - Charging the full aggregate here would double-bill the
        //     segment completion tokens; charging only this round's
        //     snapshot would drop the no-text rounds entirely.
        // So: final cost = parent turnCost + delegatedCost − persistedSegmentCost,
        // and the usage block shows this round's own footprint (the aggregate
        // stays on the SSE event's usage block for the live "Context"
        // display). The SAME remainder rides the SSE `done` cost so the
        // in-flight chat total (segments + live final) matches the
        // persisted total exactly — no jump on reload.
        const finalRoundUsage = pendingRoundUsage;
        pendingRoundUsage = null;
        let remainderCost = enriched.cost;
        if (turnCostKnown && delegatedCost != null && enriched.cost && enriched.cost.known) {
          const remaining = Math.max(0, turnCost + delegatedCost - persistedSegmentCost);
          remainderCost = {
            known: true,
            input: 0,
            output: 0,
            total: remaining,
            currency: (enriched.cost && enriched.cost.currency) || 'USD'
          };
          enriched = Object.assign({}, enriched, { cost: remainderCost });
        }
        lastEnrichment = enriched;
        // Persist the assistant message so a chat that is later
        // reopened renders the same numbers (decision §14 — the usage
        // block rides the message).
        if (assistantContent.trim() || assistantReasoning.trim()) {
          try {
            const persistUsage = finalRoundUsage
              ? {
                  promptTokens: finalRoundUsage.promptTokens,
                  completionTokens: finalRoundUsage.completionTokens,
                  cacheReadTokens: finalRoundUsage.cacheReadTokens || 0,
                  cacheCreationTokens: finalRoundUsage.cacheCreationTokens || 0
                }
              : (data && data.usage);
            assistantMsg = messages.appendMessage(projectDir, chatId, {
              role: 'assistant',
              content: assistantContent,
              reasoning: assistantReasoning,
              usage: persistUsage,
              cost: remainderCost,
              streamingMs: enriched.streamingMs,
              modelId: enriched.modelId
            });
          } catch { /* non-fatal */ }
        }
        if (traceStream && assistantMsg) {
          const event = trace.eventForMessage(assistantMsg);
          trace.write(traceStream, event.type, event.payload);
        }
        emit('done', enriched);
        return;
      }
      emit(name, data);
    }
  });
  } catch (streamErr) {
    // A throw out of the streaming layer must still clear the running
    // marker or the chat would look busy forever after a reload.
    runningChats.delete(runKey);
    runningChatCancels.delete(runKey);
    // The turn is over (either way), so its status facts stop applying.
    lastToolName = '';
    turnStartedAt = 0;
    if (traceStream) trace.close(traceStream);
    const errPayload = { code: 'EINTERNAL', message: streamErr && streamErr.message ? streamErr.message : 'stream failed' };
    persistStreamError(errPayload);
    try { emit('error', errPayload); } catch { /* socket closed */ }
    liveChat.finishLiveChat(runKey);
    sendChatPush('error', {
      title: (chat && chat.title) || 'mouaif',
      // An error is a fact set too: the message, then whatever usage and
      // context the turn had reached before it failed.
      bodyFor: (sub) => statusBody(sub, null, statusInfo({ kind: 'error', message: 'Error: ' + (errPayload.message || 'stream failed') })),
      tag: statusPushTag
    });
    res.end();
    return;
  }

  if (!result.ok) {
    // Always surface the failure — even when the stream produced
    // partial content before dying. The old guard
    // (`!assistantContent && !assistantReasoning`) silently dropped
    // mid-turn failures: the client saw the socket close with no
    // `done` and no `error`, leaving the chat stuck on "streaming…"
    // with zero explanation. Persist any partial output first, then
    // the error itself, so the transcript shows exactly what the
    // model produced before the failure.
    const errPayload = Object.assign({ code: result.error.code || 'EUPSTREAM' }, result.error);
    if (assistantContent.trim() || assistantReasoning.trim()) {
      try {
        messages.appendMessage(projectDir, chatId, {
          role: 'assistant',
          content: assistantContent,
          reasoning: assistantReasoning,
          modelId: model.id
        });
      } catch { /* non-fatal */ }
    }
    persistStreamError(errPayload);
    emit('error', errPayload);
    sendChatPush('error', {
      title: (chat && chat.title) || 'mouaif',
      bodyFor: (sub) => statusBody(sub, null, statusInfo({ kind: 'error', message: 'Error: ' + (errPayload.message || 'upstream error') })),
      tag: statusPushTag
    });
  }
  if (traceStream) trace.close(traceStream);
  runningChats.delete(runKey);
  runningChatCancels.delete(runKey);
  // The turn is over, so its status facts stop applying to the next one.
  lastToolName = '';
  turnStartedAt = 0;
  liveChat.finishLiveChat(runKey);
  res.end();
}

module.exports = { handleChats, handleChatStream };
