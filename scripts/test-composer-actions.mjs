// Regression tests for Enter dispatch of complete custom @ actions.
global.document = {
addEventListener() {},
removeEventListener() {}
};

const { onComposerKey } = await import('../frontend/src/components/chat/composer.js');
let sends = 0;
function event(value, overrides = {}) {
return Object.assign({
key: 'Enter',
ctrlKey: false,
metaKey: false,
shiftKey: false,
isComposing: false,
currentTarget: { value },
preventDefault() { this.prevented = true; }
}, overrides);
}
function test(name, condition, actual) {
if (condition) console.log('  ok  - ' + name);
else {
console.log('  FAIL- ' + name + ' :: ' + JSON.stringify(actual));
process.exitCode = 1;
}
}

const actions = [{ id: 'test' }];
let e = event('@test ');
onComposerKey(e, () => { sends++; }, { enterForNewline: true, customActions: actions });
test('Enter sends a complete custom action in newline mode', sends === 1 && e.prevented, { sends, prevented: e.prevented });

e = event('@test extra');
onComposerKey(e, () => { sends++; }, { enterForNewline: true, customActions: actions });
test('Enter keeps newline behavior when action has ad-hoc args', sends === 1 && !e.prevented, { sends, prevented: e.prevented });

e = event('@test ', { shiftKey: true });
onComposerKey(e, () => { sends++; }, { enterForNewline: true, customActions: actions });
test('Shift+Enter keeps newline behavior for an action', sends === 1 && !e.prevented, { sends, prevented: e.prevented });

e = event('@restart_app apply fix');
onComposerKey(e, () => { sends++; }, { enterForNewline: true, customActions: actions });
test('Enter sends an explicit restart command in newline mode', sends === 2 && e.prevented, { sends, prevented: e.prevented });

console.log(process.exitCode ? '\ncomposer action tests failed' : '\n4 passed, 0 failed');
