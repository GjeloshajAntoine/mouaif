'use strict';

// Content registry — one declaration per kind of configured content.
//
// See docs/agent/plans/settings-architecture.md and
// docs/features/content-registry.md. Everything the user configures is one of
// two shapes:
//
//   value       one setting at a path in a document (`promptSize`,
//               `toolOutput.size`, `notifications.login`)
//   collection  items with an id and fields (agents, prompts, models, tags…)
//
// A declaration is plain data plus a few pure functions. The built-in
// defaults (`settings.DEFAULTS`), the client allowlist
// (`CLIENT_SETTINGS_KEYS`), the reset allowlist (`RESETTABLE_APP_KEYS`) and the
// approval list (`PERMISSION_KEYS`) are all generated from this file, so a
// setting is declared once instead of in up to six places.
//
// Declaration fields:
//   id            unique id; for values usually the dotted path
//   shape         'value' | 'collection'
//   scopes        ['app'] | ['project'] | ['app', 'project']
//   doc           the document the content lives in ('settings' | 'mcp')
//   path          dotted path inside the document
//   field         (value) { type, options?, default?, secret?, large? };
//                 type 'integer' also takes `min` and `max` (inclusive)
//   fields        (collection) { key: field } describing an item; a field
//                 marked `hidden` (timestamps) is left out of change lists
//   container     (collection) 'array' (items carry their id) or 'map'
//                 (the item id is the map key)
//   itemId        (collection, array) the item property that is its id
//   itemLabel     (collection) the item property shown as its name
//   merge         (collection) 'override' | 'concat' | 'replace' — how app
//                 and project lists combine on read
//   label, description, keywords, group, page, itemPage
//   searchFields  (collection) item properties the search matches
//   clientVisible app scope: the browser and the model may read and write it
//   resettable    app scope: POST /api/settings/app/reset may drop it
//   approval      a write needs the user's approval (permission-shaping keys)
//   writers       { ui, tool, share } — `tool` names the tool that writes it
//                 ('update_settings', or a dedicated one such as
//                 'hook_create'); `false` means that actor never writes it
//   internal      server bookkeeping: never shown, searched or written by
//                 the UI, the model or a remote caller
//
// The flags that the generated key lists read (clientVisible, resettable,
// approval) are properties of the top-level document key. Every declaration
// sharing a root key must agree on them; the registry test checks that.

const TOOL = 'update_settings';
const ALL_WRITERS = Object.freeze({ ui: true, tool: TOOL, share: true });
const NO_WRITERS = Object.freeze({ ui: false, tool: false, share: false });

// ---- Field helpers -------------------------------------------------------

const PROMPT_SIZES = ['very-small', 'average', 'extensive', 'chat'];
const OUTPUT_SIZES = ['very-small', 'average', 'full', 'extensive'];
const GATE_MODES = ['off', 'ask', 'allow'];

function bool(def) { return { type: 'boolean', default: def }; }

// One budget of `subagentLimits`: an integer in the range the delegation
// scope accepts. The ranges and defaults live with the scope
// (src/tools/subagent-orchestration.js) and are only read here.
const SUBAGENT_LIMITS = require('../tools/subagent-orchestration.js');
function subagentLimit(name) {
  const range = SUBAGENT_LIMITS.LIMIT_RANGES[name];
  return { type: 'integer', min: range.min, default: SUBAGENT_LIMITS.DEFAULT_LIMITS[name] };
}

// An MCP server entry (src/mcp.js normalizeServerEntry): app and project
// servers share it. Headers and env often carry tokens, so change lists show
// them as set / not set.
const MCP_SERVER_FIELDS = Object.freeze({
  name: { type: 'string', label: 'Name' },
  slug: { type: 'string', label: 'Tool prefix' },
  transport: { type: 'enum', label: 'Transport', options: ['stdio', 'http', 'sse'] },
  command: { type: 'string', label: 'Command' },
  args: { type: 'list', label: 'Arguments' },
  cwd: { type: 'string', label: 'Working folder' },
  url: { type: 'string', label: 'URL' },
  headers: { type: 'object', label: 'Headers', secret: true },
  env: { type: 'object', label: 'Environment', secret: true },
  oauth: { type: 'object', label: 'OAuth' },
  createdAt: { type: 'string', label: 'Created', hidden: true }
});

