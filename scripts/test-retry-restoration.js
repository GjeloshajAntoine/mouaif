// Unit test for retry payload restoration after reopening a chat.
'use strict';
let pass = 0;
let fail = 0;
function t(name, condition, detail) {
if (condition) { pass++; console.log('  ok  - ' + name); }
else { fail++; console.log('  FAIL- ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}
async function run() {
const { isPersistedTurnError, retryPayloadForError } = await import(
'../frontend/src/components/chat/retry.js'
);
const attachment = { type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
const user = { role: 'user', content: 'please retry this', attachments: [attachment], seq: 3 };
const partial = { role: 'assistant', content: 'partial reply', seq: 4 };
const error = { role: 'system', content: '⚠ EUPSTREAM: rate limited', seq: 5 };
const messages = [user, partial, error];
t('persisted warning system row is an error', isPersistedTurnError(error));
t('ordinary system row is not an error', !isPersistedTurnError({ role: 'system', content: 'context' }));
const payload = retryPayloadForError(messages, error);
t('preceding user content is restored', payload && payload.content === user.content, payload);
t('preceding user attachments are restored', payload && payload.attachments[0] === attachment, payload);
t('non-error rows have no retry payload', retryPayloadForError(messages, partial) === null);
t('error without a preceding user has no retry payload', retryPayloadForError([error], error) === null);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
