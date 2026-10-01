'use strict';

// Ordinary native functions. Metadata is shared by registration, schemas,
// prompt allowlists and the one-time migration of the retired action tool.
const DEFINITIONS = Object.freeze({
  list_chats: { action: 'list', source: 'chats', description: 'List this project’s chats, newest first, with bounded draft previews.', keys: ['limit'] },
  get_chat: { action: 'get', source: 'chats', description: 'Read a chat and optionally its recent messages. Defaults to the current chat.', keys: ['chatId', 'includeMessages', 'messageLimit'] },
  create_chat: { action: 'create', source: 'chats', description: 'Create a chat with an optional title, opening draft, and model selection.', keys: ['title', 'topic', 'providerId', 'modelId'] },
  update_chat: { action: 'update', source: 'chats', description: 'Update a chat’s title, draft, model, custom prompt, or prompt-size profile.', keys: ['chatId', 'title', 'draft', 'providerId', 'modelId', 'promptId', 'promptSize'], required: ['chatId'] },
  delete_chat: { action: 'delete', source: 'chats', description: 'Delete a chat and its transcript. Requires confirm: true.', keys: ['chatId', 'confirm'], required: ['chatId'] },
  search_chats: { action: 'search', source: 'chats', description: 'Search this project’s chat titles, drafts, and message text.', keys: ['query', 'limit'], required: ['query'] },
  attach_chat_image: { action: 'attach', source: 'chats', description: 'Attach a project image to a chat draft or append an image-bearing user message. Does not start an AI turn.', keys: ['chatId', 'path', 'target', 'content'], required: ['path'] },
  list_chat_attachments: { action: 'list_attachments', source: 'chats', description: 'List draft and message image metadata without pixels. Follow nextBeforeSeq with beforeSeq for older messages.', keys: ['chatId', 'limit', 'beforeSeq'] },
  get_settings: { action: 'settings_get', source: 'mouaif', description: 'Read redacted app or project settings, optionally restricted to specific keys. Defaults to app scope.', keys: ['scope', 'keys'] },
  update_settings: { action: 'settings_update', source: 'mouaif', description: 'Update app or project settings with a patch and optional project unset list. Credentials are not writable. Defaults to project scope.', keys: ['scope', 'patch', 'unset'] },
  list_projects: { action: 'project_list', source: 'mouaif', description: 'List registered projects with their names, paths, and costs.', keys: [] },
  get_app_info: { action: 'info', source: 'mouaif', description: 'Describe mouaif’s feature state and the native app tools.', keys: [] }
});
const TOOL_NAMES = Object.freeze(Object.keys(DEFINITIONS));
module.exports = { DEFINITIONS, TOOL_NAMES };
