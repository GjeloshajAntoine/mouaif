// mouaif web — pure retry restoration helpers
//
// Persisted stream failures are stored as system messages prefixed with
// the warning marker. These helpers identify those rows and recover the
// user turn immediately preceding the failure without depending on DOM.
// Row classification lives in messageKind.js.
import { messageKind } from './messageKind.js';

export function isPersistedTurnError(message) {
return messageKind(message) === 'error';
}

export function retryPayloadForError(messages, errorMessage) {
if (!Array.isArray(messages) || !isPersistedTurnError(errorMessage)) return null;
const errorIndex = messages.lastIndexOf(errorMessage);
if (errorIndex < 0) return null;
for (let i = errorIndex - 1; i >= 0; i--) {
const message = messages[i];
if (messageKind(message) !== 'user') continue;
return {
content: message.content || '',
attachments: Array.isArray(message.attachments) ? message.attachments : []
};
}
return null;
}
