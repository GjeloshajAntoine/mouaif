// mouaif web — pure retry restoration helpers
//
// Persisted stream failures are stored as system messages prefixed with
// the warning marker. These helpers identify those rows and recover the
// user turn immediately preceding the failure without depending on DOM.
export function isPersistedTurnError(message) {
return !!message
&& message.role === 'system'
&& /^⚠(?:\s|$)/.test(String(message.content || ''));
}

export function retryPayloadForError(messages, errorMessage) {
if (!Array.isArray(messages) || !isPersistedTurnError(errorMessage)) return null;
const errorIndex = messages.lastIndexOf(errorMessage);
if (errorIndex < 0) return null;
for (let i = errorIndex - 1; i >= 0; i--) {
const message = messages[i];
if (!message || message.role !== 'user') continue;
return {
content: message.content || '',
attachments: Array.isArray(message.attachments) ? message.attachments : []
};
}
return null;
}
