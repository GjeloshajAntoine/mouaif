'use strict';

// Native `ask_user` tool — lets the model pause and ask the user a
// structured question during a chat. The model provides a question
// text and a list of options (2 or more, no upper bound — the UI
// scrolls long lists); the user picks one and may always add a
// free-form "extra answer" alongside their pick. The selection +
// extra text is returned to the model as a single tool result.
//
// Implements docs/features/ask-user-tool.md.
//
// Design notes:
//   - This tool *always* prompts. The authorization module's
//     `ask_user` mode is treated specially: it is binary
//     `off` / `ask`. There is no allowlist (the model can't predict
//     user answers) and no `allow` mode (the user must always be
//     the source of truth). `off` returns ETOOL_DISABLED.
//   - The runner is the simplest possible: it returns the structured
//     payload to the caller. The actual user interaction rides the
//     existing `authorization_required` SSE event, augmented with
//     `question` / `options` / `multiSelect` fields the chat UI
//     renders as an answer card. The authorization module's wait()
//     resolves with the user's { choice, extra } so the dispatcher
//     can fold both into the `tool` message.
//   - No new runtime dependencies. The runner is a plain function
//     that returns the result; the chat UI handles the input side.

const MAX_QUESTION_CHARS = 500;
const MAX_OPTION_CHARS = 120;
const MAX_EXTRA_CHARS = 1000;

const SPEC = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: 'Ask the user a structured question with options. The user picks one option and may always add a free-form "extra" note to clarify or elaborate.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user.' },
        options: {
          type: 'array',
          description: 'Answer options (2 or more). Label is shown to the user; value is returned as the choice.',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              description: { type: 'string', description: 'Optional hint shown under the label.' }
            },
            required: ['label', 'value'],
            additionalProperties: false
          }
        },
        multiSelect: { type: 'boolean', description: 'When true, the user may pick multiple options.' }
      },
      required: ['question', 'options'],
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

// Build the validated payload the chat UI renders. Throws a typed
// EBADINPUT on the first violation so the tool_result forwarded to
// the model explains what was wrong.
function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    const e = new Error('args is required'); e.code = 'EBADINPUT'; throw e;
  }
  const question = trimString(args.question, MAX_QUESTION_CHARS);
  if (!question) {
    const e = new Error('question is required'); e.code = 'EBADINPUT'; throw e;
  }
  const rawOptions = Array.isArray(args.options) ? args.options : null;
  if (!rawOptions || rawOptions.length < 2) {
    const e = new Error('at least 2 options are required'); e.code = 'EBADINPUT'; throw e;
  }
  const seenValues = new Set();
  const options = [];
  for (let i = 0; i < rawOptions.length; i++) {
    const raw = rawOptions[i];
    if (!raw || typeof raw !== 'object') {
      const e = new Error('option ' + i + ' must be an object'); e.code = 'EBADINPUT'; throw e;
    }
    const label = trimString(raw.label, MAX_OPTION_CHARS);
    const value = trimString(raw.value, MAX_OPTION_CHARS);
    if (!label) { const e = new Error('option ' + i + '.label is required'); e.code = 'EBADINPUT'; throw e; }
    if (!value) { const e = new Error('option ' + i + '.value is required'); e.code = 'EBADINPUT'; throw e; }
    if (seenValues.has(value)) {
      const e = new Error('option ' + i + '.value duplicates an earlier option'); e.code = 'EBADINPUT'; throw e;
    }
    seenValues.add(value);
    options.push({
      label,
      value,
      description: trimString(raw.description, MAX_OPTION_CHARS) || ''
    });
  }
  const multiSelect = args.multiSelect === true;
  return { question, options, multiSelect };
}

// Shape the runner result. `cancelled: true` means the user picked
// "Dismiss" or otherwise refused to answer; the model still receives
// a tool result, so the loop can continue with a sensible default.
function buildResult({ choice, extra, options, multiSelect, cancelled }) {
  const result = {
    answered: !cancelled,
    choice: Array.isArray(choice) ? choice.slice() : (choice || ''),
    extra: typeof extra === 'string' ? extra : '',
    options: (options || []).map((o) => ({ label: o.label, value: o.value })),
    multiSelect: !!multiSelect,
    cancelled: !!cancelled
  };
  return { ok: !cancelled, content: JSON.stringify(result), result };
}

// Truncate the user's free-form answer. Returns the empty string
// when missing. Pure; safe to call on the model side too.
function clampExtra(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (s.length <= MAX_EXTRA_CHARS) return s;
  return s.slice(0, MAX_EXTRA_CHARS);
}

module.exports = {
  SPEC,
  validateArgs,
  buildResult,
  clampExtra,
  MAX_QUESTION_CHARS,
  MAX_OPTION_CHARS,
  MAX_EXTRA_CHARS
};
