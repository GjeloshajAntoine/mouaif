'use strict';

// Native `mouaif` tool — one model-facing tool that manages the app itself.
//
// It is the model's handle on mouaif's own data model, so the assistant can
// do what the user would otherwise tab through the UI for:
//
//   chats      — list / get / create / update (title, model, prompt,
//                thinking level, draft text) / delete / attach / search
//   attachments— put an image file from the project into a chat, either in
//                the composer draft (ready to send) or on a real user message
//   settings   — read and write app-level settings and the project's
//                `.mouaif.json`
//   projects   — list the registered projects
//   info       — describe the tool surface (the old `list_features` report)
//
// Implements docs/features/mouaif-tool.md.
//
// Design notes:
//   - ONE tool, not nine. Every chat / settings tool would otherwise cost a
//     spec in every request; the enumerations (`chats`, `attachments`, …)
//     ride in the argument schema of a single spec instead, which the
//     `very-small` prompt profile compacts away entirely.
//   - The dispatcher (`runMouaif`) is a thin router; every area lives in its
//     own `run*` function and returns the shared `{ ok, content, result }`
//     envelope. Errors are typed (`EBADINPUT`, `ENOTFOUND`, `ECONFIRM`, …)
//     so the model can read the code and self-correct.
//   - Everything calls the same internal modules the REST handlers call
//     (`chats.js`, `messages.js`, `settings.js`, `files.js`, `projects.js`),
//     so the tool can never drift from the UI's semantics — including the
//     project-dir safety check (`projects.ensureSafeRoot`) and the
//     `apiKey`-free settings responses.
//   - Destructive actions (`action: "delete"` on a chat) need
//     `confirm: true`. The tool is not a security boundary for the app
//     store; it is a convenience surface behind the same authorization gate
//     every other native tool uses.
//
// Public surface:
//   SPEC                       : the OpenAI-compatible function spec
//   ACTIONS                    : the action -> area table (for tests + docs)
//   runMouaif(args, opts)      -> Promise<{ ok, content, result }>

const path = require('path');

const settings = require('../settings.js');
const projects = require('../projects.js');
const chats = require('../chats.js');
const messages = require('../messages.js');

const MAX_TITLE_CHARS = 200;
const MAX_TOPIC_CHARS = 400;
const MAX_DRAFT_CHARS = 200_000;
const MAX_ATTACHMENTS = 8;
// readMedia caps the bytes on disk; the chat store caps the base64 data URL
// (12 MB of characters). 6 MB of pixels stays under both once encoded.
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MESSAGE_PREVIEW_CHARS = 400;

// ---- Area table ----------------------------------------------------------
// The action -> area map is data, not control flow: the schema enum below is
// generated from it, the dispatcher routes through it, and `info` reports it.
const ACTIONS = Object.freeze({
  list: 'chats',
  get: 'chats',
  create: 'chats',
  update: 'chats',
  delete: 'chats',
  search: 'chats',
  attach: 'attachments',
  list_attachments: 'attachments',
  settings_get: 'settings',
  settings_update: 'settings',
  project_list: 'projects',
  info: 'info'
});

const AREAS = Object.freeze({
  chats: 'List, read, create, update, delete, and search this project\u2019s chats.',
  attachments: 'Attach an image file from the project to a chat draft or to a user message.',
  settings: 'Read and write app-level settings and the project\u2019s .mouaif.json.',
  projects: 'List the projects registered in the app.',
  info: 'Describe the mouaif feature state and this tool\u2019s actions.'
});

const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

