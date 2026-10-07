'use strict';

// Native app tools: one ordinary function/schema/permission per operation.
// The internal area router shares the existing app-store business logic.
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
//   - SPECS declares separate native tools with operation-specific
//     parameters. No action enum or custom selection/permission resolver.
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
//   SPECS                      : separate OpenAI-compatible function specs
//   TOOL_NAMES                 : ordinary native tool names
//   runAppTool(name, args, opts)-> Promise<{ ok, content, result }>

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
// Settings keys that grant or reshape tool permissions / auth state. A
// write to any of them always needs a user decision (see ai-stream.js),
// so a model holding `update_settings: allow` cannot widen its own reach.
const PERMISSION_KEYS = Object.freeze(['tools', 'mcp', 'authAccounts', 'authPending']);

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
  model_search: 'chats',
  start: 'chats',
  attach: 'attachments',
  list_attachments: 'attachments',
  working_folder: 'chats',
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

// Internal business-area groups retained for runner tests and diagnostics.
// Public native tools and visual catalog sources are defined separately.
const GROUPS = Object.freeze([
  Object.freeze({
    id: 'mouaif',
    name: 'Chats',
    description: 'list \u00b7 read \u00b7 create \u00b7 rename \u00b7 delete \u00b7 search \u00b7 attach images',
    areas: Object.freeze(['chats', 'attachments']),
    actions: Object.freeze(
      ACTION_NAMES.filter((name) => ['chats', 'attachments'].includes(ACTIONS[name]))
    )
  }),
  Object.freeze({
    id: 'mouaif-settings',
    name: 'mouaif',
    description: 'app & project settings \u00b7 projects \u00b7 feature info',
    areas: Object.freeze(['settings', 'projects', 'info']),
    actions: Object.freeze(
      ACTION_NAMES.filter((name) => ['settings', 'projects', 'info'].includes(ACTIONS[name]))
    )
  })
]);

// Shared field definitions for the business runners; never advertised as a tool.
const PARAMETERS = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTION_NAMES,
          description: 'Which mouaif action to run. list/get/create/update/delete/search act on chats; attach/list_attachments act on a chat\u2019s images; settings_get/settings_update read or write settings; project_list lists projects; info reports the feature state.'
        },
        chatId: {
          type: 'string',
          description: 'Target chat id.'
        },
        title: { type: 'string', description: 'Chat title (max 200 chars).' },
        topic: {
          type: 'string',
          description: 'Opening draft text for the new chat (max 400 chars).'
        },
        limit: {
          type: 'number',
          description: 'list/search: maximum chats to return (default 20, max 100). list_attachments: number of recent messages to scan (default 200, max 200).'
        },
        beforeSeq: {
          type: 'integer',
          minimum: 0,
          description: 'Scan messages before this sequence number. Pass nextBeforeSeq from the previous page; omit for the newest page.'
        },
        query: { type: 'string', description: 'Text to match against chat titles, drafts, and messages.' },
        offset: { type: 'integer', minimum: 0, description: 'Model search: skip this many matches (default 0); use nextOffset for the next page.' },
        includeLive: { type: 'boolean', description: 'Model search: include configured providers’ live catalogs (default true). False searches only saved project models.' },
        providerId: { type: 'string', description: 'Provider connection id for the chat\u2019s model (e.g. "openai-compatible").' },
        modelId: { type: 'string', description: 'create/update: project or live-catalog model id. A project model can infer its provider; a live model needs providerId. update: "" clears the model choice.' },
        promptId: { type: 'string', description: 'Custom prompt id to attach to the chat ("" clears it).' },
        promptSize: {
          type: 'string',
          enum: ['very-small', 'average', 'extensive', 'chat'],
          description: 'Prompt-size profile for the chat.'
        },
        draft: { type: 'string', description: 'Replace the chat\u2019s composer draft text.' },
        includeMessages: {
          type: 'boolean',
          description: 'Also return the most recent messages (default false).'
        },
        messageLimit: { type: 'number', description: 'Number of recent messages to return (default 10, max 50).' },
        path: {
          type: 'string',
          description: 'Image path relative to the calling chat’s working folder (the project by default; e.g. "docs/features/images/shot.png").'
        },
        directory: { type: 'string', description: 'Required. An existing directory, relative to the original project or absolute, or "" (or ".") to return to the original project folder. Folders are never created: this tool selects a directory that already exists.' },
        target: {
        type: 'string',
          enum: ['draft', 'message'],
          description: '"draft" adds the image to the composer draft (default), "message" appends an image-bearing user message. Neither starts an AI turn.'
        },
        content: { type: 'string', description: 'Text of the user message when target is "message" (optional).' },
        scope: {
          type: 'string',
          enum: ['app', 'project'],
          description: 'Settings store: "app" or "project". Reads default to app; writes default to project.'
        },
        keys: { type: 'array', items: { type: 'string' }, description: 'Only return these setting keys.' },
        patch: { type: 'object', description: 'Setting keys to merge into the chosen scope.' },
        unset: { type: 'array', items: { type: 'string' }, description: 'Keys to remove from project settings (project scope only).' },
        confirm: { type: 'boolean', description: 'Must be true to actually delete the chat.' }
      },
      required: ['action'],
      additionalProperties: false
};

