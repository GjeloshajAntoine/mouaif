import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Load the real input component without a browser; inspect its Preact VNodes.
const source = await readFile(new URL('../frontend/src/components/settings/McpArguments.jsx', import.meta.url), 'utf8');
const transformed = await transform(source.replace("import { h } from 'preact';", 'const h = (type, props, ...children) => ({ type, props, children });'), { loader: 'jsx', format: 'esm' });
const { McpArguments } = await import('data:text/javascript;base64,' + Buffer.from(transformed.code).toString('base64'));
const values = ['/tmp/path with spaces/server.js', '', '  padded  ', 'C:\\Program Files\\tool', '"literal"', 'line\nbreak'];
let saved;
const tree = McpArguments({ value: values, onChange: (next) => { saved = next; } });
const nodes = (node) => typeof node !== 'object' || !node ? [] : [node, ...(node.children || []).flat(Infinity).flatMap(nodes)];
const all = nodes(tree);
assert.deepEqual(all.filter(n => n.type === 'input').map(n => n.props.value), values);
all.find(n => n.type === 'input').props.onInput({ target: { value: 'new path with spaces' } });
assert.deepEqual(saved, ['new path with spaces', ...values.slice(1)]);
all.find(n => n.props?.['aria-label'] === 'Remove argument 2').props.onClick();
assert.deepEqual(saved, values.filter((_, i) => i !== 1));
all.find(n => n.children?.includes('Add argument')).props.onClick();
assert.deepEqual(saved, [...values, '']);
const editor = await readFile(new URL('../frontend/src/components/SettingsMcpEdit.jsx', import.meta.url), 'utf8');
assert.match(editor, /setArgs\(current.args \|\| \[\]\)/);
assert.match(editor, /args: transport === 'stdio' \? args : \[\]/);
assert.doesNotMatch(editor, /parseArgs|\.join\(' '\)/);
console.log('MCP arguments: exact values, edit, add, remove, and editor round-trip passed');