const SPEC = {
  type: 'function',
  function: {
    name: 'mouaif',
    description: 'Manage mouaif itself: this project\u2019s chats (list, read, create, rename, set model, delete, search, attach an image), app and project settings (read/update), and the registered project list. Use `action: "info"` to see the mouaif feature state. Destructive chat deletion requires `confirm: true`.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTION_NAMES,
          description: 'Which mouaif action to run. list/get/create/update/delete/search act on chats; attach/list_attachments act on a chat\u2019s images; settings_get/settings_update read or write settings; project_list lists projects; info reports the feature state.'
        },
        chatId: {
          type: 'string',
          description: 'Target chat id. Required by get/update/delete/attach/list_attachments. Defaults to the current chat for attach/list_attachments and is ignored by the rest.'
        },
        title: { type: 'string', description: 'create/update: chat title (max 200 chars).' },
        topic: {
          type: 'string',
          description: 'create only: an opening line for the new chat\u2019s draft text, so the chat is not blank when the user opens it (max 400 chars).'
        },
        limit: {
          type: 'number',
          description: 'list/search: maximum chats to return (default 20, max 100).'
        },
        query: { type: 'string', description: 'search: text to match against chat titles, drafts, and messages.' },
        providerId: { type: 'string', description: 'create/update: provider connection id for the chat\u2019s model (e.g. "openai-compatible").' },
        modelId: { type: 'string', description: 'create/update: model id from the project\u2019s model list to give the chat.' },
        promptId: { type: 'string', description: 'update: id of a custom prompt to attach to the chat ("" clears it).' },
        promptSize: {
          type: 'string',
          enum: ['very-small', 'average', 'extensive', 'chat'],
          description: 'update: prompt-size profile for the chat.'
        },
        draft: { type: 'string', description: 'update: replace the chat\u2019s composer draft text.' },
        includeMessages: {
          type: 'boolean',
          description: 'get: also return the most recent messages (default false).'
        },
        messageLimit: { type: 'number', description: 'get: how many recent messages to return (default 10, max 50).' },
        path: {
          type: 'string',
          description: 'attach: project-relative path of the image file to attach (e.g. "docs/features/images/shot.png").'
        },
        target: {
          type: 'string',
          enum: ['draft', 'message'],
          description: 'attach: "draft" adds the image to the composer draft (default, user presses send), "message" appends a real user message that carries the image.'
        },
        content: { type: 'string', description: 'attach with target "message": the text of the user message (optional).' },
        scope: {
          type: 'string',
          enum: ['app', 'project'],
          description: 'settings_get/settings_update: which settings store to read or write. Defaults to "project" for settings_update and "app" for settings_get.'
        },
        keys: { type: 'array', items: { type: 'string' }, description: 'settings_get: only return these keys.' },
        patch: { type: 'object', description: 'settings_update: the settings keys to merge into the chosen scope.' },
        unset: { type: 'array', items: { type: 'string' }, description: 'settings_update (project scope): keys to remove from the project settings file.' },
        confirm: { type: 'boolean', description: 'delete: must be true to actually delete the chat.' }
      },
      required: ['action'],
      additionalProperties: false
    }
  }
};

// ---- Small helpers -------------------------------------------------------

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function trimString(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return s.length <= max ? s : s.slice(0, max);
}

// Resolve the project dir the call runs against. The HTTP layer derives it
// from `?projectDir=`; a model call uses the chat's own project. The result
// always goes through the same safety check the REST handlers use, so a
// forged projectDir cannot reach outside the user's home.
function resolveProjectDir(opts) {
  const raw = (opts && typeof opts.projectDir === 'string') ? opts.projectDir.trim() : '';
  if (!raw) throw typedError('EBADINPUT', 'no project directory: call this tool from a project');
  if (!path.isAbsolute(raw)) throw typedError('EBADINPUT', 'projectDir must be an absolute path');
  return projects.ensureSafeRoot(raw);
}

function clampLimit(value, fallback, max) {
  const n = Number.isFinite(value) ? Math.round(value) : fallback;
  if (n <= 0) return fallback;
  return Math.min(max, n);
}

function ok(result, content) {
  return {
    ok: true,
    content: content !== undefined ? content : JSON.stringify(result, null, 2),
    result
  };
}

function fail(code, message, extra) {
  const result = { ok: false, code, message };
  if (extra && typeof extra === 'object') Object.assign(result, extra);
  return { ok: false, content: JSON.stringify(result), result };
}