// A hook entry (src/hooks.js normalizeHook): app and project hooks share it.
const HOOK_FIELDS = Object.freeze({
  name: { type: 'string', label: 'Name' },
  event: { type: 'string', label: 'Event' },
  match: { type: 'object', label: 'When' },
  handler: { type: 'object', label: 'Runs', large: true },
  timeoutMs: { type: 'number', label: 'Timeout (ms)' },
  failClosed: { type: 'boolean', label: 'Block on failure' },
  subagents: { type: 'boolean', label: 'Also in subagents' },
  enabled: { type: 'boolean', label: 'Enabled' },
  note: { type: 'string', label: 'Note' },
  createdBy: { type: 'string', label: 'Added by', hidden: true }
});

// ---- Declarations --------------------------------------------------------
//
// Order matters for two generated lists: CLIENT_SETTINGS_KEYS follows the
// first appearance of each client-visible root key, and DEFAULTS keeps the
// insertion order of its keys. Keep new entries next to their group.

const TYPES = [
  // ---- Providers and models ---------------------------------------------
  {
    id: 'providers', shape: 'collection', scopes: ['app'], doc: 'settings', path: 'providers',
    container: 'array', itemId: 'id', itemLabel: 'name', merge: 'replace', default: [],
    fields: {
      type: { type: 'string', label: 'Type' },
      name: { type: 'string', label: 'Name' },
      baseUrl: { type: 'string', label: 'Base URL' },
      auth: { type: 'enum', label: 'Sign-in', options: ['apikey', 'oauth'] },
      oauthAccount: { type: 'string', label: 'Account' },
      apiKey: { type: 'string', label: 'API key', secret: true, boundTo: 'baseUrl' }
    },
    label: 'Providers', itemNoun: 'Provider', description: 'Connections to AI services: API keys and sign-ins.',
    keywords: ['api key', 'connection', 'openai', 'anthropic', 'sign in', 'oauth'],
    group: 'Providers', page: 'settings/providers', itemPage: 'settings/providers/:id',
    searchFields: ['id', 'name', 'type', 'baseUrl'],
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'models', shape: 'collection', scopes: ['app', 'project'], doc: 'settings', path: 'models',
    container: 'array', itemId: 'id', itemLabel: 'label', merge: 'override', default: [],
    fields: {
      provider: { type: 'string', label: 'Provider' },
      label: { type: 'string', label: 'Label' },
      contextWindow: { type: 'number', label: 'Context window' },
      apiKey: { type: 'string', label: 'API key', secret: true, boundTo: 'baseUrl' }
    },
    label: 'Models', itemNoun: 'Model', description: 'Model ids a project can pick, each tied to a provider connection.',
    keywords: ['llm', 'context window'],
    group: 'Providers', page: 'settings/providers',
    searchFields: ['id', 'label', 'provider'],
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'projects', shape: 'collection', scopes: ['app'], doc: 'settings', path: 'projects',
    container: 'array', itemId: 'id', itemLabel: 'name', merge: 'replace', default: [],
    fields: {
      path: { type: 'string', label: 'Folder' },
      name: { type: 'string', label: 'Name' }
    },
    label: 'Projects', itemNoun: 'Project', description: 'Registered project folders.',
    keywords: ['folder', 'workspace'],
    group: 'Providers', page: 'settings/projects',
    searchFields: ['name', 'path'],
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },

  // ---- Chat defaults ------------------------------------------------------
  {
    id: 'promptSize', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'promptSize',
    field: { type: 'enum', options: PROMPT_SIZES, default: 'average' },
    label: 'Prompt style', description: 'Default prompt-size profile for new chats.',
    keywords: ['prompt size', 'system prompt', 'very small', 'extensive', 'chat'],
    group: 'Chat defaults', page: 'settings/defaults', projectPage: 'settings/project',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'enterForNewline', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'enterForNewline',
    field: bool(true),
    label: 'Enter adds a newline', description: 'When on, Enter inserts a newline and the send button sends.',
    keywords: ['keyboard', 'send', 'enter', 'composer'],
    group: 'Chat defaults', page: 'settings/defaults',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'autoRetry', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'autoRetry',
    field: bool(true),
    label: 'Auto-retry failed sends', description: 'Re-send a message once when the request fails before the reply starts.',
    keywords: ['retry', 'network', 'error'],
    group: 'Chat defaults', page: 'settings/defaults',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'fileOrbButton', shape: 'value', scopes: ['app'], doc: 'settings', path: 'fileOrbButton',
    field: bool(false),
    label: 'Glass orb file button', description: 'Draw the composer file button as the animated glass orb.',
    keywords: ['orb', 'file button', 'composer', 'appearance'],
    group: 'Chat defaults', page: 'settings/defaults',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'dictationButton', shape: 'value', scopes: ['app'], doc: 'settings', path: 'dictationButton',
    field: bool(true),
    label: 'Microphone button', description: 'Show the dictation button in the composer.',
    keywords: ['dictation', 'microphone', 'voice', 'composer'],
    group: 'Chat defaults', page: 'settings/defaults',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'imageButton', shape: 'value', scopes: ['app'], doc: 'settings', path: 'imageButton',
    field: bool(true),
    label: 'Image button', description: 'Show the image-attachment button in the composer.',
    keywords: ['image', 'attachment', 'photo', 'composer'],
    group: 'Chat defaults', page: 'settings/defaults',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'statusBar', shape: 'value', scopes: ['app'], doc: 'settings', path: 'statusBar',
    field: bool(true),
    label: 'Status line', description: 'Show the one-line status row under the composer.',
    keywords: ['status', 'composer'],
    group: 'Chat defaults', page: 'settings/defaults',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'dictation', shape: 'value', scopes: ['app'], doc: 'settings', path: 'dictation',
    field: { type: 'object' },
    label: 'Dictation model', description: 'The speech-to-text model the microphone uses.',
    keywords: ['speech', 'transcribe', 'voice', 'whisper'],
    group: 'Dictation', page: 'settings/dictation',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },

  // ---- Prompts ------------------------------------------------------------
  {
    id: 'prompts', shape: 'collection', scopes: ['app', 'project'], doc: 'settings', path: 'prompts',
    container: 'array', itemId: 'id', itemLabel: 'title', merge: 'override', default: [],
    fields: {
      title: { type: 'string', label: 'Title' },
      content: { type: 'text', label: 'Prompt', large: true },
      icon: { type: 'string', label: 'Icon' },
      showOnProjectCard: { type: 'boolean', label: 'On the project card' },
      preset: { type: 'object', label: 'Tools and context' },
      createdAt: { type: 'string', label: 'Created', hidden: true },
      updatedAt: { type: 'string', label: 'Updated', hidden: true }
    },
    label: 'Custom prompts', itemNoun: 'Prompt', description: 'System prompts a chat can start from.',
    keywords: ['system prompt', 'persona', 'instructions'],
    group: 'Prompts', page: 'settings/prompts', itemPage: 'settings/prompts/:id',
    searchFields: ['id', 'title', 'content'],
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'profileLaunchers', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'profileLaunchers',
    field: { type: 'object' },
    label: 'Built-in prompt launchers', description: 'Icon and project-card pin for the built-in prompt styles.',
    keywords: ['icon', 'pin', 'project card'],
    group: 'Prompts', page: 'settings/prompts',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },

  // ---- Providers extras ---------------------------------------------------
  {
    id: 'githubCopilot', shape: 'value', scopes: ['app'], doc: 'settings', path: 'githubCopilot',
    field: { type: 'object' },
    label: 'GitHub Copilot OAuth app', description: 'Client id of a custom GitHub OAuth app for Copilot sign-in.',
    keywords: ['copilot', 'github', 'client id'],
    group: 'Providers', page: 'settings/providers/github-copilot',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'modelPricing', shape: 'value', scopes: ['app'], doc: 'settings', path: 'modelPricing',
    field: { type: 'object' },
    label: 'Model pricing', description: 'Per-model cost table used for chat cost totals.',
    keywords: ['cost', 'price', 'tokens', 'usage'],
    group: 'Providers', page: 'settings/pricing',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'authAccounts', shape: 'value', scopes: ['app'], doc: 'settings', path: 'authAccounts',
    field: { type: 'object', default: {} },
    label: 'Signed-in accounts', description: 'Which OAuth accounts are signed in per provider. Tokens live in the credential store.',
    keywords: ['oauth', 'account', 'sign in'],
    group: 'Providers', page: 'settings/providers',
    clientVisible: true, resettable: true, approval: true, writers: ALL_WRITERS
  },
  {
    id: 'authPending', shape: 'value', scopes: ['app'], doc: 'settings', path: 'authPending',
    field: { type: 'object', secret: true },
    label: 'Sign-ins in progress', description: 'In-flight OAuth flows (server only).',
    approval: true, internal: true, writers: NO_WRITERS
  },

  // ---- Tools --------------------------------------------------------------
  {
    id: 'tools', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'tools',
    field: { type: 'object' },
    label: 'Tool permissions', description: 'Off, ask or allow for each tool family and tool.',
    keywords: ['permission', 'authorization', 'allow', 'ask', 'shell', 'file', 'gate', 'allowlist'],
    group: 'Tools', page: 'settings/project',
    clientVisible: true, approval: true, writers: ALL_WRITERS
  },
  {
    id: 'toolFeedbackMaxBytes', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'toolFeedbackMaxBytes',
    field: { type: 'number', default: 64 * 1024 },
    label: 'Tool result context cap', description: 'Maximum bytes of one tool result copied into the model context.',
    keywords: ['context', 'bytes', 'truncate', 'tool result'],
    group: 'Tools', page: 'settings/project/output',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'toolOutput.size', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'toolOutput.size',
    field: { type: 'enum', options: OUTPUT_SIZES, default: 'average' },
    label: 'Tool output size', description: 'Byte cap on file and result text sent back to the model.',
    keywords: ['context', 'bytes', 'output', 'file tools'],
    group: 'Tools', page: 'settings/project/output',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'toolOutput.structure', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'toolOutput.structure',
    field: { type: 'enum', options: ['tree', 'json'], default: 'tree' },
    label: 'File listing layout', description: 'Indented tree or raw JSON for file listings sent to the model.',
    keywords: ['tree', 'json', 'listing', 'file tools'],
    group: 'Tools', page: 'settings/project/output',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'notifications.status', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'notifications.status',
    field: bool(true),
    label: 'Chat status notifications', description: 'One replaceable notification per chat with its current state.',
    keywords: ['notification', 'alert', 'push', 'done'],
    group: 'Notifications', page: 'settings/notifications',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'notifications.authorization', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'notifications.authorization',
    field: bool(true),
    label: 'Approval notifications', description: 'Notify when a tool call waits for your approval.',
    keywords: ['notification', 'approval', 'permission', 'push'],
    group: 'Notifications', page: 'settings/notifications',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'notifications.quickActions', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'notifications.quickActions',
    field: bool(true),
    label: 'Notification quick actions', description: 'Answer or approve from the notification without opening the app.',
    keywords: ['notification', 'reply', 'approve', 'push'],
    group: 'Notifications', page: 'settings/notifications',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'notifications.login', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'notifications.login',
    field: bool(true),
    label: 'New sign-in alerts', description: 'Notify when a new device signs in.',
    keywords: ['notification', 'security', 'login', 'sign in'],
    group: 'Notifications', page: 'settings/notifications',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'flags', shape: 'value', scopes: ['app'], doc: 'settings', path: 'flags',
    field: { type: 'object', default: {} },
    label: 'Feature flags', description: 'Server-side feature toggles.',
    keywords: ['flag', 'experimental'],
    group: 'Advanced', page: 'settings/about',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },

  // ---- Subagent delegation budgets ---------------------------------------
  // One root turn's whole delegation tree shares them; read when the turn
  // starts (src/ai-stream.js rootSubagentLimits).
  {
    id: 'subagentLimits.maxDepth', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'subagentLimits.maxDepth',
    field: subagentLimit('maxDepth'),
    label: 'Subagent nesting depth', description: 'How many levels of subagents one turn may stack. 1 turns nesting off: subagents cannot start their own.',
    keywords: ['subagent', 'delegate', 'recursive', 'nested', 'depth', 'limit'],
    group: 'Project', page: 'settings/agents',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'subagentLimits.maxRuns', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'subagentLimits.maxRuns',
    field: subagentLimit('maxRuns'),
    label: 'Subagent runs per turn', description: 'How many subagents one turn may start in total, at every level together.',
    keywords: ['subagent', 'delegate', 'budget', 'runs', 'limit'],
    group: 'Project', page: 'settings/agents',
    clientVisible: true, resettable: true, writers: ALL_WRITERS
  },

  // ---- Server-side app keys with defaults, not sent to the browser --------
  {
    id: 'shellReview.mode', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'shellReview.mode',
    field: { type: 'enum', options: ['off', 'always', 'ask'], default: 'off' },
    label: 'Shell review', description: 'Have a second model explain a shell command before it runs.',
    keywords: ['shell', 'review', 'command', 'explain', 'safety'],
    group: 'Tools', page: 'settings/project/shell-review',
    resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'shellReview.providerId', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'shellReview.providerId',
    field: { type: 'string' },
    label: 'Shell review provider', description: 'Provider connection of the reviewing model.',
    keywords: ['shell', 'review'],
    group: 'Tools', page: 'settings/project/shell-review',
    resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'shellReview.modelId', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'shellReview.modelId',
    field: { type: 'string' },
    label: 'Shell review model', description: 'Model that reviews shell commands.',
    keywords: ['shell', 'review'],
    group: 'Tools', page: 'settings/project/shell-review',
    resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'shellReview.prompt', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'shellReview.prompt',
    field: { type: 'text', large: true },
    label: 'Shell review prompt', description: 'Instructions the reviewing model gets.',
    keywords: ['shell', 'review', 'prompt'],
    group: 'Tools', page: 'settings/project/shell-review',
    resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'toolWording.active', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'toolWording.active',
    field: { type: 'string', default: '' },
    label: 'Active tool wording', description: 'Which wording set the model sees; empty is the built-in wording.',
    keywords: ['wording', 'tool description', 'rename', 'override'],
    group: 'Tools', page: 'settings/project/tool-overrides',
    resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'toolWording.sets', shape: 'collection', scopes: ['app', 'project'], doc: 'settings', path: 'toolWording.sets',
    container: 'map', itemLabel: 'name', merge: 'override', default: {},
    fields: {
      name: { type: 'string', label: 'Name' },
      tools: { type: 'object', label: 'Replacements', large: true }
    },
    label: 'Tool wording sets', itemNoun: 'Wording set', description: 'Named sets of replacement tool descriptions and field names.',
    keywords: ['wording', 'tool description', 'rename', 'override'],
    group: 'Tools', page: 'settings/project/tool-overrides',
    searchFields: ['name'],
    resettable: true, writers: ALL_WRITERS
  },
  {
    id: 'toolOverrides', shape: 'value', scopes: ['app', 'project'], doc: 'settings', path: 'toolOverrides',
    field: { type: 'object', default: {} },
    label: 'Legacy tool wording', description: 'Flat wording map from before wording sets; moved into a set on save.',
    keywords: ['wording', 'override'],
    group: 'Tools', page: 'settings/project/tool-overrides',
    resettable: true, writers: ALL_WRITERS
  },

  // ---- App-only content read through its own routes ----------------------
  {
    id: 'themes.active', shape: 'value', scopes: ['app'], doc: 'settings', path: 'themes.active',
    field: { type: 'string' },
    label: 'Active theme', description: 'The theme the app is drawn with.',
    keywords: ['theme', 'dark', 'light', 'colour', 'color', 'appearance'],
    group: 'Appearance', page: 'settings/themes',
    writers: { ui: true, tool: false, share: false }
  },
  {
    id: 'themes', shape: 'collection', scopes: ['app'], doc: 'settings', path: 'themes.custom',
    container: 'array', itemId: 'id', itemLabel: 'name', merge: 'replace',
    fields: {
      name: { type: 'string', label: 'Name' },
      base: { type: 'enum', label: 'Base', options: ['dark', 'light'] },
      vars: { type: 'object', label: 'Colours' },
      css: { type: 'text', label: 'CSS', large: true },
      js: { type: 'text', label: 'Script', large: true }
    },
    label: 'Themes', itemNoun: 'Theme', description: 'Your own colour themes, CSS and script effects.',
    keywords: ['theme', 'colour', 'color', 'css', 'appearance'],
    group: 'Appearance', page: 'settings/themes', itemPage: 'settings/themes/:id',
    searchFields: ['id', 'name'],
    writers: { ui: true, tool: false, share: false }
  },
  {
    id: 'hooks.enabled', shape: 'value', scopes: ['app'], doc: 'settings', path: 'hooks.enabled',
    field: { type: 'boolean' },
    label: 'Hooks on', description: 'Pause or resume every app hook.',
    keywords: ['hook', 'pause'],
    group: 'Automation', page: 'settings/hooks',
    approval: true, writers: { ui: true, tool: 'hook_create', share: false }
  },
  {
    id: 'appHooks', shape: 'collection', scopes: ['app'], doc: 'settings', path: 'hooks.list',
    container: 'array', itemId: 'id', itemLabel: 'name', merge: 'concat',
    fields: HOOK_FIELDS,
    label: 'Hooks', itemNoun: 'Hook', description: 'Commands that check prompts and tool calls, in every project.',
    keywords: ['hook', 'command', 'script', 'before', 'after', 'block'],
    group: 'Automation', page: 'settings/hooks',
    searchFields: ['id', 'name', 'event', 'handler.command', 'handler.script'],
    approval: true, writers: { ui: true, tool: 'hook_create', share: false }
  },
  {
    id: 'hooks', shape: 'collection', scopes: ['project'], doc: 'settings', path: 'hooks',
    container: 'array', itemId: 'id', itemLabel: 'name', merge: 'concat',
    fields: HOOK_FIELDS,
    label: 'Hooks', itemNoun: 'Hook', description: 'Commands that check prompts and tool calls in this project. They run once you trust them.',
    keywords: ['hook', 'command', 'script', 'before', 'after', 'block', 'trust'],
    group: 'Automation', page: 'settings/hooks',
    searchFields: ['id', 'name', 'event', 'handler.command', 'handler.script'],
    approval: true, writers: { ui: true, tool: 'hook_create', share: false }
  },
  {
    id: 'mcpServers', shape: 'collection', scopes: ['app'], doc: 'settings', path: 'mcp.servers',
    container: 'array', itemId: 'id', itemLabel: 'name', merge: 'concat',
    fields: MCP_SERVER_FIELDS,
    label: 'MCP servers', itemNoun: 'MCP server', description: 'Tool servers the model can call, in every project.',
    keywords: ['mcp', 'server', 'tools', 'connector'],
    group: 'Automation', page: 'settings/mcp', itemPage: 'settings/mcp/:id',
    searchFields: ['name', 'command', 'url'],
    approval: true, writers: { ui: true, tool: false, share: false }
  },
  {
    // The project's own document (`.mcp.json`, or a DB row for a DB-mode
    // project): src/content/stores/project-mcp.js.
    id: 'projectMcpServers', shape: 'collection', scopes: ['project'], doc: 'mcp', path: 'servers',
    container: 'array', itemId: 'id', itemLabel: 'name', merge: 'concat',
    fields: MCP_SERVER_FIELDS,
    label: 'MCP servers', itemNoun: 'MCP server', description: 'Tool servers the model can call in this project.',
    keywords: ['mcp', 'server', 'tools', 'connector', '.mcp.json'],
    group: 'Automation', page: 'settings/mcp', itemPage: 'settings/mcp/:id',
    searchFields: ['name', 'command', 'url'],
    approval: true, writers: { ui: true, tool: false, share: false }
  },
  {
    // The app-wide MCP gate (src/tools/authorization.js setAppMcpAuthorization).
    id: 'mcpAuthorization', shape: 'value', scopes: ['app'], doc: 'settings', path: 'mcp.authorization',
    field: { type: 'object' },
    label: 'MCP tool permissions', description: 'Off, ask or allow for MCP tools, in every project.',
    keywords: ['mcp', 'permission', 'authorization', 'allow', 'ask', 'allowlist'],
    group: 'Tools', page: 'settings/mcp',
    approval: true, writers: { ui: true, tool: false, share: false }
  },
  {
    // The project's MCP gate and per-server / per-tool overrides, beside the
    // servers in the `mcp` document (src/tools/authorization.js
    // setAuthorization). A shared project's caller may change it: the chat's
    // Tools card writes it, and the share gate still decides which MCP tools
    // that caller can run.
    id: 'projectMcpAuthorization', shape: 'value', scopes: ['project'], doc: 'mcp', path: 'authorization',
    field: { type: 'object' },
    label: 'MCP tool permissions', description: 'Off, ask or allow for MCP servers and tools in this project.',
    keywords: ['mcp', 'permission', 'authorization', 'allow', 'ask', 'allowlist', '.mcp.json'],
    group: 'Tools', page: 'settings/mcp',
    approval: true, writers: { ui: true, tool: false, share: true }
  },

  // ---- Project-only content ----------------------------------------------
  {
    id: 'name', shape: 'value', scopes: ['project'], doc: 'settings', path: 'name',
    field: { type: 'string' },
    label: 'Project name', description: 'The name shown on the project card.',
    keywords: ['title', 'rename'],
    group: 'Project', page: 'settings/project', writers: ALL_WRITERS
  },
  {
    id: 'agents', shape: 'collection', scopes: ['project'], doc: 'settings', path: 'agents',
    container: 'array', itemId: 'name', itemLabel: 'name', merge: 'replace',
    fields: {
      content: { type: 'text', label: 'Instructions', large: true },
      tools: { type: 'list', label: 'Allowed tools' },
      modelId: { type: 'string', label: 'Model' },
      providerId: { type: 'string', label: 'Provider' },
      thinkingLevel: { type: 'string', label: 'Thinking' },
      createdAt: { type: 'string', label: 'Created', hidden: true },
      updatedAt: { type: 'string', label: 'Updated', hidden: true }
    },
    label: 'Agents', itemNoun: 'Agent', description: 'Personas the subagent tool can delegate to.',
    keywords: ['subagent', 'persona', 'delegate'],
    group: 'Project', page: 'settings/agents', itemPage: 'settings/agents/:id',
    searchFields: ['name', 'content'],
    writers: ALL_WRITERS
  },
  {
    id: 'defaultAgent', shape: 'value', scopes: ['project'], doc: 'settings', path: 'defaultAgent',
    field: { type: 'string' },
    label: 'Default agent', description: 'The agent the subagent tool uses when none is named.',
    keywords: ['subagent', 'persona'],
    group: 'Project', page: 'settings/agents', writers: ALL_WRITERS
  },
  {
    id: 'skills', shape: 'value', scopes: ['project'], doc: 'settings', path: 'skills',
    field: { type: 'boolean' },
    label: 'Skills', description: 'Offer the project’s skills to the model.',
    keywords: ['skill', 'SKILL.md'],
    group: 'Project', page: 'settings/project', writers: ALL_WRITERS
  },
  {
    id: 'disabledSkills', shape: 'value', scopes: ['project'], doc: 'settings', path: 'disabledSkills',
    field: { type: 'list' },
    label: 'Disabled skills', description: 'Skills left out of every chat in this project.',
    keywords: ['skill'],
    group: 'Project', page: 'settings/project', writers: ALL_WRITERS
  },
  {
    id: 'agentFiles', shape: 'value', scopes: ['project'], doc: 'settings', path: 'agentFiles',
    field: { type: 'boolean' },
    label: 'Inject agent files', description: 'Add AGENTS.md and similar files to every chat.',
    keywords: ['AGENTS.md', 'CLAUDE.md', 'instructions', 'context'],
    group: 'Project', page: 'settings/project/agent-files', writers: ALL_WRITERS
  },
  {
    id: 'agentFileNames', shape: 'value', scopes: ['project'], doc: 'settings', path: 'agentFileNames',
    field: { type: 'list' },
    label: 'Agent file names', description: 'File names looked for when injecting agent files.',
    keywords: ['AGENTS.md', 'CLAUDE.md', 'copilot-instructions'],
    group: 'Project', page: 'settings/project/agent-files', writers: ALL_WRITERS
  },
  {
    id: 'customActions', shape: 'collection', scopes: ['project'], doc: 'settings', path: 'customActions',
    container: 'array', itemId: 'id', itemLabel: 'label', merge: 'replace',
    fields: {
      label: { type: 'string', label: 'Label' },
      kind: { type: 'enum', label: 'Kind', options: ['cli', 'mcp'] },
      command: { type: 'string', label: 'Command' },
      serverId: { type: 'string', label: 'MCP server' },
      toolName: { type: 'string', label: 'MCP tool' }
    },
    label: 'Custom actions', itemNoun: 'Action', description: 'Composer buttons that run a command or an MCP tool.',
    keywords: ['button', 'command', 'shortcut'],
    group: 'Project', page: 'settings/actions', itemPage: 'settings/actions/:id',
    searchFields: ['id', 'label', 'command', 'toolName'],
    writers: ALL_WRITERS
  },
  {
    id: 'tags', shape: 'collection', scopes: ['project'], doc: 'settings', path: 'tags',
    container: 'map', itemLabel: null, merge: 'replace',
    fields: {
      tags: { type: 'list', label: 'Tags' },
      includeInChat: { type: 'boolean', label: 'Add to chats' },
      excerpt: { type: 'object', label: 'Excerpt' }
    },
    label: 'File tags', itemNoun: 'Tagged file', description: 'Files annotated with tags and added to chats.',
    keywords: ['tag', 'file', 'inject', 'context'],
    group: 'Project', page: 'settings/tags',
    searchFields: ['$id', 'tags'], searchCap: 20,
    writers: ALL_WRITERS
  },
  {
    id: 'hideFileContent', shape: 'collection', scopes: ['project'], doc: 'settings', path: 'hideFileContent',
    container: 'array', itemId: 'path', itemLabel: 'path', merge: 'replace',
    fields: {
      ranges: { type: 'object', label: 'Hidden lines' },
      chars: { type: 'object', label: 'Hidden characters' }
    },
    label: 'Hidden file content', itemNoun: 'Hidden file', description: 'Line ranges of project files the file tools do not reveal.',
    keywords: ['hide', 'redact', 'secret', 'privacy'],
    group: 'Project', page: 'settings/project/hide',
    searchFields: ['path'], searchCap: 20,
    writers: ALL_WRITERS
  },
  {
    id: 'extensions', shape: 'value', scopes: ['project'], doc: 'settings', path: 'extensions',
    field: { type: 'object' },
    label: 'Extensions in this project', description: 'Which extensions are on in this project.',
    keywords: ['extension', 'plugin'],
    group: 'Automation', page: 'settings/extensions', writers: ALL_WRITERS
  }
];

