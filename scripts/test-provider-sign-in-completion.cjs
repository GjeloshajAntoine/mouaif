'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { redirectMeta } = require('../src/server-shared.js');
const completion = { type: 'mouaif:oauth-complete', state: 'flow-state', account: 'existing@example.com' };
const html = redirectMeta('/', true, completion);
let received;
let closed = false;
vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
  window: { opener: { closed: false, postMessage: (data, origin) => { received = { data, origin }; } }, close: () => { closed = true; } },
  location: { origin: 'https://app.example', replace: () => assert.fail('unexpected redirect') }
});
assert.equal(JSON.stringify(received.data), JSON.stringify(completion));
assert.equal(received.origin, 'https://app.example');
assert.ok(closed);
assert.ok(!redirectMeta('/', true, { ...completion, account: '</script>' }).includes('"account":"</script>"'));
const source = fs.readFileSync('frontend/src/components/SettingsProviders.jsx', 'utf8');
const handler = source.match(/const onCompletion = \(event\) => \{([\s\S]*?)\n    \};/)[1];
const win = {};
const context = { window: { location: { origin: 'https://app.example' } }, win, r: { body: { state: 'flow-state' } }, completedAccount: '' };
for (const event of [
  { origin: 'https://evil.example', source: win, data: completion },
  { origin: 'https://app.example', source: {}, data: completion },
  { origin: 'https://app.example', source: win, data: { ...completion, state: 'other' } }
]) {
  const rejected = { ...context, event };
  vm.runInNewContext('(function(event){' + handler + '})(event)', rejected);
  assert.equal(rejected.completedAccount, '');
}
context.event = { origin: 'https://app.example', source: win, data: completion };
vm.runInNewContext('(function(event){' + handler + '})(event)', context);
assert.equal(context.completedAccount, completion.account);
assert.match(source, /setOauthAccountVal\(account\)/);
assert.match(source, /setOauthAccountVal\(st\.body\.account\)/);
console.log('Provider sign-in completion checks passed');