const { DEFINITIONS, TOOL_NAMES } = require('./appToolNames.js');
const SPECS = Object.freeze(Object.fromEntries(TOOL_NAMES.map((name) => {
  const definition = DEFINITIONS[name];
  const properties = Object.fromEntries(definition.keys.map((key) => [key, PARAMETERS.properties[key]]));
  if (properties.limit) properties.limit = { type: 'integer', minimum: 1,
    maximum: name === 'list_chat_attachments' ? 200 : 100,
    description: name === 'list_chat_attachments' ? 'Number of messages to scan (default 200, max 200).' : 'Maximum chats to return (default 20, max 100).' };
  if (properties.chatId) properties.chatId = { type: 'string', description: 'Chat id' + (definition.required?.includes('chatId') ? ' (required).' : ' (defaults to the current chat).') };
  if (name === 'search_models') {
    properties.query = { type: 'string', description: 'Case-insensitive text to match model ids and labels. Omit to list models.' };
    properties.limit = { ...properties.limit, description: 'Maximum models to return (default 20, max 100).' };
    properties.providerId = { type: 'string', description: 'Restrict results to this provider connection id; omit to search all configured providers.' };
  }
  if (name === 'start_chat') properties.content = { type: 'string', description: 'Prompt to send to the selected chat (required, max 200000 chars). Starts an AI turn, not a draft.' };
  return [name, { type: 'function', function: { name, description: definition.description,
    parameters: { type: 'object', properties, required: definition.required || [], additionalProperties: false }
  } }];
})));

async function runAppTool(name, args, opts) {
  if (!Object.prototype.hasOwnProperty.call(SPECS, name)) return fail('EUNKNOWN_TOOL', 'Unknown app tool: ' + name);
  const spec = SPECS[name];
  try { validateArgs(args, spec.function.parameters); }
  catch (e) { return fail(e.code || 'EBADINPUT', e.message); }
  return runMouaif({ ...args, action: DEFINITIONS[name].action }, opts);
}

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
    workingDir: chat.workingDir || null,
    promptSize: chat.promptSize || null,
    promptId: chat.promptId || null,
    trace: chat.trace === true
  };
  const draft = chat.draft || chat.draftSnippet;
  if (draft) out.draftSnippet = String(draft).replace(/\s+/g, ' ').slice(0, 200);
  if (chat.matchField) out.matchField = chat.matchField;
  if (chat.snippet) out.snippet = String(chat.snippet).slice(0, 240);
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

