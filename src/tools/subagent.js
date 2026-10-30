'use strict';

// Native `subagent` tool — delegates a focused prompt to a nested model call.
// Nested calls inherit the model and a narrowed project tool surface. Recursive
// launch is on by default and bounded by root-shared finite subagentLimits. Tool authorization is
// still enforced by the normal gate. The result is returned as an ordinary tool
// result for the parent assistant to summarize or use. When the model emits
// several subagent calls in one turn, the tool loop runs them concurrently
// (see the parallel branch in src/ai.js).

const BASE_DESCRIPTION = 'Delegate a focused analysis or planning task to a nested AI call (a subagent) that can use the project tools and MCP tools, with the normal permission prompts. Several subagent calls in one turn run in parallel. By default the call waits and returns the subagent\'s result. With background: true it returns a callId at once, so you can keep working and use subagent_status, subagent_messages, subagent_send and subagent_stop on it; a background subagent still running when your turn ends is cancelled. Subagents may delegate further, up to subagentLimits.maxDepth levels (default 3), and the whole tree shares one budget of runs. For several subagents that depend on each other or split files between them, declare them first with subagent_group_create. Images are not passed on automatically: find them with list_chat_attachments and pass the chosen imageRef values in `images` (generated:<seq>:<i> refs select earlier subagent artwork to edit).';

const AGENT_DESCRIPTION = 'Optional project agent name (from Settings → Project → Agents) to use for this delegation. Omit it to use the project\'s default subagent.';

const SPEC = {
  type: 'function',
  function: {
    name: 'subagent',
    description: BASE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The focused task or question for the subagent.' },
        background: { type: 'boolean', description: 'Return a callId at once instead of waiting for the result (default false). The callId and any handoffs last only for your current turn; the subagent is cancelled if it is still running when the turn ends.' },
        groupId: { type: 'string', description: 'groupId returned by subagent_group_create. Needs memberId and background: true.' },
        memberId: { type: 'string', description: 'Which declared member of the group this subagent is (needs groupId and background: true). It starts only after the members it dependsOn have succeeded.' },
        context: { type: 'string', description: 'Optional relevant context to include with the task.' },
        agent: { type: 'string', description: AGENT_DESCRIPTION },
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

// buildSpec(agentNames)
//
// Return the tool spec with the `agent` parameter description listing
// the project's currently-defined agent names, so the model sees
// exactly what it can pass. With no agents the base spec is returned.
function buildSpec(agentNames) {
  const names = Array.isArray(agentNames) ? agentNames.filter(Boolean) : [];
  if (!names.length) return SPEC;
  const spec = JSON.parse(JSON.stringify(SPEC));
  spec.function.parameters.properties.agent.description =
    AGENT_DESCRIPTION + ' Available agents: ' + names.join(', ') + '.';
  return spec;
}

module.exports = { SPEC, buildSpec };