// A short, model-facing view of a chat. The stored record carries a pinned
// prompt snapshot and the whole draft; neither belongs in a list result.
function chatSummary(chat) {
  if (!chat) return null;
  const out = {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    lastOpenedAt: chat.lastOpenedAt || null,
    providerId: chat.providerId || null,
    modelId: chat.modelId || null,
    promptSize: chat.promptSize || null,
    promptId: chat.promptId || null,
    trace: chat.trace === true
  };
  if (chat.draft) out.draftSnippet = String(chat.draft).replace(/\s+/g, ' ').slice(0, 200);
  // List rows are summaries: they carry `draftSnippet` / `hasDraftImage`
  // instead of the full draft and its attachment array.
  if (chat.hasDraftImage === true) out.draftAttachments = 1;
  if (Array.isArray(chat.draftAttachments) && chat.draftAttachments.length) {
    out.draftAttachments = chat.draftAttachments.length;
  }
  return out;
}

// Resolve a chat id argument, falling back to the running chat. Used by the
// attachment actions, where "this chat" is the obvious default.
function resolveChatId(args, opts) {
  const explicit = trimString(args && args.chatId, 128);
  if (explicit) return explicit;
  const current = opts && typeof opts.chatId === 'string' ? opts.chatId.trim() : '';
  if (current) return current;
  throw typedError('EBADINPUT', 'chatId is required (no current chat to default to)');
}

function requireChat(projectDir, chatId) {
  const chat = chats.getChat(projectDir, chatId);
  if (!chat) throw typedError('ENOTFOUND', 'chat not found: ' + chatId);
  return chat;
}

// Models are per project (docs/decisions.md §3) and a live catalog entry is
// valid without being persisted, so "the model exists" means "the project
// lists it, or a provider connection can serve it".
function assertModel(projectDir, providerId, modelId) {
  const resolved = settings.getResolved(projectDir);
  const list = Array.isArray(resolved.models) ? resolved.models : [];
  const inProject = list.some((m) => m && m.id === modelId && (!providerId || m.provider === providerId));
  if (inProject) return;
  const app = settings.getApp();
  const connections = new Set((Array.isArray(app.providers) ? app.providers : []).map((p) => p && p.id));
  if (providerId && connections.has(providerId)) return;
  throw typedError('EBADINPUT',
    'unknown model "' + modelId + '"' + (providerId ? ' for provider "' + providerId + '"' : '') +
    ' — the project has no such model and no provider connection serves it. Add it in Settings \u2192 Project \u2192 Models.');
}

// ---- chats area ----------------------------------------------------------

