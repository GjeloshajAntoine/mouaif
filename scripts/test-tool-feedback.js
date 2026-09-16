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
const previewResult = { ok: true, url: 'https://example.com/', thumbnail: imageData };
const previewHistory = messages.reconstructUpstreamHistory([
  { role: 'tool', phase: 'call', toolCallId: 'call_preview', name: 'webpreview', args: { url: previewResult.url }, content: '{}' },
  { role: 'tool', phase: 'result', toolCallId: 'call_preview', name: 'webpreview', ok: true, content: JSON.stringify(previewResult) }
]);
check('historical user preview is omitted', previewHistory[1] && !previewHistory[1].content.includes('A'.repeat(100)), previewHistory[1] && previewHistory[1].content.slice(0, 200));
check('historical user preview has an omission marker', previewHistory[1] && previewHistory[1].content.includes('user preview image omitted'), previewHistory[1] && previewHistory[1].content);

// ---- toolOutput profile (size + structure) ------------------------------
const bigJson = JSON.stringify({ ok: true, items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: 'item ' + i, data: 'x'.repeat(100) })) }, null, 2);
const base = 262144;
const avgOut = feedback.compactToolFeedback({ name: 'shell', content: bigJson, maxBytes: base, toolOutput: { size: 'average', structure: 'full' } });
check('average size caps at base', Buffer.byteLength(avgOut, 'utf8') <= base, String(Buffer.byteLength(avgOut, 'utf8')));
const vsOut = feedback.compactToolFeedback({ name: 'shell', content: 'x'.repeat(base * 2), maxBytes: base, toolOutput: { size: 'very-small', structure: 'full' } });
check('very-small caps at base/4', Buffer.byteLength(vsOut, 'utf8') <= Math.floor(base / 4) + 8, String(Buffer.byteLength(vsOut, 'utf8')));
const fullOut = feedback.compactToolFeedback({ name: 'shell', content: 'z'.repeat(base * 6), maxBytes: base, toolOutput: { size: 'full', structure: 'full' } });
check('full size caps at 4x base', Buffer.byteLength(fullOut, 'utf8') <= base * 4, String(Buffer.byteLength(fullOut, 'utf8')));
check('full size still truncates oversized output', /tool feedback truncated/.test(fullOut), fullOut.slice(0, 120));
const extOut = feedback.compactToolFeedback({ name: 'shell', content: 'y'.repeat(60000), maxBytes: base, toolOutput: { size: 'extensive', structure: 'full' } });
check('extensive never truncates', extOut.length === 60000, String(extOut.length));
const rawLong = 'HEAD\n\n\n  mid\n\nTAIL';
const conciseOut = feedback.compactToolFeedback({ name: 'shell', content: rawLong, maxBytes: base, toolOutput: { size: 'average', structure: 'concise' } });
check('concise collapses blank runs', !conciseOut.includes('\n\n\n'), conciseOut);
check('concise minifies json', feedback.compactToolFeedback({ name: 'shell', content: bigJson, maxBytes: base, toolOutput: { size: 'average', structure: 'concise' } }).length < bigJson.length);
check('resolveToolOutput defaults', feedback.resolveToolOutput(undefined).size === 'average' && feedback.resolveToolOutput(undefined).structure === 'tree');
check('invalid structure normalizes to tree', feedback.resolveToolOutput({ structure: 'nope' }).structure === 'tree');
check('legacy grouped normalizes to tree', feedback.resolveToolOutput({ structure: 'grouped' }).structure === 'tree');
check('file structures are json + tree only', feedback.FILE_STRUCTURES.join(',') === 'json,tree', feedback.FILE_STRUCTURES.join(','));
check('history honors toolOutput', messages.reconstructUpstreamHistory([
  { role: 'tool', phase: 'call', toolCallId: 'call_to', name: 'shell', args: {}, content: '{}' },
  { role: 'tool', phase: 'result', toolCallId: 'call_to', name: 'shell', ok: true, content: bigJson }
], null, { maxBytes: undefined, toolOutput: { size: 'average', structure: 'concise' } })[1].content.length < bigJson.length);

console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
process.exit(failed ? 1 : 0);
