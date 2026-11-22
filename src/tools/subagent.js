'use strict';

// Native `subagent` tool — delegates a focused prompt to a nested model call.
// Nested calls inherit the model and a narrowed project tool surface. Recursive
// launch is on by default and bounded by root-shared finite subagentLimits. Tool authorization is
// still enforced by the normal gate. The result is returned as an ordinary tool
// result for the parent assistant to summarize or use. When the model emits
// several subagent calls in one turn, the tool loop runs them concurrently
// (see the parallel branch in src/ai.js).

// The description is assembled per turn: the sentence about nested delegation
// states the depth budget the turn actually runs with (subagentLimits.maxDepth),
// and with a budget of 1 it says that subagents cannot delegate.
const { DEFAULT_LIMITS, LIMIT_RANGES } = require('./subagent-orchestration.js');

const DESCRIPTION_HEAD = 'Delegate a focused analysis or planning task to a nested AI call (a subagent) that can use the project tools and MCP tools, with the normal permission prompts. Several subagent calls in one turn run in parallel. By default the call waits and returns the subagent\'s result. With background: true it returns a callId at once, so you can keep working and use subagent_status, subagent_messages, subagent_send and subagent_stop on it.';
const DESCRIPTION_HEAD_PERSISTENT = ' In this chat the callId stays valid in later turns: a background subagent still running when your turn ends keeps running and can be polled, steered or stopped from any later turn of the same chat.';
const DESCRIPTION_TAIL = ' For several subagents that depend on each other or split files between them, declare them first with subagent_group_create. Images are not passed on automatically: find them with list_chat_attachments and pass the chosen imageRef values in `images` (generated:<seq>:<i> refs select earlier subagent artwork to edit).';

function depthSentence(maxDepth) {
  if (maxDepth === 1) return ' Subagents cannot delegate further in this project (subagentLimits.maxDepth is 1).';
  return ' Subagents may delegate further, up to ' + maxDepth + ' levels deep in total (subagentLimits.maxDepth; an agent can set its own nesting limit).';
}

// describe(maxDepth, { persistent }) -> the tool description for a turn whose
// depth budget is `maxDepth`. With `persistent` (a chat-scoped scope whose
// background runs outlive the turn) the description says so; otherwise it
// keeps the turn-local wording. Anything that is not an integer in range
// reads as the default.
function describe(maxDepth, { persistent = false } = {}) {
  const depth = Number.isInteger(maxDepth) && maxDepth >= LIMIT_RANGES.maxDepth.min
    ? maxDepth : DEFAULT_LIMITS.maxDepth;
  return (persistent ? DESCRIPTION_HEAD + DESCRIPTION_HEAD_PERSISTENT : DESCRIPTION_HEAD)
    + depthSentence(depth) + DESCRIPTION_TAIL;
}

const BASE_DESCRIPTION = describe(DEFAULT_LIMITS.maxDepth);

const AGENT_DESCRIPTION = 'Optional: reuse a saved project agent (Settings → Project → Agents) with its own instructions, model and tool allowlist. Only for a listed saved agent: to make a subagent on the fly, omit `agent` and set `name` (and optionally `instructions`) instead. Omitting both runs the project\'s default subagent.';
const NAME_DESCRIPTION = 'Optional display name for this subagent (for example be-manager or api-reviewer), shown on its card, in subagent_status and in the Agents graph. It only labels the run: it saves nothing and does not pick a saved agent. Up to 64 characters.';
const INSTRUCTIONS_DESCRIPTION = 'Optional instructions for a subagent made on the fly (its role or persona, e.g. "You are the backend managing agent…"). They replace the default subagent\'s instructions for this run only and are not saved. Not allowed with `agent`, which brings its own instructions.';

const SPEC = {
  type: 'function',
  function: {
    name: 'subagent',
    description: BASE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The focused task or question for the subagent.' },
        background: { type: 'boolean', description: 'Return a callId at once instead of waiting for the result (default false). The callId and any handoffs are kept in the chat: in a turn-local scope they last only for the current turn (the subagent is cancelled if still running when the turn ends); on a chat\'s persistent scope they stay valid in later turns of the same chat until the run settles or is stopped.' },
        groupId: { type: 'string', description: 'groupId returned by subagent_group_create. Needs memberId and background: true.' },
        memberId: { type: 'string', description: 'Which declared member of the group this subagent is (needs groupId and background: true). It starts only after the members it dependsOn have succeeded.' },
        context: { type: 'string', description: 'Optional relevant context to include with the task.' },
        agent: { type: 'string', description: AGENT_DESCRIPTION },
        name: { type: 'string', maxLength: 64, description: NAME_DESCRIPTION },
        instructions: { type: 'string', description: INSTRUCTIONS_DESCRIPTION },
        images: {
        type: 'array', maxItems: 8, items: { type: 'string' },
        description: 'Only these current-chat imageRef values from list_chat_attachments are passed to the subagent. Omit or [] sends no images. No base64 or file paths; max 8 images, 24 MiB encoded total.'
        }
      },
      required: ['task'],
      additionalProperties: false
    }
  }
};

// buildSpec(agentNames, { maxDepth, persistent })
//
// Return the tool spec for one turn: the `agent` parameter description lists
// the project's currently-defined agent names, so the model sees exactly what
// it can pass, and the tool description states the turn's depth budget
// (`maxDepth`, default 3) and, with `persistent`, that background handles of
// this chat outlive the turn. With no agents and the default depth the shared
// SPEC is returned; otherwise a copy, never a mutation of SPEC.
function buildSpec(agentNames, { maxDepth, persistent } = {}) {
  const names = Array.isArray(agentNames) ? agentNames.filter(Boolean) : [];
  const description = describe(maxDepth, { persistent: !!persistent });
  if (!names.length && description === BASE_DESCRIPTION) return SPEC;
  const spec = JSON.parse(JSON.stringify(SPEC));
  spec.function.description = description;
  if (names.length) {
    spec.function.parameters.properties.agent.description =
      AGENT_DESCRIPTION + ' Available saved agents: ' + names.join(', ') + '.';
  }
  return spec;
}

module.exports = { SPEC, buildSpec, describe };
