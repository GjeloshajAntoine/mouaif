'use strict';

// Native `subagent` tool — delegates a focused prompt to a nested model call.
// The nested call uses the same model and the same project tool surface (except
// subagent itself, to avoid recursive delegation loops). Tool authorization is
// still enforced by the normal gate. The result is returned as an ordinary tool
// result for the parent assistant to summarize or use. When the model emits
// several subagent calls in one turn, the tool loop runs them concurrently
// (see the parallel branch in src/ai.js).

const SPEC = {
  type: 'function',
  function: {
    name: 'subagent',
    description: 'Delegate a focused analysis or planning task to a nested AI call. The subagent can use the project tools and MCP tools, with normal authorization prompts. You may call subagent multiple times in a single turn; same-turn subagent calls run in parallel.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The focused task or question for the subagent.' },
        context: { type: 'string', description: 'Optional relevant context to include with the task.' },
        agent: { type: 'string', description: 'Optional project agent name from .agents/agents/<name>/AGENT.md to use for this delegation.' }
      },
      required: ['task'],
      additionalProperties: false
    }
  }
};

module.exports = { SPEC };
