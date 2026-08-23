'use strict';
// Native restart_app tool. It schedules the same graceful worker relaunch as
// POST /api/restart, without making an authenticated loopback HTTP request.
const { requestRestart } = require('../restart.js');

const SPEC = {
  type: 'function',
  function: {
    name: 'restart_app',
    description: 'Gracefully restart the mouaif app from this chat without stopping its supervisor. Use when the user asks to restart, reload, or apply server-side code changes. The current response is saved before the worker relaunches.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the restart.' }
      },
      additionalProperties: false
    }
  }
};

function runRestart(args, options = {}) {
  const result = requestRestart({
    lifecycle: options.lifecycle,
    reason: args && args.reason,
    // Leave enough time for tool_result and the chat stream to flush and save.
    delayMs: 1000,
    defaultDelayMs: 1000
  });
  return { ok: !!result.ok, content: JSON.stringify(result), result };
}

module.exports = { SPEC, runRestart };
