import assert from 'node:assert/strict';
import { formatReadableToolResult } from '../frontend/src/components/chat/tools.js';
import { approvalTitle, approvalText, permissionExplanation } from '../frontend/src/components/chat/approvalDetails.js';
import { TOOL_CASES } from './chat-view-mockup/fixtures.js';
for (const test of TOOL_CASES) {
  const request = { tool: test.name, details: { args: test.args } };
  assert.ok(approvalTitle(request).length > 0, test.name);
  assert.ok(approvalText(request).length > 0, test.name);
}
const nested = { scope: 'project', settings: { apiKey: 'hidden-key', accessToken: 'private-token', promptSize: 'average' }, models: [{ id: 'model-1' }] };
const output = formatReadableToolResult(nested);
assert.match(output, /promptSize/); assert.match(output, /model-1/);
assert.ok(!output.includes('hidden-key') && !output.includes('private-token'));
assert.match(formatReadableToolResult({ items: ['useful result'] }), /useful result/);
assert.equal(formatReadableToolResult(false), 'false');
assert.match(formatReadableToolResult({ text: 'Summary', items: ['retained detail'] }, true), /retained detail/);
const cycle = {}; cycle.self = cycle;
assert.match(formatReadableToolResult(cycle), /circular/);
assert.ok(formatReadableToolResult({ values: Array.from({ length: 1000 }, () => 'x'.repeat(100000)) }).length < 100000,
  'structured output has a total string budget');
const approval = approvalText({ tool: 'update_settings', details: { args: { patch: { apiKey: 'hide-me', nested: { token: 'secret-token' } } }, before: { password: 'old-secret' } } });
assert.ok(!/hide-me|secret-token|old-secret/.test(approval));
assert.match(approvalTitle({ tool: 'group_edit', details: { args: { edits: [{}, {}] } } }), /2/);
assert.match(permissionExplanation({ tool: 'read_file', details: { permissionScope: ['read_file', 'write_file'] } }), /write_file/);
assert.match(approvalText({ tool: 'delete_chat', details: { targetChat: { id: 'id1', title: 'Target title' } } }), /Target title/);
console.log('PASS all-tool action titles, readable nested data, bounded/circular results, redacted settings, counts, and exact permission scope');
