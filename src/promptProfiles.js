'use strict';

// Prompt-size profiles.
//
// Implements the "Three prompt-size profiles" feature from
// .github/copilot-instructions.md §4. The chat record carries a
// `promptSize` field ('very-small' | 'average' | 'extensive') and
// `handleChatStream` in src/index.js prepends the matching profile's
// system message to the upstream `messages` array, immediately before
// any custom-prompt block.
//
// Resolution order (decisions §2): defaults -> app -> project.
//   - chat.promptSize (per-chat override; see src/chats.js) wins if set
//   - else settings.getResolved(projectDir).promptSize
//   - else 'average'  (the DEFAULTS floor in src/settings.js)
//
// The profiles are intentionally **static** for this commit. The text
// is a hand-written system prompt that fits the same model set we ship
// in the AI client (OpenAI-compatible, Anthropic, Gemini, Ollama,
// GitHub Copilot). It is not a per-provider prompt; the underlying
// messages array is the OpenAI-style shape the rest of the pipeline
// already understands. A future commit may add a `tools`-aware
// "extensive" prompt that injects the discovered MCP tool specs; the
// shape returned here is designed to keep that path additive.
//
// Profiles:
//   - very-small : identity-only. One line about who the model is.
//     Designed for low-latency replies and tight context budgets.
//   - average    : identity + concise guidance on how to answer
//     (be terse, use markdown) + agentic tool-loop rules (read/edit/
//     run loop, non-interactive shell, ask when unclear). The
//     recommended default.
//   - extensive  : identity + the same guidance + a few worked
//     examples and an explicit reminder about the tool/trace story.
//     For users who want the model to behave more deliberately and
//     to get the best out of the chat transcript.
//
// Public surface:
//   PROFILES                          : { 'very-small', 'average', 'extensive' }
//   DEFAULT_PROFILE                   : 'average'
//   isValidProfile(value)             : boolean
//   profileSystemMessage(value)       : string
//   listProfiles()                    : [{ id, label, description, summary }, ...]
//   resolveProfile({ chat, projectDir }): { id, label, description, summary, systemMessage }
//   describeProfile(value)            : { id, label, description, summary, systemMessage }
//                                       or null if value is unknown

const PROFILES = Object.freeze({
  'very-small': {
    id: 'very-small',
    label: 'Very small',
    description: 'Identity only. Lowest latency, smallest prompt.',
    summary: 'identity only',
    systemMessage:
      'You are a concise coding assistant running inside mouaif, a mobile chat UI. ' +
      'Answer in plain language with short Markdown. Ask before making changes that cannot be undone.'
  },
  'average': {
    id: 'average',
    label: 'Average',
    description: 'Identity + concise guidance + agentic tool-loop rules. The recommended default.',
    summary: 'identity + guidance + tool loop',
    systemMessage:
      'You are a coding assistant running inside mouaif, a mobile chat UI.\n\n' +
      'How to answer:\n' +
      '- Be terse. Default to short paragraphs and small code blocks; expand only when asked.\n' +
      '- Use fenced code with a language tag for every snippet.\n' +
      '- Cite paths relative to the project root. Never invent files or functions you have not seen.\n' +
      '- If the user has set a custom prompt, follow it where it does not conflict with this one.\n\n' +
      'Working in the project:\n' +
      '- When tools are enabled for this project (see the feature list), use them: read files with read_file, edit with edit_file using an exact, unique oldText block, run commands with shell.\n' +
      '- Shell commands are non-interactive (no stdin) — run the one-shot or flagged form, never a REPL or an interactive prompt.\n' +
      '- Work in a loop: inspect, change, run, read the error, iterate. There is no fixed turn limit; keep going until the task is done or the user cancels, and report what happened in plain language after each step.\n' +
      '- Ask before destructive actions such as delete, rewrite, push, install, or run an unknown command.\n' +
      '- When a task is ambiguous or unclear, ask a clarifying question before proceeding. Only proceed on your own when a reasonable assumption is obvious — and state it in one line when you do.'
  },
  'extensive': {
    id: 'extensive',
    label: 'Extensive',
    description: 'Identity + guidance + worked examples + best-practice reminders.',
    summary: 'identity + guidance + examples',
    systemMessage:
      'You are a coding assistant running inside mouaif, a mobile chat UI. The user opens a ' +
      'project folder, defines model IDs in the project settings, and chats with you in a ' +
      'mobile-first Preact UI served by the local Node process on http://127.0.0.1:5732. The ' +
      'chat is a long-lived transcript: the user re-opens it across days, traces it to a file ' +
      'under the project, and relies on the history staying readable.\n\n' +
      'How to answer:\n' +
      '- Be terse by default, but do not strip the why. The user is on a phone; small blocks ' +
      'beat walls of text.\n' +
      '- Use fenced code with a language tag for every snippet. Prefer editing an existing ' +
      'file over writing a new one. When you propose a new file, name the path and explain ' +
      'in one line why it is new.\n' +
      '- For existing files, read the relevant region and use edit_file with an exact, unique ' +
      'oldText/newText block. write_file replaces the complete file and is only appropriate ' +
      'for new files or deliberate full rewrites.\n' +
      '- Cite paths relative to the project root. Never invent files or functions you have ' +
      'not seen. If you are not sure, say so and ask for the file.\n' +
      '- When a task is destructive (delete, rewrite, push, install, run an unknown command), ' +
      'ask first. When a task is ambiguous, state your assumption in one line and proceed.\n' +
      '- Prefer reversible suggestions: a diff the user can paste beats a finished file.\n' +
      '- If the user has set a custom prompt for this chat, follow its instructions where ' +
      'they do not conflict with this one.\n' +
      '- Remember that the chat may be traced to a project-relative NDJSON file. Write ' +
      'messages that read well in a transcript: stable headings, no orphan Markdown, no ' +
      'sensitive-looking data unless the user shared it explicitly.\n' +
      '- If a tool is enabled on this project, the upstream may emit tool_call events. ' +
      'Surface the result in plain language; do not echo raw payloads unless they are short.'
  }
});

