'use strict';

// Native `report_progress` tool — lets the model report real-time
// progress on a long-running operation. The tool call itself is a
// no-op for the server (it just validates args and returns the
// structured data), but the dispatch loop emits a `progress_update`
// SSE event so the frontend can show a live progress bar.
//
// The model calls this periodically with { title, current, total,
// status, message } and the frontend renders a progress bar
// notification.

const MAX_TITLE_CHARS = 120;
const MAX_MESSAGE_CHARS = 500;

const SPEC = {
  type: 'function',
  function: {
    name: 'report_progress',
    description: 'Show the user a live progress bar for one long-running operation (a build, a batch of files). Call it as the work advances and once more with status completed or failed. To track several named pieces of work across turns, use task instead.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short description of the operation (e.g. "Building project")' },
        current: { type: 'number', description: 'Units done so far, from 0 to total.' },
        total: { type: 'number', description: 'Total units of work.' },
        status: { type: 'string', enum: ['running', 'completed', 'failed'], description: 'Status of the operation (default running).' },
        message: { type: 'string', description: 'Optional status message shown below the progress bar' }
      },
      required: ['title', 'current', 'total'],
      additionalProperties: false
    }
  }
};

function trimString(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    const e = new Error('args is required'); e.code = 'EBADINPUT'; throw e;
  }
  const title = trimString(args.title, MAX_TITLE_CHARS);
  if (!title) {
    const e = new Error('title is required'); e.code = 'EBADINPUT'; throw e;
  }
  const current = Number.isFinite(args.current) ? Math.round(args.current) : 0;
  const total = Number.isFinite(args.total) ? Math.round(args.total) : 100;
  if (total <= 0) {
    const e = new Error('total must be positive'); e.code = 'EBADINPUT'; throw e;
  }
  const status = (args.status === 'completed' || args.status === 'failed') ? args.status : 'running';
  const message = trimString(args.message, MAX_MESSAGE_CHARS);
  return { title, current: Math.min(total, Math.max(0, current)), total, status, message };
}

function buildResult(args) {
  return { ok: true, content: JSON.stringify(args), result: args };
}

module.exports = {
  SPEC,
  validateArgs,
  buildResult,
  MAX_TITLE_CHARS,
  MAX_MESSAGE_CHARS
};