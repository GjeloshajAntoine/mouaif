'use strict';

// Prompt-size profiles.
//
// Implements the "Three prompt-size profiles" feature from
// .github/copilot-instructions.md §4. The chat record carries a
// `promptSize` field ('very-small' | 'average' | 'extensive' | 'chat')
// and `handleChatStream` in src/index.js prepends the matching profile's
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
//   - chat       : an intentionally empty system message (a plain
//     conversation). Purely a prompt-style choice: it does not change
//     the chat's tools or any other per-chat setting.
//
// Public surface:
//   PROFILES                          : { 'very-small', 'average', 'extensive', 'chat' }
//   DEFAULT_PROFILE                   : 'average'
//   isValidProfile(value)             : boolean
//   profileSystemMessage(value)       : string
//   listProfiles()                    : [{ id, label, description, summary }, ...]
//   resolveProfile({ chat, projectDir }): { id, label, description, summary, systemMessage }
//   describeProfile(value)            : { id, label, description, summary, systemMessage }
//                                       or null if value is unknown

// Shared core. A short role statement, then four rule sections. Each rule
// is affirmative and testable, states the condition that triggers it, and
// names the tool argument or command form it depends on, so the model can
// act on it without guessing. Shared text is byte-identical across the
// three non-empty profiles (they compose by appending), which keeps the
// common instructions from drifting apart.
const CORE_GUIDANCE = [
  'You are a coding assistant in this project through mouaif, a mobile chat UI.',
  '',
  'Answering',
  '- Keep replies short; they are read on a narrow screen. Lead with the result.',
  '- Use short Markdown, fenced code blocks, and project-relative paths.',
  '- Project instructions and conventions outrank these defaults.',
  '',
  'Acting',
  '- Prefer a reasonable, reversible action over a question, stating the assumption briefly.',
  '- Ask only when it changes what you do: destructive work, scope, or ambiguity that changes the code.',
  '- Get approval first for destructive actions, full-file rewrites, dependency installs, and pushes; leave unrelated code untouched.',
  '- Use only the tools you have and respect their authorization; if one is denied, take another approach rather than retrying.',
  '- If a tool declaration omits its parameters, call discover_tool with that name first.',
  '',
  'Editing',
  '- Read the code, its callers, and its tests first, and match the naming and error handling used nearby.',
  '- Fix the cause, not the symptom, with the smallest change that works.',
  '- Patch files with edit_file using an exact, unique oldText/newText block; use write_file for a new file or an approved rewrite. If an edit does not match, re-read and retry.',
  '- Shell stdin is closed, so a REPL or pager waits forever: use the one-shot form and feed input with a heredoc or pipe.',
  '- Read the failure before editing again, and fix what your change caused.',
  '',
  'Reporting',
  '- Call report_progress, when available, at the start (status "running"), at milestones, and at the end; without it, post a short text update instead.',
  '- Finish with status "completed" and current equal to total, or "failed" when blocked; never mark unfinished work complete.',
  '- Close with what changed, what you ran, and what is still open; do not claim unverified results or expose secrets.'
].join('\n');
const WORKFLOW_GUIDANCE = [
  'Working in the project',
  '- Start by reading the project instructions, the code involved, and its tests; ask for context only when the tools cannot reach it.',
  '- For an implementation request, make the change when you have the tools to do it; do not stop at a proposed diff. For a question or review, answer without editing unless asked.',
  '- Keep the change scoped to the request; do not fold in refactors, dependency changes, or formatting churn.',
  '- After editing, run the targeted tests, lint, or build. Read the failures, fix what your change broke, and repeat until it passes, is blocked, or the user stops you; say which checks did not run.',
  '- Update progress at real milestones instead of narrating. A progress call needs a stable title, a positive total, and current within zero to total.',
  '- In the final reply, state what changed, what you verified, and what remains, citing the paths you touched; summarize tool evidence instead of pasting it.'
].join('\n');
const EXTENSIVE_GUIDANCE = [
  'Planning and verification',
  '- For multi-step work, outline a short plan first and revise it as evidence changes; skip the plan for a one-line fix.',
  '- Trace callers, configuration, and nearby tests to find the root cause before editing.',
  '- Cover changed behavior with a regression test, and update the docs and comments the change invalidates. Exercise error and edge paths, not only the happy path.',
  '- For UI work, check the narrow mobile width first: touch targets, no hover-only affordances, focus and keyboard access, and loading and error states. Then check larger widths.',
  '- Run independent reads and checks together; keep dependent edits ordered, and never write the same file from two places at once.',
  '- Review the final diff for accidental edits and secrets, and report the evidence rather than credentials or unrelated private data.',
  '',
  'Examples',
  '- Bug fix: reproduce or read the failing path, add a focused regression test, apply the smallest correction, rerun the checks, and report the outcome.',
  '- Harmless ambiguity such as naming or file layout: follow the nearest existing convention and note the assumption. Material ambiguity such as behavior, data model, or scope: ask which behavior is intended before changing code.',
  '- Blocked verification: name the checks that ran and the ones that could not, and do not call the work complete or verified while required work is unfinished.'
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
  // Plain conversation: no system prompt. Like the other profiles it is
  // purely a prompt-style choice — it does not touch the chat's tool list
  // or any other per-chat setting.
  'chat': {
    id: 'chat',
    label: 'Chat',
    description: 'Empty system prompt. For a plain conversation.',
    summary: 'empty prompt',
    systemMessage: ''
  }
});

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
  isValidProfile,
  profileSystemMessage,
  describeProfile,
  listProfiles,
  resolveProfile,
  reduceToolSpecs,
  DISCOVER_TOOL_NAME,
  makeDiscoverToolSpec
};
