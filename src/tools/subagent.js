'use strict';

// Native `subagent` tool — delegates a focused prompt to a nested model call.
// The nested call uses the same model and the same project tool surface (except
// subagent itself, to avoid recursive delegation loops). Tool authorization is
// still enforced by the normal gate. The result is returned as an ordinary tool
// result for the parent assistant to summarize or use. When the model emits
// several subagent calls in one turn, the tool loop runs them concurrently
// (see the parallel branch in src/ai.js).

const BASE_DESCRIPTION = 'Delegate a focused analysis or planning task to a nested AI call. The subagent can use the project tools and MCP tools, with normal authorization prompts. You may call subagent multiple times in a single turn; same-turn subagent calls run in parallel. Set background:true to get a turn-scoped handle and steer with subagent_send and observe with subagent_messages/status/stop; unfinished children are cancelled when the parent turn ends. Images are never inherited automatically; use images with selected imageRef values from list_chat_attachments (including generated:<seq>:<i> refs for earlier subagent artwork you want edited).';

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
        background: { type: 'boolean', description: 'Opt in to a background handle so the parent can steer/poll while this child runs. Default false (wait for result). Handles and handoffs expire with this parent turn; unfinished children are cancelled when it ends.' },
        groupId: { type: 'string', description: 'Parent-created group handle; requires memberId and background:true.' },
        memberId: { type: 'string', description: 'Declared group member; dispatch waits for successful dependencies.' },
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
