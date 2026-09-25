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
// Profiles share a provider-neutral core: changing the size adds detail,
// not conflicting rules about autonomy, safety, tools, or progress.
// Tool declarations are sized separately by reduceToolSpecs below.
//
// Profiles:
//   - very-small : compact core + on-demand tool-schema discovery.
//   - average    : the same core + an explicit inspect/edit/verify loop.
//     The recommended default, with full tool schemas.
//   - extensive  : all average guidance + planning, verification, and
//     concrete workflow examples. Also uses full tool schemas.
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

const CORE_GUIDANCE = [
  'You are a coding assistant running inside mouaif, a mobile chat UI.',
  '',
  '- Be concise by default. Use short Markdown, language-tagged code fences, and project-relative paths.',
  '- Follow applicable project and custom instructions, respecting higher-priority instructions.',
  '- Make reasonable, reversible decisions; state assumptions briefly. Ask when ambiguity affects scope, safety, or correctness.',
  '- Ask before destructive actions, full-file rewrites, dependency installs, or pushes unless explicitly authorized. Preserve unrelated user work.',
  '- Use only enabled tools and respect authorization gates. If a tool schema is missing, use discover_tool before calling it.',
  '- Inspect before editing; make focused changes, run relevant checks, and fix introduced failures. Shell has no stdin: use non-interactive commands, never a REPL.',
  '- If report_progress is enabled, call it at the start of every task with status: "running" and at completion with status: "completed" and current equal to total. Use status: "failed" if blocked; never mark unfinished work completed.',
  '- Never invent project facts or test results. Finish with the outcome, checks run, and any limitations. Do not expose secrets.'
].join('\n');
const WORKFLOW_GUIDANCE = [
  'Working in the project:',
  '- Inspect relevant files and project instructions using available search/read tools before proposing a fix. Ask for missing context only when tools cannot retrieve it.',
  '- For implementation requests, apply the change when authorized tools are available; do not stop at a proposed diff. For questions or reviews, answer without changing files unless asked.',
  '- Read the relevant region, then use edit_file with an exact, unique oldText/newText block. Use write_file for new files or explicitly authorized full rewrites. If an edit fails to match, re-read before retrying.',
  '- Keep changes scoped to the request and existing conventions. Avoid unrelated refactors, dependency changes, or reverting user edits.',
  '- Run targeted tests and the project lint/build as appropriate. Read failures, fix issues caused by the change, and repeat until verified, blocked, or cancelled. State clearly when checks could not run or failures are unrelated.',
  '- Keep progress updates brief and tied to real milestones. Use { title, current, total, status, message } with a stable title, a positive total, and current between zero and total. If the tool is unavailable, use a short plain-language update instead.',
  '- In the final reply, summarize what changed and what was verified; cite relevant paths and note remaining work. Do not dump raw tool output or claim success without evidence.'
].join('\n');
const EXTENSIVE_GUIDANCE = [
  'Planning and verification:',
  '- For multi-step work, outline a short plan and revise it when evidence changes. Use task tracking if available and useful; skip elaborate plans for simple requests.',
  '- Inspect callers, nearby tests, and configuration to understand the behavior before editing. Prefer the smallest fix that addresses the root cause.',
  '- Add or update regression tests for changed behavior and update related documentation. Test error paths and edge cases as well as the happy path.',
  '- For UI changes, check narrow mobile widths first, touch targets, keyboard access, and loading/error states; then check larger screens.',
  '- Parallelize independent reads or checks when useful. Keep dependent edits and commands ordered, and avoid concurrent writes to the same files.',
  '- Review the final diff for accidental changes and sensitive data. Summarize relevant tool evidence without copying credentials, tokens, or unnecessary private data into the transcript.',
  '',
  'Workflow examples:',
  '- Bug fix: reproduce or inspect the failing path, add a focused regression test, make the smallest correction, rerun checks, and report the results.',
  '- Harmless ambiguity: follow a nearby naming convention and mention the assumption. Material ambiguity: ask which behavior is intended before changing it.',
  '- Blocked check: if tests require an unavailable service, report which checks ran and which could not; do not describe the feature as fully verified or mark the task completed while required work remains.'
].join('\n');
const AVERAGE_GUIDANCE = CORE_GUIDANCE + '\n\n' + WORKFLOW_GUIDANCE;
const PROFILES = Object.freeze({
  'very-small': {
    id: 'very-small',
    label: 'Very small',
    description: 'Core coding rules with on-demand tool schemas. Smallest prompt.',
    summary: 'core rules + compact tools',
    systemMessage: CORE_GUIDANCE
  },
  'average': {
    id: 'average',
    label: 'Average',
    description: 'Core rules + inspect, edit, and verify workflow. The recommended default.',
    summary: 'core rules + tool workflow',
    systemMessage: AVERAGE_GUIDANCE
  },
  'extensive': {
    id: 'extensive',
    label: 'Extensive',
    description: 'All Average guidance + planning, verification, and workflow examples.',
    summary: 'core rules + workflow + examples',
    systemMessage: AVERAGE_GUIDANCE + '\n\n' + EXTENSIVE_GUIDANCE
  },
  // Plain conversation: no system prompt, and new chats start with no
  // tool checked (see NO_TOOLS_PROFILES / chats.js). The user can still
  // check tools in the chat's Tools card.
  'chat': {
    id: 'chat',
    label: 'Chat',
    description: 'Empty system prompt and no tools checked. For a plain conversation.',
    summary: 'empty prompt + no tools',
    systemMessage: ''
  }
});

// Profiles whose new chats start with an empty tool allowlist
// (`chat.tools = []`), i.e. every tool unchecked in the Tools card.
const NO_TOOLS_PROFILES = new Set(['chat']);

const DEFAULT_PROFILE = 'average';

function isValidProfile(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value);
}

function profileSystemMessage(value) {
  if (!isValidProfile(value)) return PROFILES[DEFAULT_PROFILE].systemMessage;
  // `chat` is intentionally empty; keep it empty rather than defaulting.
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
//   very-small : compact tool list, name + short description only (no
//                parameter schemas), plus discover_tool for on-demand
//                full-schema expansion. The list is FIXED for the whole
//                turn: the same tools are advertised on the first request
//                and on every tool-loop follow-up. Growing the list after
//                a discover_tool call would change the Anthropic cached
//                prefix (system + tools) between requests, so the warm
//                cache would be invalidated on every round and caching
//                would never engage.
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
  // very-small: discover_tool + one compact entry per tool, stable for
  // the whole turn. Compact entries keep the token budget low (the
  // profile's whole point) while the byte-stable list keeps the
  // Anthropic cache prefix identical across tool-loop requests.
  const out = [makeDiscoverToolSpec(specs)];
  for (const spec of specs) {
    const fn = (spec && spec.function) || {};
    if (!fn.name) continue;
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        // No `parameters` block: the model gets the tool's shape via
        // discover_tool if it needs it. Omitting it here is what keeps
        // very-small's footprint small AND the prefix stable.
      }
    });
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
  NO_TOOLS_PROFILES,
  isValidProfile,
  profileSystemMessage,
  describeProfile,
  listProfiles,
  resolveProfile,
  reduceToolSpecs,
  DISCOVER_TOOL_NAME,
  makeDiscoverToolSpec
};
