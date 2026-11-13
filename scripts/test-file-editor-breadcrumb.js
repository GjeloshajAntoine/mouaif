'use strict';

// Exercise the real breadcrumb renderer without loading CodeMirror or a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/src/components/FileEditor.jsx', 'utf8');
const start = source.indexOf('  function renderBreadcrumb() {');
const end = source.indexOf('\n  // One layout toggle', start);
assert.ok(start >= 0 && end > start, 'breadcrumb renderer exists');

for (const base of ['/home/user', '/']) {
  const current = base === '/' ? '/home/user/project/src' : base + '/project/src';
  const visited = [];
  const context = {
    browseTop: base, projectDir: '/home/user/project',
    currentDir: { current }, isArtifact: () => false,
    loadDir: (path) => visited.push(path),
    Fragment: 'fragment',
    h: (type, props, ...children) => ({ type, props, children })
  };
  const tree = vm.runInNewContext(source.slice(start, end) + '\nrenderBreadcrumb();', context);
  const buttons = tree.children[0].filter((item) => item.type === 'button');
  for (const button of buttons) button.props.onClick();
  const expected = base === '/'
    ? ['/', '/home', '/home/user', '/home/user/project', current]
    : [base, base + '/project', current];
  assert.deepEqual(visited, expected, 'each crumb navigates to its own ancestor from ' + base);
}
console.log('File editor breadcrumb navigation passed');
