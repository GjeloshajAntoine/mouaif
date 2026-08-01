'use strict';

// Non-streaming convenience wrapper over the streaming core.
// Used by tests and one-shot callers that want a plain `text`
// result instead of handling SSE events themselves.

const { streamChat } = require('./ai-stream.js');

async function chat(model, messages, opts) {
  const events = [];
  const r = await streamChat({
    model, messages,
    signal: opts && opts.signal,
    onEvent: (name, data) => events.push({ name, data })
  });
  let text = '';
  for (const e of events) if (e.name === 'message' && e.data && typeof e.data.delta === 'string') text += e.data.delta;
  return Object.assign({ text }, r);
}

module.exports = { chat };