async function runChats(args, opts) {
  const projectDir = resolveProjectDir(opts);
  const action = args.action;

  if (action === 'list') {
    const limit = clampLimit(args.limit, 20, 100);
    const list = chats.listChats(projectDir, { limit, offset: 0 });
    return ok({
      ok: true,
      projectDir,
      total: chats.countChats(projectDir),
      returned: list.length,
      chats: list.map(chatSummary)
    });
  }

  if (action === 'search') {
    const query = trimString(args.query, 500);
    if (!query) throw typedError('EBADINPUT', 'query is required for action "search"');
    const limit = clampLimit(args.limit, 20, 100);
    const list = chats.searchChats(projectDir, query, { limit });
    return ok({
      ok: true,
      projectDir,
      query,
      returned: Array.isArray(list) ? list.length : 0,
      chats: (Array.isArray(list) ? list : []).map(chatSummary)
    });
  }

  if (action === 'get') {
    const chatId = trimString(args.chatId, 128) || (opts && opts.chatId);
    if (!chatId) throw typedError('EBADINPUT', 'chatId is required for action "get"');
    const chat = requireChat(projectDir, chatId);
    const detail = chatSummary(chat);
    detail.promptSnapshot = chat.promptSnapshot ? {
      id: chat.promptSnapshot.id || null,
      title: chat.promptSnapshot.title || null
    } : null;
    detail.draft = chat.draft || '';
    detail.draftAttachments = Array.isArray(chat.draftAttachments) ? chat.draftAttachments.length : 0;
    detail.totalCost = chat.totalCost || null;
    let out = ok({ ok: true, chat: detail });
    if (args.includeMessages) {
      const limit = clampLimit(args.messageLimit, 10, 50);
      const rows = messages.listMessagesWindow(projectDir, chatId, { limit });
      detail.messages = (rows || []).map((m) => ({
        role: m.role,
        ts: m.ts,
        name: m.name || undefined,
        phase: m.phase || undefined,
        content: typeof m.content === 'string' ? m.content.slice(0, MESSAGE_PREVIEW_CHARS) : ''
      }));
      out = ok({ ok: true, chat: detail });
    }
    return out;
  }

  if (action === 'create') {
    const title = trimString(args.title, MAX_TITLE_CHARS);
    const topic = trimString(args.topic, MAX_TOPIC_CHARS);
    let chat = chats.createChat(projectDir, { title: title || undefined });
    const providerId = trimString(args.providerId, 128);
    const modelId = trimString(args.modelId, 256);
    // Both the opening line and the model land on the record with the same
    // updateChat the UI uses (createChat only seeds title/profile defaults).
    const patch = {};
    if (topic) patch.draft = topic;
    if (modelId) {
    assertModel(projectDir, providerId, modelId);
    patch.modelId = modelId;
    if (providerId) patch.providerId = providerId;
    }
    if (Object.keys(patch).length) chat = chats.updateChat(projectDir, chat.id, patch) || chat;
    return ok({
      ok: true,
      projectDir,
      chat: chatSummary(chat),
      url: '#/chat/' + encodeURIComponent(chat.id)
    });
  }

  if (action === 'update') {
    const chatId = trimString(args.chatId, 128);
    if (!chatId) throw typedError('EBADINPUT', 'chatId is required for action "update"');
    const current = requireChat(projectDir, chatId);
    const patch = {};
    if (typeof args.title === 'string') patch.title = trimString(args.title, MAX_TITLE_CHARS) || 'New chat';
    if (typeof args.draft === 'string') patch.draft = args.draft.slice(0, MAX_DRAFT_CHARS);
    if (typeof args.promptSize === 'string') {
      if (!require('../promptProfiles.js').isValidProfile(args.promptSize)) {
        throw typedError('EBADINPUT', 'unknown promptSize: ' + args.promptSize);
      }
      patch.promptSize = args.promptSize;
    }
    if (typeof args.promptId === 'string') patch.promptId = trimString(args.promptId, 128) || null;
    if (typeof args.providerId === 'string' && !Object.prototype.hasOwnProperty.call(patch, 'providerId')) {
      patch.providerId = trimString(args.providerId, 128) || null;
    }
    if (typeof args.modelId === 'string') {
      const providerId = trimString(args.providerId, 128) || current.providerId || '';
      assertModel(projectDir, providerId, trimString(args.modelId, 256));
      patch.modelId = trimString(args.modelId, 256) || null;
      if (providerId) patch.providerId = providerId;
    }
    if (!Object.keys(patch).length) {
      throw typedError('EBADINPUT', 'nothing to update: pass title, draft, promptId, promptSize, providerId, or modelId');
    }
    const updated = chats.updateChat(projectDir, chatId, patch);
    if (!updated) throw typedError('ENOTFOUND', 'chat not found: ' + chatId);
    return ok({ ok: true, updated: Object.keys(patch), chat: chatSummary(updated) });
  }

  if (action === 'delete') {
    const chatId = trimString(args.chatId, 128);
    if (!chatId) throw typedError('EBADINPUT', 'chatId is required for action "delete"');
    const chat = requireChat(projectDir, chatId);
    if (args.confirm !== true) {
      return fail('ECONFIRM',
        'deleting a chat destroys its transcript and cannot be undone — call again with confirm: true to delete "' + chat.title + '"',
        { chatId, title: chat.title, messageCount: messages.getMessageCount(projectDir, chatId) });
    }
    chats.deleteChat(projectDir, chatId);
    return ok({ ok: true, deleted: chatId, title: chat.title });
  }

  throw typedError('EBADINPUT', 'unknown chat action: ' + action);
}

// ---- attachments area ----------------------------------------------------

