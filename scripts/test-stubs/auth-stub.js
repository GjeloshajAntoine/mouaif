'use strict';
// Test stub for src/auth.js. See scripts/test-oauth-refresh.js.
let _stub = {};
function setStub(s) { _stub = s; }
function getStub() { return _stub; }
module.exports = new Proxy({}, {
  get(_t, key) {
    if (key === 'setStub') return setStub;
    if (key === 'getStub') return getStub;
    const s = getStub();
    if (s && key in s) return s[key];
    return undefined;
  }
});
