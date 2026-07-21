'use strict';

// Native `subagent` tool — delegates a focused prompt to a nested model call.
// The nested call uses the same model and the same project tool surface (except
// subagent itself, to avoid recursive delegation loops). Tool authorization is
// still enforced by the normal gate. The result is returned as an ordinary tool
// result for the parent assistant to summarize or use. When the model emits
// several subagent calls in one turn, the tool loop runs them concurrently
// (see the parallel branch in src/ai.js).

const BASE_DESCRIPTION = 'Delegate a focused analysis or planning task to a nested AI call. The subagent can use the project tools and MCP tools, with normal authorization prompts. You may call subagent multiple times in a single turn; same-turn subagent calls run in parallel.';

const AGENT_DESCRIPTION = 'Optional project agent name (from Settings → Project → Agents) to use for this delegation.';

const SPEC = {
  type: 'function',
  function: {
    name: 'subagent',
    description: BASE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The focused task or question for the subagent.' },
        context: { type: 'string', description: 'Optional relevant context to include with the task.' },
        agent: { type: 'string', description: AGENT_DESCRIPTION }
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