async function loadImageAttachment(projectDir, relPath) {
  const files = require('../files.js');
  const media = await files.readMedia(projectDir, relPath, { maxBytes: MAX_IMAGE_BYTES });
  const attachment = {
    type: 'image',
    mimeType: media.mime,
    dataUrl: media.dataUrl,
    name: path.basename(relPath)
  };
  // The chat store validates attachments with the same rules the composer
  // uses. Normalizing here means an oversized image is reported as a tool
  // error instead of being silently dropped by the merge write.
  const normalized = messages.normalizeAttachments([attachment]);
  if (!normalized.length) {
    throw typedError('ETOOLARGE',
      'image rejected by the chat attachment rules (max ' + MAX_ATTACHMENTS +
      ' images, ' + Math.round(MAX_IMAGE_BYTES / (1024 * 1024)) + ' MB each): ' + relPath);
  }
  return { attachment: normalized[0], bytes: media.size, relPath: media.relPath, mime: media.mime };
}

async function runAttachments(args, opts) {
  const projectDir = resolveProjectDir(opts);
  const chatId = resolveChatId(args, opts);
  const chat = requireChat(projectDir, chatId);
  const action = args.action;

  if (action === 'list_attachments') {
    const rows = messages.listMessagesWindow(projectDir, chatId, { limit: 200 }) || [];
    const attached = [];
    for (const m of rows) {
      if (!m || !Array.isArray(m.attachments) || !m.attachments.length) continue;
      for (const a of m.attachments) {
        attached.push({ messageTs: m.ts, name: a && a.name, mimeType: a && a.mimeType });
      }
    }
    return ok({
      ok: true,
      chatId,
      drafts: (Array.isArray(chat.draftAttachments) ? chat.draftAttachments : [])
        .map((a) => ({ name: a && a.name, mimeType: a && a.mimeType })),
      messages: attached
    });
  }

  const relPath = trimString(args.path, 4096);
  if (!relPath) throw typedError('EBADINPUT', 'path is required for action "attach"');
  const loaded = await loadImageAttachment(projectDir, relPath);

  if (args.target === 'message') {
    const content = typeof args.content === 'string' ? args.content.slice(0, MAX_DRAFT_CHARS) : '';
    const message = messages.appendMessage(projectDir, chatId, {
      role: 'user',
      content,
      attachments: [loaded.attachment],
      clientId: messages.newClientId('u')
    });
    return ok({
      ok: true,
      chatId,
      target: 'message',
      attached: { name: loaded.attachment.name, mimeType: loaded.mime, bytes: loaded.bytes, relPath: loaded.relPath },
      messageTs: message && message.ts
    });
  }

  const existing = Array.isArray(chat.draftAttachments) ? chat.draftAttachments : [];
  if (existing.length >= MAX_ATTACHMENTS) {
    throw typedError('ETOOLARGE', 'the chat draft already holds ' + MAX_ATTACHMENTS + ' images');
  }
  const next = messages.normalizeAttachments(existing.concat([loaded.attachment]));
  if (next.length === existing.length) {
    throw typedError('ETOOLARGE', 'the image did not fit the chat draft attachment rules');
  }
  const updated = chats.updateChat(projectDir, chatId, { draftAttachments: next });
  return ok({
    ok: true,
    chatId,
    target: 'draft',
    attached: { name: loaded.attachment.name, mimeType: loaded.mime, bytes: loaded.bytes, relPath: loaded.relPath },
    draftAttachments: next.length,
    message: 'The image is in the composer draft. The user sends it; the tool does not start a turn.'
  });
}

// ---- settings area -------------------------------------------------------

// Settings responses go through the same projections the HTTP layer uses, so
// an app-level `apiKey` never reaches the model transcript: `providers` are
// mapped to `connectionForClient` and `models` to `modelForClient`.
function forClient(value) {
  // Required lazily: server-shared pulls in the whole HTTP handler graph and
  // this module is loaded from the stream loop on every request.
  const shared = require('../server-shared.js');
  return shared.settingsForClient(value);
}

function selectKeys(value, keys) {
  if (!Array.isArray(keys) || !keys.length) return value;
  const out = {};
  for (const key of keys) {
    const name = trimString(key, 128);
    if (!name) continue;
    if (Object.prototype.hasOwnProperty.call(value, name)) out[name] = value[name];
  }
  return out;
}