const DEFAULT_PROFILE = 'average';

function isValidProfile(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value);
}

function profileSystemMessage(value) {
  if (!isValidProfile(value)) return PROFILES[DEFAULT_PROFILE].systemMessage;
  return PROFILES[value].systemMessage;
}

function describeProfile(value) {
  if (!isValidProfile(value)) return null;
  // Return a shallow copy so the caller cannot mutate the frozen module-level data.
  return Object.assign({}, PROFILES[value]);
}

function listProfiles() {
  return Object.keys(PROFILES).map(k => Object.assign({}, PROFILES[k]));
}

const DISCOVER_TOOL_NAME = 'discover_tool';

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cloneToolSpec(spec) {
  const fn = (spec && spec.function) || {};
  return {
    type: 'function',
    function: {
      name: fn.name,
      description: fn.description,
      parameters: cloneJson(fn.parameters)
    }
  };
}

function toolNameList(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map(s => s && s.function && s.function.name)
    .filter(Boolean);
}

function makeDiscoverToolSpec(specs) {
  const names = toolNameList(specs);
  const list = names.length ? names.join(', ') : '(none)';
  return {
    type: 'function',
    function: {
      name: DISCOVER_TOOL_NAME,
      description: 'Discover the complete description and parameter schema for one available tool before calling it. Available tools: ' + list + '.',
      parameters: {
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            description: 'Name of the tool to expand.',
            enum: names
          }
        },
        required: ['toolName'],
        additionalProperties: false
      }
    }
  };
}

// reduceToolSpecs(specs, profileValue, opts) — shrink the tool declaration
// advertised to the model according to the active prompt-size profile.
// This is the core of the "three prompt-size profiles" feature
// (.github/copilot-instructions.md §4): the profile controls HOW MUCH
// of each tool is sent upstream, not just the system prompt text.
//
//   very-small : initially advertises only discover_tool. Its description
//                lists available tool names. After the model discovers a
//                tool, pass opts.discoveredToolNames to advertise that
//                chosen tool's full schema alongside discover_tool.
//   average    : full tool list, name + full description + parameters
//                (the compact-but-complete default).
//   extensive  : same as average (full), kept separate so the extensive
//                system prompt's best-practice guidance is what makes it
//                "extensive"; the tools themselves are already complete.
//
// `specs` is an array of OpenAI-shape tool specs
// ({ type:'function', function:{ name, description, parameters } }).
// Returns a NEW array; the input is never mutated. Unknown profiles
// fall through to the full list.
function reduceToolSpecs(specs, profileValue, opts) {
  if (!Array.isArray(specs) || !specs.length) return [];
  const profile = isValidProfile(profileValue) ? profileValue : DEFAULT_PROFILE;
  if (profile !== 'very-small') {
    // average + extensive: full specs, defensively copied.
    return specs.map(cloneToolSpec);
  }
  const discovered = new Set();
  const rawNames = opts && opts.discoveredToolNames;
  if (rawNames && typeof rawNames[Symbol.iterator] === 'function') {
    for (const n of rawNames) if (typeof n === 'string' && n) discovered.add(n);
  }
  const out = [makeDiscoverToolSpec(specs)];
  for (const spec of specs) {
    const name = spec && spec.function && spec.function.name;
    if (name && discovered.has(name)) out.push(cloneToolSpec(spec));
  }
  return out;
}

// resolveProfile({ chat, projectDir }) — pick the profile that applies
// to a chat right now. Resolution: chat.promptSize (if valid) -> the
// project's resolved promptSize (defaults -> app -> project, per
// decisions §2) -> 'average'. The function never throws; an unknown
// value falls through to the next layer so a stale or hand-edited
// project file still gets a sensible prompt.
function resolveProfile(opts) {
  const chat = opts && opts.chat;
  const projectDir = opts && opts.projectDir;
  let chosen = null;
  if (chat && isValidProfile(chat.promptSize)) chosen = chat.promptSize;
  if (!chosen && projectDir) {
    try {
      const settings = require('./settings.js');
      const resolved = settings.getResolved(projectDir);
      if (isValidProfile(resolved && resolved.promptSize)) chosen = resolved.promptSize;
    } catch { /* fall through to default */ }
  }
  if (!chosen) chosen = DEFAULT_PROFILE;
  return Object.assign({}, PROFILES[chosen], { systemMessage: PROFILES[chosen].systemMessage });
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE,
  isValidProfile,
  profileSystemMessage,
  describeProfile,
  listProfiles,
  resolveProfile,
  reduceToolSpecs,
  DISCOVER_TOOL_NAME,
  makeDiscoverToolSpec
};
