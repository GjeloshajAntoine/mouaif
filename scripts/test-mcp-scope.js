'use strict';

// Unit test for app-scoped MCP servers (docs/features/mcp.md — scope).
// Covers: add at app scope, merged listing, project-wins shadowing,
// scope-aware update/remove, and the app-only listing when no
// projectDir is given. Uses a temp MOUAIF_HOME and a temp project dir.

const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-scope-'));
process.env.MOUAIF_HOME = TMP;

const settings = require('../src/settings.js');
const mcp = require('../src/mcp.js');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-mcp-scope-proj-'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

async function main() {
  // 1) App-scope add with no projectDir.
  const appSrv = mcp.addServer(null, {
    name: 'Shared FS',
    command: process.execPath,
    args: ['srv.js'],
    enabled: true,
    scope: 'app'
  });
  check('app addServer returns record', !!appSrv && appSrv.id && appSrv.slug === 'shared_fs', 'got: ' + (appSrv && appSrv.slug));
  check('app addServer marks scope app', appSrv && appSrv.scope === 'app');

  // App entry persisted in the app store, not a project file.
  const appRaw = settings.getApp();
  check('app store carries mcp.servers', !!(appRaw && appRaw.mcp && Array.isArray(appRaw.mcp.servers) && appRaw.mcp.servers.length === 1));
  check('no .mcp.json written for app add', !fs.existsSync(mcp.getMcpPath(projectDir)));

  // 2) App-only listing (no projectDir).
  const appOnly = mcp.listServers(null);
  check('listServers(null) returns app entries only', appOnly.length === 1 && appOnly[0].scope === 'app');

  // 3) Project-scope add coexists.
  const projSrv = mcp.addServer(projectDir, {
    name: 'Proj Tool',
    command: process.execPath,
    args: ['p.js'],
    enabled: true
  });
  check('project addServer defaults to project scope', projSrv && projSrv.scope === 'project');
  check('.mcp.json written for project add', fs.existsSync(mcp.getMcpPath(projectDir)));

  // 4) Merged listing: app first, then project.
  const merged = mcp.listServers(projectDir);
  check('merged list has both entries', merged.length === 2, 'got: ' + merged.length);
  check('merged order app then project', merged[0].scope === 'app' && merged[1].scope === 'project');

  // 5) getServer finds either scope by id.
  check('getServer finds app entry', (mcp.getServer(projectDir, appSrv.id) || {}).scope === 'app');
  check('getServer finds project entry', (mcp.getServer(projectDir, projSrv.id) || {}).scope === 'project');

  // 6) Project shadows app on a slug collision: add a project entry with
  //    the same name (same slug) — the app entry disappears from the
  //    merged view but stays in the app store.
  const shadow = mcp.addServer(projectDir, {
    name: 'Shared FS',
    command: process.execPath,
    args: ['other.js'],
    enabled: false
  });
  check('project shadow entry added with same slug', shadow && shadow.slug === appSrv.slug);
  const merged2 = mcp.listServers(projectDir);
  const sharedMatches = merged2.filter(s => s.slug === 'shared_fs');
  check('slug collision resolves to one entry', sharedMatches.length === 1, 'got: ' + sharedMatches.length);
  check('the surviving entry is the project one', sharedMatches[0] && sharedMatches[0].scope === 'project' && sharedMatches[0].id === shadow.id);
  const appStillThere = (settings.getApp().mcp.servers || []).some(s => s.id === appSrv.id);
  check('shadowed app entry stays in the app store', appStillThere);
  check('app-only listing still shows the app entry', mcp.listServers(null).some(s => s.id === appSrv.id));

  // 7) Update routes by id: patching the app entry lands in the app
  //    store; the project file does not gain a copy.
  const upd = mcp.updateServer(projectDir, appSrv.id, { enabled: false });
  check('update app entry returns scope app', upd && upd.scope === 'app' && upd.enabled === false);
  const appEntryAfter = (settings.getApp().mcp.servers || []).find(s => s.id === appSrv.id);
  check('app store reflects the update', appEntryAfter && appEntryAfter.enabled === false);

  // 8) Remove the app entry by id.
  check('removeServer app entry true', mcp.removeServer(projectDir, appSrv.id) === true);
  check('app store no longer lists it', !(settings.getApp().mcp.servers || []).some(s => s.id === appSrv.id));

  // 9) Remove the shadow; the app entry is gone too (we removed it), so
  //    the merged list now shows only the plain project entry.
  check('removeServer shadow true', mcp.removeServer(projectDir, shadow.id) === true);
  const merged3 = mcp.listServers(projectDir);
  check('merged list back to one project entry', merged3.length === 1 && merged3[0].id === projSrv.id, 'got: ' + merged3.length);

  // 10) Scope is fixed at creation: a patch carrying scope is ignored.
  const noMove = mcp.updateServer(projectDir, projSrv.id, { scope: 'app', name: 'Proj Tool Renamed' });
  check('update ignores scope patch', noMove && noMove.scope === 'project');
  check('renamed project entry still in project file', (mcp.getServer(projectDir, projSrv.id) || {}).name === 'Proj Tool Renamed');
  check('app store did not gain the moved entry', !(settings.getApp().mcp && Array.isArray(settings.getApp().mcp.servers) && settings.getApp().mcp.servers.some(s => s.id === projSrv.id)));

  // 11) App entries participate in listComposedToolSpecs when enabled
  //     (stopped -> persisted-cache path; an empty cache means no specs,
  //     but the merge path itself must not throw without a project).
  check('listComposedToolSpecs(null) does not throw', Array.isArray(mcp.listComposedToolSpecs(null)));

  // 12) Project-scope add without a projectDir is rejected.
  let threw = false;
  try { mcp.addServer(null, { name: 'X', command: process.execPath }); } catch (e) { threw = e && e.code === 'EBADINPUT'; }
  check('project-scope add without projectDir throws EBADINPUT', threw);

  mcp.removeServer(projectDir, projSrv.id);
  settings.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
