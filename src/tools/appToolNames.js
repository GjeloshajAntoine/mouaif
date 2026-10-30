'use strict';

// Ordinary native functions. Metadata is shared by registration, schemas,
// prompt allowlists and the one-time migration of the retired action tool.
const DEFINITIONS = Object.freeze({
  list_chats: { action: 'list', source: 'chats', description: 'List this project’s chats, newest first, with bounded draft previews.', keys: ['limit'] },
  get_chat: { action: 'get', source: 'chats', description: 'Read a chat and optionally its recent messages. Defaults to the current chat.', keys: ['chatId', 'includeMessages', 'messageLimit'] },
  create_chat: { action: 'create', source: 'chats', description: 'Create a chat with an optional title, opening draft, and model selection. Use search_models to find providerId/modelId. Does not start an AI turn; use start_chat for that.', keys: ['title', 'draft', 'providerId', 'modelId'] },
  update_chat: { action: 'update', source: 'chats', description: 'Update a chat’s title, draft, model, custom prompt, or prompt-size profile. Use search_models to find providerId/modelId; a model change applies to the next turn.', keys: ['chatId', 'title', 'draft', 'providerId', 'modelId', 'subagentProviderId', 'subagentModelId', 'promptId', 'promptSize'], required: ['chatId'] },
  change_working_folder: { action: 'working_folder', source: 'chats', description: 'Change the folder a chat’s shell and file tools work in. The folder must already exist: this tool never creates one, never runs Git and never prepares a checkout. To work in a new workspace or worktree, create it under .mouaif/workspaces/<name> with an authorized shell command first (never outside the project unless asked), then select it. Chat storage, permissions and project configuration stay in the original project.', keys: ['chatId', 'directory'], required: ['directory'] },
  search_models: { action: 'model_search', source: 'chats', description: 'Search project models and configured providers’ live chat catalogs. Returns providerId/modelId pairs for create_chat or update_chat, with bounded pagination and per-provider failures.', keys: ['query', 'providerId', 'limit', 'offset', 'includeLive'] },
  start_chat: { action: 'start', source: 'chats', description: 'Send content to an existing chat and start an AI response in the background using its selected model. Use create_chat first for a new chat. Returns at once, before the response exists; read it later with get_chat (includeMessages: true).', keys: ['chatId', 'content'], required: ['chatId', 'content'] },
  delete_chat: { action: 'delete', source: 'chats', description: 'Delete a chat and its transcript; this cannot be undone. Without confirm: true the call deletes nothing and returns an ECONFIRM error naming the chat, so you can check it is the right one.', keys: ['chatId', 'confirm'], required: ['chatId'] },
  search_chats: { action: 'search', source: 'chats', description: 'Search this project’s chat titles, drafts, and message text.', keys: ['query', 'limit'], required: ['query'] },
  attach_chat_image: { action: 'attach', source: 'chats', description: 'Attach an image from the calling chat’s working folder to a chat draft or append an image-bearing user message. Does not start an AI turn.', keys: ['chatId', 'path', 'target', 'content'], required: ['path'] },
  list_chat_attachments: { action: 'list_attachments', source: 'chats', description: 'List draft, message, and subagent-generated image metadata and imageRef values without pixels. Pass selected imageRef values to subagent.images. Follow nextBeforeSeq with beforeSeq for older messages.', keys: ['chatId', 'limit', 'beforeSeq'] },
  create_mcp_app: { action: 'app_create', source: 'mouaif', description: 'Show an interactive single-file MCP App (HTML or browser JavaScript) in the current chat, or talk to one already shown. Use one mode per call: `source` + `filename` creates a new app file and shows it; `path` + `source` rewrites an existing app file and reloads it; `path` alone shows an existing app file; `message` sends text to the app mounted in this chat; `request` only prepares an unsent development chat draft. Requires the user\u2019s approval. The app gets no installs, network, Node execution or permission changes, and no project MCP server is registered. The in-page API is described under `source`.', keys: ['name', 'path', 'filename', 'source', 'message', 'request'] },
  get_settings: { action: 'settings_get', source: 'mouaif', description: 'Read redacted app or project settings, optionally restricted to specific keys. Credentials are never returned.', keys: ['scope', 'keys'], required: ['scope'] },
  update_settings: { action: 'settings_update', source: 'mouaif', description: 'Update app or project settings: merge a patch into the chosen scope, and for project scope optionally remove keys. Project settings override app settings. Credentials are not writable.', keys: ['scope', 'patch', 'unset'], required: ['scope'] },
  list_projects: { action: 'project_list', source: 'mouaif', description: 'List registered projects with their names, paths, and costs.', keys: [] }
});
const TOOL_NAMES = Object.freeze(Object.keys(DEFINITIONS));
// Schemas that exist only so a retired shape still validates and migrates.
// They are never advertised, never listed in TOOL_NAMES (so selection,
// families and the action->name migration map stay legacy-free) and never
// reachable through runAppTool. `change_working_folder` used to take a
// `chatId` argument; the tool now owns its chat, and this row keeps
// `migrateAppTools` rewriting the old `mouaif:working_folder` permission row
// onto the live definition. The live `change_working_folder` accepts `chatId`
// again, but the legacy row stays: dropping it would change the migration map
// and stop `mouaif:working_folder` permission rows from being rewritten.
//
// `get_app_info` was list_features plus a list of these tool names, and was
// folded into list_features. Its row keeps the 2026-10-01 migration mapping
// `mouaif:info` as it did; the 2026-10-30 migration then renames the stored
// `get_app_info` rows to list_features.
const LEGACY_DEFINITIONS = Object.freeze({
  change_working_folder: { action: 'working_folder', source: 'chats', description: 'Legacy schema for change_working_folder.', keys: ['chatId', 'directory'] },
  get_app_info: { action: 'info', source: 'mouaif', description: 'Legacy schema for get_app_info, now list_features.', keys: [] }
});
module.exports = { DEFINITIONS, TOOL_NAMES, LEGACY_DEFINITIONS };