function runSettings(args, opts) {
  const projectDir = resolveProjectDir(opts);
  const action = args.action;

  if (action === 'settings_get') {
    const scope = trimString(args.scope, 16) || 'app';
    if (scope === 'project') {
      const value = selectKeys(settings.getProject(projectDir), args.keys);
      return ok({ ok: true, scope: 'project', projectDir, settings: value });
    }
    if (scope !== 'app') throw typedError('EBADINPUT', 'scope must be "app" or "project"');
    const value = selectKeys(forClient(settings.getApp()), args.keys);
    return ok({ ok: true, scope: 'app', settings: value });
  }

  const scope = trimString(args.scope, 16) || 'project';
  if (scope !== 'app' && scope !== 'project') {
    throw typedError('EBADINPUT', 'scope must be "app" or "project"');
  }
  const patch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
  const unset = Array.isArray(args.unset) ? args.unset.map((k) => trimString(k, 128)).filter(Boolean) : [];
  if (!patch && !unset.length) {
    throw typedError('EBADINPUT', 'settings_update needs a patch object (and/or an unset list for project scope)');
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
    throw typedError('EBADINPUT', 'apiKey is not writable through this tool — connect the provider in Settings \u2192 Providers');
  }
  if (scope === 'app') {
    if (unset.length) throw typedError('EBADINPUT', 'unset is only supported for project scope');
    if (!patch) throw typedError('EBADINPUT', 'app scope needs a patch object');
    const merged = settings.setApp(patch);
    return ok({ ok: true, scope: 'app', updated: Object.keys(patch), settings: forClient(merged) });
  }
  if (unset.length) settings.unsetProjectKeys(projectDir, unset);
  if (patch) settings.setProject(projectDir, patch);
  return ok({
    ok: true,
    scope: 'project',
    projectDir,
    updated: patch ? Object.keys(patch) : [],
    removed: unset,
    settings: settings.getProject(projectDir)
  });
}

// ---- projects area -------------------------------------------------------

function runProjects(args, opts) {
  resolveProjectDir(opts);
  const list = projects.listProjects();
  return ok({
    ok: true,
    returned: list.length,
    projects: list.map((p) => ({
      id: p.id,
      name: p.name || null,
      path: p.path,
      totalCost: p.totalCost || null
    }))
  });
}

// ---- info area -----------------------------------------------------------

async function runInfo(args, opts) {
  const projectDir = resolveProjectDir(opts);
  const agentFeatures = require('../agentFeatures.js');
  const chat = (opts && opts.chat) || ((opts && opts.chatId) ? chats.getChat(projectDir, opts.chatId) : undefined);
  const state = await agentFeatures.dispatchListFeatures({}, Object.assign({}, opts, { chat, projectDir }));
  const actions = ACTION_NAMES.map((name) => ({
    action: name,
    area: ACTIONS[name],
    description: AREAS[ACTIONS[name]]
  }));
  const result = Object.assign({ ok: true, tool: 'mouaif', actions }, state.result || {});
  return ok(result);
}

// ---- Dispatcher ----------------------------------------------------------

const HANDLERS = {
  chats: runChats,
  attachments: runAttachments,
  settings: (args, opts) => runSettings(args, opts),
  projects: runProjects,
  info: runInfo
};

async function runMouaif(args, opts) {
  const action = trimString(args && args.action, 64);
  if (!action) return fail('EBADINPUT', 'action is required');
  const area = ACTIONS[action];
  if (!area) {
    return fail('EBADINPUT', 'unknown action "' + action + '" — one of: ' + ACTION_NAMES.join(', '));
  }
  const handler = HANDLERS[area];
  if (!handler) return fail('EUNKNOWN_TOOL', 'no handler for area ' + area);
  try {
    return await handler(args, opts);
  } catch (e) {
    const code = (e && e.code) || 'EMOUAIF';
    const result = { ok: false, code, message: (e && e.message) || String(e) };
    if (e && e.path) result.path = e.path;
    return { ok: false, content: JSON.stringify(result), result };
  }
}

module.exports = {
  SPEC,
  ACTIONS,
  AREAS,
  ACTION_NAMES,
  runMouaif
};
