'use strict';

const feedback = require('../src/toolFeedback.js');
const messages = require('../src/messages.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

const small = 'short result';
check('small result is unchanged', feedback.compactToolFeedback({ name: 'shell', content: small }) === small);

const huge = 'HEAD-' + 'x'.repeat(10000) + '-TAIL';
const truncated = feedback.compactToolFeedback({ name: 'shell', content: huge, maxBytes: 4096 });
check('large result fits byte cap', Buffer.byteLength(truncated, 'utf8') <= 4096, String(Buffer.byteLength(truncated, 'utf8')));
check('large result keeps head', truncated.startsWith('HEAD-'));
check('large result keeps tail', truncated.endsWith('-TAIL'));
check('large result marks truncation', /tool feedback truncated/.test(truncated));

const unicode = 'début-' + '🙂'.repeat(3000) + '-fin';
const unicodeOut = feedback.compactToolFeedback({ name: 'read_file', content: unicode, maxBytes: 4096 });
check('unicode result fits byte cap', Buffer.byteLength(unicodeOut, 'utf8') <= 4096, String(Buffer.byteLength(unicodeOut, 'utf8')));
check('unicode result has no replacement character', !unicodeOut.includes('\uFFFD'));
check('unicode result keeps both ends', unicodeOut.startsWith('début-') && unicodeOut.endsWith('-fin'));

const richSubagent = {
  ok: true,
  text: 'Focused final answer.',
  chat: [{ role: 'tool', content: 'z'.repeat(10000) }],
  toolEvents: [{ name: 'tool_result', data: { content: 'z'.repeat(10000) } }],
  usage: { promptTokens: 123, completionTokens: 45 },
  providerCost: 1.23
};
const subagentOut = feedback.compactToolFeedback({
  name: 'subagent',
  result: richSubagent,
  content: JSON.stringify(richSubagent)
});
const parsedSubagent = JSON.parse(subagentOut);
check('subagent model feedback keeps final text', parsedSubagent.text === 'Focused final answer.', subagentOut);
check('subagent model feedback omits nested chat', !Object.hasOwn(parsedSubagent, 'chat'), subagentOut);
check('subagent model feedback omits tool events', !Object.hasOwn(parsedSubagent, 'toolEvents'), subagentOut);
check('subagent rich result is not mutated', richSubagent.chat[0].content.length === 10000);

const imageData = 'data:image/png;base64,' + 'A'.repeat(10000);
const imageResult = { content: [{ type: 'image', data: imageData, mimeType: 'image/png' }] };
const imageOut = feedback.compactToolFeedback({ name: 'mcp__browser__screenshot', result: imageResult, content: JSON.stringify(imageResult) });
check('image payload omitted from model text', !imageOut.includes('A'.repeat(100)), imageOut.slice(0, 200));
check('image omission marker is present', imageOut.includes('image payload omitted'), imageOut);
check('image rich result is not mutated', imageResult.content[0].data === imageData);

const history = messages.reconstructUpstreamHistory([
  { role: 'tool', phase: 'call', toolCallId: 'call_1', name: 'subagent', args: { task: 'x' }, content: '{}' },
  { role: 'tool', phase: 'result', toolCallId: 'call_1', name: 'subagent', ok: true, content: JSON.stringify(richSubagent) },
  { role: 'tool', phase: 'call', toolCallId: 'call_2', name: 'shell', args: { cmd: 'x' }, content: '{}' },
  { role: 'tool', phase: 'result', toolCallId: 'call_2', name: 'shell', ok: true, content: huge }
], null, { toolFeedbackMaxBytes: 4096 });
check('history keeps complete tool pairs', history.length === 4, JSON.stringify(history));
check('history compacts stored subagent result', history[1] && !history[1].content.includes('toolEvents'), history[1] && history[1].content);
check('history caps stored generic tool result', history[3] && Buffer.byteLength(history[3].content, 'utf8') <= 4096, history[3] && String(Buffer.byteLength(history[3].content, 'utf8')));

const imageHistory = messages.reconstructUpstreamHistory([
  { role: 'tool', phase: 'call', toolCallId: 'call_img', name: 'mcp__browser__screenshot', args: {}, content: '{}' },
  { role: 'tool', phase: 'result', toolCallId: 'call_img', name: 'mcp__browser__screenshot', ok: true, content: JSON.stringify(imageResult) }
]);
check('historical image payload is omitted', imageHistory[1] && !imageHistory[1].content.includes('A'.repeat(100)), imageHistory[1] && imageHistory[1].content.slice(0, 200));
check('historical image omission marker is present', imageHistory[1] && imageHistory[1].content.includes('image payload omitted'), imageHistory[1] && imageHistory[1].content);

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
process.exit(failed ? 1 : 0);
