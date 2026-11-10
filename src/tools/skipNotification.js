'use strict';

// skip_notification — lets a recurring task's run finish without notifying.
//
// Each run of a recurring task notifies every subscribed device when it
// completes. A run that found nothing worth reporting calls this tool and the
// server leaves that completion push out. Everything else is unchanged: the run
// stays in the chat, and errors, questions and tool approvals still notify.
//
// The tool belongs to the turn, not to the project: ai-stream.js offers it only
// in a turn a recurring task started (`opts.scheduledRun`), never to a nested
// subagent, and runs it without an approval card (a card would itself notify).
// The decision is read when the turn ends (server-handlers-chats.js), so the
// call has no effect of its own beyond its tool_result event.

const NAME = 'skip_notification';

const SPEC = Object.freeze({ type: 'function', function: {
  name: NAME,
  description: 'This turn is a run of a recurring task, and the user is notified when it finishes. If this run found nothing relevant (nothing new, nothing the task asks to be told about), call this tool so the run finishes without a notification. The run stays in the chat either way. Call it once you know the result, not before; if you do not call it, the user is notified as usual. Errors, questions and approvals still notify.',
  parameters: { type: 'object', properties: {
    reason: { type: 'string', description: 'Optional: why there is nothing to report, in a few words (e.g. "no new alerts").' }
  }, required: [], additionalProperties: false } } });

// run(args) -> { ok, content, result }
function run(args) {
  const reason = args && typeof args.reason === 'string' ? args.reason.trim().slice(0, 200) : '';
  const result = { ok: true, notification: 'skipped', ...(reason ? { reason } : {}) };
  return { ok: true, content: JSON.stringify(result), result };
}

module.exports = { NAME, SPEC, run };
