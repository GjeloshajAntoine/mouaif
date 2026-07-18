'use strict';

// Native `subagent` tool — delegates a focused prompt to a nested model call.
// The nested call uses the same model but is advertised no tools, so it cannot
// recursively call tools or mutate the project. The result is returned as an
// ordinary tool result for the parent assistant to summarize or use.

const SPEC = {
  type: 'function',
  function: {
    name: 'subagent',
    description: 'Delegate a focused analysis or planning task to a nested AI call. The subagent has no tools and returns only text.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The focused task or question for the subagent.' },
        context: { type: 'string', description: 'Optional relevant context to include with the task.' }
      },
      required: ['task'],
      additionalProperties: false
    }
  }
};

module.exports = { SPEC };
