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
    description: 'Report real-time progress on a long-running operation. Call this periodically to show a progress bar on the frontend.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short description of the operation (e.g. "Building project")' },
        current: { type: 'number', description: 'Current progress value (0-based)' },
        total: { type: 'number', description: 'Maximum progress value' },
        status: { type: 'string', enum: ['running', 'completed', 'failed'], description: 'Current status of the operation' },
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
  return { title, current: Math.max(0, current), total, status, message };
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