// ---- Indexes and lookups -------------------------------------------------

const BY_ID = new Map();
for (const type of TYPES) {
  if (BY_ID.has(type.id)) throw new Error('content registry: duplicate id ' + type.id);
  Object.freeze(type);
  BY_ID.set(type.id, type);
}
Object.freeze(TYPES);

function rootKey(type) {
  return String(type.path).split('.')[0];
}

function getType(id) {
  return BY_ID.get(id) || null;
}

function listTypes() {
  return TYPES.slice();
}

// Every declaration whose document path starts at root key `key`.
function typesForRoot(key, doc = 'settings') {
  return TYPES.filter((t) => t.doc === doc && rootKey(t) === key);
}

// The declaration that owns exactly `path` (or the nearest declared prefix).
function typeForPath(path, doc = 'settings') {
  let best = null;
  for (const t of TYPES) {
    if (t.doc !== doc) continue;
    if (t.path === path) return t;
    if (path.startsWith(t.path + '.') && (!best || t.path.length > best.path.length)) best = t;
  }
  return best;
}

// Root keys (in declaration order) whose declarations satisfy `pred`.
function rootKeys(pred, scope) {
  const out = [];
  for (const t of TYPES) {
    if (t.doc !== 'settings') continue;
    if (scope && !t.scopes.includes(scope)) continue;
    if (!pred(t)) continue;
    const key = rootKey(t);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

// ---- Generated lists -----------------------------------------------------

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function defaultOf(type) {
  if (type.shape === 'collection') return type.default;
  return type.field ? type.field.default : undefined;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// The built-in floor of the settings document: every declared default at its
// path. Fresh object each call; settings.js freezes the copy it exports.
function buildDefaults() {
  const out = {};
  for (const t of TYPES) {
    if (t.doc !== 'settings') continue;
    const def = defaultOf(t);
    if (def === undefined) continue;
    setPath(out, t.path, JSON.parse(JSON.stringify(def)));
  }
  return out;
}

// App keys the browser and the model may read and write.
function clientSettingsKeys() {
  return rootKeys((t) => t.clientVisible === true, 'app');
}

// App keys POST /api/settings/app/reset may drop: every key with a default,
// plus the client keys that are additive (their absence is the default).
function resettableAppKeys() {
  return rootKeys((t) => t.resettable === true || defaultOf(t) !== undefined, 'app');
}

// Keys whose write through update_settings always needs the user's approval.
// Content that only a dedicated tool writes (hooks: hook_create) is refused
// by update_settings outright, so it is not listed here.
function permissionKeys() {
  return rootKeys((t) => t.approval === true && !dedicatedTool(t));
}

// The tool name when a type is written only through its own tool.
function dedicatedTool(type) {
  const tool = type.writers && type.writers.tool;
  return typeof tool === 'string' && tool !== TOOL ? tool : null;
}

// ---- Search / display helpers -------------------------------------------

function labelFor(type) {
  return type.label || type.id;
}

module.exports = {
  TOOL,
  TYPES,
  getType,
  listTypes,
  typesForRoot,
  typeForPath,
  rootKey,
  defaultOf,
  labelFor,
  buildDefaults,
  deepFreeze,
  clientSettingsKeys,
  resettableAppKeys,
  permissionKeys,
  dedicatedTool
};
