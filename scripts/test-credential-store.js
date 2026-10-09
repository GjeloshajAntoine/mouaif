'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-credentials-'));
process.env.MOUAIF_HOME = home;
const legacy = new Map();
let legacyReads = 0;
const keyringPath = require.resolve('@napi-rs/keyring');
require.cache[keyringPath] = { id: keyringPath, filename: keyringPath, loaded: true, exports: {
  Entry: class {
    constructor(service, account) { this.key = service + '/' + account; }
    getPassword() {
    legacyReads++;
    if (!legacy.has(this.key)) throw new Error('KeyRevoked');
    const value = legacy.get(this.key);
    return typeof value === 'function' ? value() : value;
    }
    setPassword() { throw new Error('new credentials must not use the keychain'); }
    deletePassword() { throw new Error('legacy credentials must be preserved'); }
  }
} };
const settings = require('../src/settings.js');
const store = require('../src/credentialStore.js');
const auth = require('../src/auth.js');
const oauth = require('../src/oauth-mcp.js');

(async () => {
  try {
    await auth.setToken('codex', 'account', 'DB_TOKEN');
    assert.equal(legacyReads, 0, 'new sign-in needs no keychain');
    assert.equal(auth.getToken('codex', 'account'), 'DB_TOKEN');
    assert.equal(auth.getToken('anthropic', 'account'), null, 'provider namespaces remain isolated');
    assert.deepEqual(auth.listAccounts().codex, ['account']);
    assert.ok(!JSON.stringify(settings.getApp()).includes('DB_TOKEN'), 'tokens are not in settings JSON');
    assert.equal(store.read('mouaif/mcp-oauth', 'account'), null, 'MCP namespace remains isolated');
    const context = { scope: 'app', entry: { id: 'server', url: 'https://example.com/mcp', oauth: { enabled: true } } };
    oauth.setSecret(context, 'MCP_SECRET');
    assert.equal(oauth.hasSecret(context), true);
    assert.ok(!JSON.stringify(settings.getApp()).includes('MCP_SECRET'));
    settings.close();
    assert.equal(auth.getToken('codex', 'account'), 'DB_TOKEN', 'survives connection reopen');
    const child = spawnSync(process.execPath, ['-e', `const auth=require('./src/auth.js'); if(auth.getToken('codex','account')!=='DB_TOKEN')process.exit(1); require('./src/settings.js').close();`], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = path.join(home, 'store.sqlite' + suffix);
      if (process.platform !== 'win32' && fs.existsSync(file)) assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only DB ' + suffix);
    }
    legacy.set('mouaif/anthropic/legacy', 'LEGACY_TOKEN');
    settings.setApp({ authAccounts: { anthropic: ['legacy'] } });
    assert.equal(auth.getToken('anthropic', 'legacy'), 'LEGACY_TOKEN', 'copy-on-read migration');
    assert.equal(legacy.get('mouaif/anthropic/legacy'), 'LEGACY_TOKEN', 'legacy entry preserved');
    const reads = legacyReads;
    assert.equal(auth.getToken('anthropic', 'legacy'), 'LEGACY_TOKEN');
    assert.equal(legacyReads, reads, 'DB takes precedence after migration');
    assert.equal(auth.deleteToken('anthropic', 'legacy').deleted, true);
    assert.equal(auth.getToken('anthropic', 'legacy'), null, 'sign-out cannot resurrect legacy token');
    assert.deepEqual(auth.listAccounts().anthropic, []);
    assert.equal(auth.deleteToken('anthropic', 'legacy').deleted, false, 'sign-out is idempotent');
    await auth.setToken('anthropic', 'legacy', 'NEW_TOKEN');
    assert.equal(auth.getToken('anthropic', 'legacy'), 'NEW_TOKEN', 'sign-in replaces tombstone');
    legacy.set('mouaif/mcp-oauth/' + oauth.secretKey(context), JSON.stringify({ secret: 'OLD_MCP_SECRET' }));
    oauth.setSecret(context, null);
    assert.equal(oauth.hasSecret(context), false, 'cleared MCP secret stays cleared');
    legacy.set('mouaif/codex/race', () => {
    store.remove('mouaif/codex', 'race');
    return 'STALE_TOKEN';
    });
    assert.equal(store.read('mouaif/codex', 'race'), null, 'concurrent sign-out wins over legacy migration');
    const originalSetApp = settings.setApp;
    settings.setApp = () => { throw new Error('simulated index failure'); };
    await assert.rejects(auth.setToken('codex', 'rollback', 'NOT_COMMITTED'));
    settings.setApp = originalSetApp;
    assert.equal(store.accounts('mouaif/codex').includes('rollback'), false, 'credential/index write is atomic');
    assert.throws(() => store.write('mouaif/codex', 'bad', {}), { code: 'ECREDENTIALS' });
    console.log('PASS app DB credentials: keychain-free sign-in, restart persistence, permissions, namespace isolation, legacy migration, sign-out tombstones, atomic index, secret-free settings');
  } finally {
    settings.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
