import { schemaExample, schemaJson } from '../frontend/src/components/settings/actionSchema.js';
import assert from 'node:assert/strict';
const schema = {
type: 'object',
properties: {
query: { type: 'string', default: 'open' },
limit: { type: 'integer' },
enabled: { type: 'boolean' },
labels: { type: 'array', items: { type: 'string' } },
options: {
type: 'object',
properties: {
mode: { type: 'string', enum: ['fast', 'full'] },
note: { type: 'string', examples: ['review'] }
}
}
}
};
assert.deepEqual(schemaExample(schema), {
query: 'open',
limit: 0,
enabled: false,
labels: [],
options: { mode: 'fast', note: 'review' }
});
assert.equal(schemaJson({ type: 'object', properties: { path: { type: 'string' } } }), '{\n  "path": ""\n}');
assert.deepEqual(schemaExample({ oneOf: [{ type: 'number', default: 3 }, { type: 'string' }] }), 3);
assert.deepEqual(schemaExample(null), null);
console.log('custom action schema: ok');