// Resolve the chat `change_working_folder` acts on. An explicit `chatId`
// argument is honoured (the same rule `get_chat` and `attach_chat_image`
// follow), and otherwise the calling chat is used. A delegated run has no
// chat record of its own, so it passes its own chat id explicitly: the run id
// is process state, and the caller that knows it is the run itself.
function resolveWorkingFolderChatId(args, opts) {
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

// Use the REST model resolver for both persisted models and live catalog
// selections. Return identity only: hydrated credentials must never reach
// a tool response or a stored chat record.
function modelSelection(projectDir, providerId, modelId) {
  try {
    const model = require('../server-shared.js').resolveModel(modelId, projectDir, providerId);
    return { providerId: model.provider, modelId: model.id };
  } catch (e) {
    throw typedError('EBADINPUT', e.message || String(e));
  }
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

  if (action === 'model_search') {
    const query = trimString(args.query, 500).toLowerCase();
    const providerId = trimString(args.providerId, 128);
    const { ai } = require('../server-shared.js');
    if (providerId && !ai.ENDPOINTS[providerId]) throw typedError('EBADINPUT', 'unknown provider: ' + providerId);
    const saved = settings.getResolved(projectDir).models || [];
    const connections = settings.getApp().providers || [];
    const providers = connections.filter((p) => p && ai.ENDPOINTS[p.id] && (!providerId || p.id === providerId)).map((p) => p.id);
    const live = args.includeLive === false ? { list: [], failures: [] }
      : await require('../modelList.js').liveModelsForMany([...new Set(providers)]);
    const rows = new Map();
    // Project choices win duplicate identities; only public identity fields
    // are returned, never hydrated provider connections or credentials.
    for (const [source, models] of [['project', saved], ['live', live.list]]) {
      for (const m of models) {
        if (!m || !m.id || !m.provider || (providerId && m.provider !== providerId)) continue;
        const key = JSON.stringify([m.provider, m.id]);
        if (rows.has(key)) continue;
        rows.set(key, { providerId: m.provider, modelId: m.id, label: m.label || m.name || m.id, source });
      }
    }
    const matches = [...rows.values()].filter((m) => !query || [m.modelId, m.label].some((text) => String(text).toLowerCase().includes(query)))
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
    const offset = args.offset || 0;
    const limit = clampLimit(args.limit, 20, 100);
    const models = matches.slice(offset, offset + limit);
    return ok({ ok: true, query, total: matches.length, returned: models.length, models,
      nextOffset: offset + models.length < matches.length ? offset + models.length : null,
      failures: live.failures });
  }

  if (action === 'start') {
    const chatId = trimString(args.chatId, 128);
    if (!chatId) throw typedError('EBADINPUT', 'chatId is required for action "start"');
    const chat = requireChat(projectDir, chatId);
    if (!args.content || !args.content.trim() || args.content.length > MAX_DRAFT_CHARS) {
      throw typedError('EBADINPUT', 'content must be non-empty and at most ' + MAX_DRAFT_CHARS + ' chars');
    }
    if (!chat.modelId) throw typedError('EBADINPUT', 'select a model with update_chat before starting this chat');
    const started = await require('../server-handlers-chats.js').startChatTurn({ projectDir, chatId,
      modelId: chat.modelId, providerId: chat.providerId || '', content: args.content }, opts && opts.lifecycle);
    if (!started.ok) return fail(started.code || 'EMOUAIF', started.error || 'Could not start chat');
    return ok({ ok: true, started: true, projectDir, chat: chatSummary(chats.getChat(projectDir, chatId)),
      url: '#/chat/' + encodeURIComponent(chatId) });
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

  if (action === 'working_folder') {
    const chatId = resolveWorkingFolderChatId(args, opts);
    // A delegated run is not a chat record: its folder is process state for
    // the live run, so it switches there instead of writing chat metadata.
    if (opts && opts.workspaceChatId) {
    const run = require('../chatWorkingFolder.js').changeRun(projectDir, opts.workspaceChatId, args.directory, opts.signal, opts.workingFolderDestination);
      return ok({ ok: true, projectDir, ...run, updated: [], chat: null });
    }
    requireChat(projectDir, chatId);
    const { chat, ...workspace } = require('../chatWorkingFolder.js').change(projectDir, chatId, args.directory, opts && opts.signal, opts && opts.workingFolderDestination);
    return ok({ ok: true, projectDir, ...workspace, updated: ['workingDir'], chat: chatSummary(chat) });
  }

  if (action === 'create') {
    const title = trimString(args.title, MAX_TITLE_CHARS);
    const topic = trimString(args.topic, MAX_TOPIC_CHARS);
    const providerId = trimString(args.providerId, 128);
    const modelId = trimString(args.modelId, 256);
    // Validate before creating: a rejected selection must not leave a
    // blank chat behind. Persist the inferred provider for project models.
    if (providerId && !modelId) throw typedError('EBADINPUT', 'providerId needs a modelId for action "create"');
    const patch = modelId ? modelSelection(projectDir, providerId, modelId) : {};
    if (topic) patch.draft = topic;
    let chat = chats.createChat(projectDir, { title: title || undefined });
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
    if (typeof args.promptId === 'string') {
    patch.promptId = trimString(args.promptId, 128) || null;
    if (patch.promptId && !require('../prompts.js').getPrompt(projectDir, patch.promptId)) {
      throw typedError('EBADINPUT', 'unknown promptId: ' + patch.promptId);
    }
    }
    if (typeof args.modelId === 'string' || typeof args.providerId === 'string') {
    const modelId = typeof args.modelId === 'string' ? trimString(args.modelId, 256) : current.modelId;
    const providerId = typeof args.providerId === 'string' ? trimString(args.providerId, 128)
    : (modelId && modelId === current.modelId ? current.providerId || '' : '');
    if (!modelId) {
      if (providerId) throw typedError('EBADINPUT', 'providerId needs a modelId');
      patch.modelId = null;
      patch.providerId = null;
    } else {
      Object.assign(patch, modelSelection(projectDir, providerId, modelId));
    }
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
    // The running turn keeps appending tool rows to its own chat; deleting
    // it mid-turn leaves orphan messages behind a chat that no longer exists.
    if (opts && typeof opts.chatId === 'string' && opts.chatId.trim() === chatId) {
      throw typedError('EBADINPUT', 'cannot delete the chat this turn is running in — delete it from the chat list');
    }
    chats.deleteChat(projectDir, chatId);
    // Same cleanup as DELETE /api/chats/:id.
    try { require('./task.js').clearChat(chatId); } catch { /* non-fatal */ }
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
    const { imageMetadata, draftImageRef, listGeneratedImages } = require('../chatImages.js');
    const limit = clampLimit(args.limit, 200, 200);
    // Read one extra row to distinguish a complete inventory from a page
    // with older messages. The seq cursor remains stable across appends.
    const rows = messages.listMessagesWindow(projectDir, chatId, { limit: limit + 1, beforeSeq: args.beforeSeq }) || [];
    const page = rows.length > limit ? rows.slice(1) : rows;
    const nextBeforeSeq = rows.length > limit ? page[0].seq : null;
    const attached = [];
    const generated = [];
    for (const m of page) {
    // Images a subagent returned live on its tool-result row. Listing
    // them lets the parent pass earlier artwork back for an edit.
    for (const g of listGeneratedImages(m)) generated.push({ messageTs: m.ts, messageSeq: m.seq, ...g });
    if (!m || !Array.isArray(m.attachments) || !m.attachments.length) continue;
      for (const [index, a] of m.attachments.entries()) {
      attached.push({ messageTs: m.ts, messageSeq: m.seq,
      ...imageMetadata(a, 'message:' + m.seq + ':' + index) });
      }
    }
    return ok({
      ok: true,
      chatId,
      drafts: (Array.isArray(chat.draftAttachments) ? chat.draftAttachments : [])
        .map((a) => imageMetadata(a, draftImageRef(a))),
      messages: attached,
      generated,
      nextBeforeSeq
    });
  }

  const relPath = trimString(args.path, 4096);
  if (!relPath) throw typedError('EBADINPUT', 'path is required for action "attach"');
  const workingDir = require('../chatWorkingFolder.js').resolveForCall(projectDir, (opts && opts.chatId) || chatId, opts && opts.workspaceChatId);
  const loaded = await loadImageAttachment(workingDir, relPath);
  // Loading bytes yields to concurrent calls and composer saves. Re-read
  // after that await; keep validation, merge, and write synchronous.
  const latest = requireChat(projectDir, chatId);

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

  const existing = Array.isArray(latest.draftAttachments) ? latest.draftAttachments : [];
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
function forClient(value, scope = 'app') {
  // Required lazily: server-shared pulls in the whole HTTP handler graph and
  // this module is loaded from the stream loop on every request.
  const shared = require('../server-shared.js');
  return scope === 'project' ? shared.projectForClient(value) : shared.settingsForClient(value);
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

// sanitizeClientEntries re-attaches the stored apiKey to a round-tripped
// entry. If the entry now points at a different baseUrl, that would send
// the stored credential to a host the user never entered it for — so the
// key is dropped and must be re-entered in Settings → Providers.
function dropKeyOnRedirect(entries, existing) {
  if (!Array.isArray(entries)) return;
  const prior = Array.isArray(existing) ? existing : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.apiKey !== 'string') continue;
    const prev = prior.find((x) => x && x.id === entry.id);
    if (!prev || prev.apiKey !== entry.apiKey) continue;
    const before = typeof prev.baseUrl === 'string' ? prev.baseUrl.trim() : '';
    const after = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
    if (before !== after) delete entry.apiKey;
  }
}

// permissionKeysTouched(args) -> string[]  PERMISSION_KEYS that an
// update_settings call would write or remove.
function permissionKeysTouched(args) {
  if (!args || typeof args !== 'object') return [];
  const keys = new Set();
  if (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
    for (const key of Object.keys(args.patch)) keys.add(key);
  }
  if (Array.isArray(args.unset)) {
    for (const key of args.unset) if (typeof key === 'string') keys.add(key.trim());
  }
  return PERMISSION_KEYS.filter((key) => keys.has(key));
}

function runSettings(args, opts) {
  const projectDir = resolveProjectDir(opts);
  const action = args.action;

  if (action === 'settings_get') {
    const scope = trimString(args.scope, 16) || 'app';
    if (scope === 'project') {
      const value = selectKeys(forClient(settings.getProject(projectDir), 'project'), args.keys);
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
  const patch = args.patch ? { ...args.patch } : null;
  const unset = Array.isArray(args.unset) ? args.unset.map((k) => trimString(k, 128)).filter(Boolean) : [];
  if ((!patch || !Object.keys(patch).length) && !unset.length) {
    throw typedError('EBADINPUT', 'settings_update needs a non-empty patch object (and/or an unset list for project scope)');
  }
  // Refuse credential writes at both supported locations before touching
  // either store. Redacted provider/model snapshots remain round-trippable.
  if (patch && (Object.prototype.hasOwnProperty.call(patch, 'apiKey')
    || ['providers', 'models'].some((key) => Array.isArray(patch[key])
      && patch[key].some((entry) => entry && Object.prototype.hasOwnProperty.call(entry, 'apiKey'))))) {
    throw typedError('EBADINPUT', 'apiKey is not writable through this tool — connect the provider in Settings \u2192 Providers');
  }
  const shared = require('../server-shared.js');
  if (scope === 'app') {
    if (unset.length) throw typedError('EBADINPUT', 'unset is only supported for project scope');
    if (!patch) throw typedError('EBADINPUT', 'app scope needs a patch object');
    // Only keys the client can read back are writable: anything else would
    // be stored where neither the UI nor get_settings can show or undo it.
    const hidden = Object.keys(patch).filter((key) => !shared.CLIENT_SETTINGS_KEYS.includes(key));
    if (hidden.length) {
      throw typedError('EBADINPUT', 'not a writable app setting: ' + hidden.join(', ') +
        ' — writable keys: ' + shared.CLIENT_SETTINGS_KEYS.join(', '));
    }
  }
  if (patch) {
    const current = scope === 'app' ? settings.getApp() : settings.getProject(projectDir);
    for (const key of ['providers', 'models']) {
      shared.sanitizeClientEntries(patch, key, current[key]);
      dropKeyOnRedirect(patch[key], current[key]);
    }
  }
  if (scope === 'app') {
    const merged = settings.setApp(patch);
    return ok({ ok: true, scope: 'app', updated: Object.keys(patch), settings: forClient(merged) });
  }
  if (patch) settings.setProject(projectDir, patch);
  if (unset.length) settings.unsetProjectKeys(projectDir, unset);
  return ok({
    ok: true,
    scope: 'project',
    projectDir,
    updated: patch ? Object.keys(patch) : [],
    removed: unset,
    settings: forClient(settings.getProject(projectDir), 'project')
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
  const result = Object.assign({ ok: true, tool: 'get_app_info',
    nativeTools: TOOL_NAMES.map((name) => ({ name, description: DEFINITIONS[name].description })) }, state.result || {});
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

// Providers do not all enforce JSON schemas. Validate the published shape
// here too, before any action can mutate app state.
function validateArgs(args, parameters = PARAMETERS) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw typedError('EBADINPUT', 'arguments must be an object');
  }
  const properties = parameters.properties;
  for (const key of parameters.required || []) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) throw typedError('EBADINPUT', key + ' is required');
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) throw typedError('EBADINPUT', 'unknown argument: ' + key);
    const schema = properties[key];
    // A `type` may be a list (e.g. ['string','boolean','null']), the JSON
    // Schema union the `directory` argument uses.
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = (type) => type === 'array' ? Array.isArray(value) && value.every((item) => typeof item === schema.items.type)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isSafeInteger(value)
    : type === 'null' ? value === null
    : typeof value === type && (type !== 'number' || Number.isFinite(value));
    const valid = types.some(matches);
    if (!valid) throw typedError('EBADINPUT', key + ' must be of type ' + types.join(' or '));
    if (schema.minimum !== undefined && value < schema.minimum) throw typedError('EBADINPUT', key + ' must be at least ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) throw typedError('EBADINPUT', key + ' must be at most ' + schema.maximum);
    if (schema.enum && !schema.enum.includes(value)) throw typedError('EBADINPUT', 'unknown ' + key + ': ' + value);
  }
}

async function runMouaif(args, opts) {
  try { validateArgs(args); }
  catch (e) { return fail(e.code || 'EBADINPUT', e.message); }
  const action = args.action;
  if (!action) return fail('EBADINPUT', 'action is required');
  const area = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!area) {
    return fail('EBADINPUT', 'unknown action "' + action + '" — one of: ' + ACTION_NAMES.join(', '));
  }
  const handler = HANDLERS[area];
  if (!handler) return fail('EUNKNOWN_TOOL', 'no handler for area ' + area);
  try {
    resolveProjectDir(opts);
    return await handler(args, opts);
  } catch (e) {
    const code = (e && e.code) || 'EMOUAIF';
    const result = { ok: false, code, message: (e && e.message) || String(e) };
    if (e && e.path) result.path = e.path;
    return { ok: false, content: JSON.stringify(result), result };
  }
}

module.exports = {
  ACTIONS,
  AREAS,
  GROUPS,
  ACTION_NAMES,
  SPECS,
  TOOL_NAMES,
  PERMISSION_KEYS,
  permissionKeysTouched,
  runAppTool,
  runMouaif
};
