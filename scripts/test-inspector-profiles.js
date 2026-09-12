'use strict';

// Inspector Chrome-profile management — src/inspectorProfiles.js and the
// /api/inspector/profiles* routes.
//
// Two halves:
//
//   1. the module: discovery (candidate roots per platform, user-data-dir
//      sniffing, Chrome's own names via Local State / Preferences), the
//      endpoint precedence, and every mutation (switch / set endpoint /
//      add dir / remove dir);
//   2. the HTTP surface the Inspector UI actually calls, served by a real
//      server on an ephemeral loopback port so the routing, the status
//      codes and the error mapping are exercised, not just the module.
//
// Every fixture is a synthetic user-data-dir built in a temp dir, so the
// test asserts against known profiles rather than whatever Chrome
// happens to be installed on the machine running it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// MOUAIF_HOME must be set BEFORE any src module is required: settings.js
// captures the store path at require time, so a later assignment would
// route these writes through the developer's real ~/.mouaif.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-inspector-profiles-'));
process.env.MOUAIF_HOME = path.join(TMP, 'home');

const settings = require('../src/settings.js');
const inspector = require('../src/inspector.js');
const profiles = require('../src/inspectorProfiles.js');

// Chrome metadata filename, referenced by the fixture writers below.
const LOCAL_STATE_NAME = 'Local State';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? '  -- ' + detail : '')); }
}

// ---- fixtures ----------------------------------------------------------

// writeUserDataDir(dir, infoCache, opts) — a Chrome user-data-dir that
// looks real enough for the scanner: a `Local State` with the info cache,
// plus a directory per profile. `opts.noDefault` omits `Default`;
// `opts.prefs` adds per-profile Preferences files.
function writeUserDataDir(dir, infoCache, opts) {
  const o = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
    profile: { info_cache: infoCache }
  }));
  const ids = new Set(Object.keys(infoCache));
  if (!o.noDefault) ids.add('Default');
  for (const id of ids) fs.mkdirSync(path.join(dir, id), { recursive: true });
  for (const [id, prefs] of Object.entries(o.prefs || {})) {
    fs.writeFileSync(path.join(dir, id, 'Preferences'), JSON.stringify(prefs));
  }
  return dir;
}

const UDD = path.join(TMP, 'chrome-a');
writeUserDataDir(UDD, {
  Default: { name: 'Work' },
  'Profile 1': { name: 'Personal', account_info: [{ email: 'me@example.com' }] },
  'Profile 2': { name: '', local_profile_name: 'Old Name' }
}, {
  prefs: { 'Profile 2': { profile: { name: 'From Preferences' } } }
});

// A second user-data-dir whose profile has no info-cache entry at all —
// the stale-cache case, where the directory on disk is the only evidence.
const UDD_STALE = path.join(TMP, 'chrome-b');
writeUserDataDir(UDD_STALE, {}, { noDefault: true });
fs.mkdirSync(path.join(UDD_STALE, 'Profile 7'), { recursive: true });

// Not a Chrome user-data-dir: neither Local State nor Default/.
const NOT_UDD = path.join(TMP, 'not-a-profile-dir');
fs.mkdirSync(NOT_UDD, { recursive: true });

function profileOf(id, opts) {
  const list = profiles.listProfiles(Object.assign({ dir: UDD }, opts || {}));
  return list.profiles.find((p) => p.id === id) || null;
}

// ---- 1. exports --------------------------------------------------------

check('exports listProfiles', typeof profiles.listProfiles === 'function');
check('exports buildProfileList', typeof profiles.buildProfileList === 'function');
check('exports scanUserDataDirs', typeof profiles.scanUserDataDirs === 'function');
check('exports switchProfile', typeof profiles.switchProfile === 'function');
check('exports setProfileEndpoint', typeof profiles.setProfileEndpoint === 'function');
check('exports addDir', typeof profiles.addDir === 'function');
check('exports removeDir', typeof profiles.removeDir === 'function');
check('exports activeProfile', typeof profiles.activeProfile === 'function');
check('exports clearActive', typeof profiles.clearActive === 'function');
check('DEFAULT_PROFILE is Default', profiles.DEFAULT_PROFILE === 'Default');
check('app settings key is stable',
  profiles.APP_KEY_PROFILES === 'inspectorProfiles', profiles.APP_KEY_PROFILES);

// ---- 2. per-platform candidate roots ------------------------------------

const darwin = profiles.candidateRoots({ platform: 'darwin', home: '/Users/me', env: {} });
check('darwin roots include Chrome', darwin.some((p) => p.endsWith('/Library/Application Support/Google/Chrome')));
check('darwin roots include Chromium', darwin.some((p) => p.endsWith('/Chromium')));
check('darwin roots include Edge', darwin.some((p) => p.includes('Microsoft Edge')));

const win = profiles.candidateRoots({ platform: 'win32', home: 'C:\\Users\\me', env: { LOCALAPPDATA: 'C:\\Local' } });
check('win32 root uses LOCALAPPDATA',
  win[0] === path.join('C:\\Local', 'Google', 'Chrome', 'User Data'), win[0]);
const winNoLocal = profiles.candidateRoots({ platform: 'win32', home: 'C:\\Users\\me', env: {} });
check('win32 falls back to AppData\\Local when LOCALAPPDATA is unset',
  winNoLocal[0].includes(path.join('AppData', 'Local')), winNoLocal[0]);

const linuxDefault = profiles.candidateRoots({ platform: 'linux', home: '/home/me', env: {} });
check('linux root uses ~/.config/google-chrome',
  linuxDefault[0] === '/home/me/.config/google-chrome', linuxDefault[0]);
const linuxXdg = profiles.candidateRoots({ platform: 'linux', home: '/home/me', env: { XDG_CONFIG_HOME: '/cfg' } });
check('linux honours XDG_CONFIG_HOME', linuxXdg[0] === '/cfg/google-chrome', linuxXdg[0]);
check('candidate roots have no duplicates',
  new Set(linuxXdg).size === linuxXdg.length, linuxXdg.join(','));

// ---- 3. profile directory naming ---------------------------------------

check('PROFILE_DIR_RE accepts Default', profiles.PROFILE_DIR_RE.test('Default'));
check('PROFILE_DIR_RE accepts Profile 1', profiles.PROFILE_DIR_RE.test('Profile 1'));
check('PROFILE_DIR_RE rejects Profile 1x', !profiles.PROFILE_DIR_RE.test('Profile 1x'));
check('PROFILE_DIR_RE rejects ShaderCache', !profiles.PROFILE_DIR_RE.test('ShaderCache'));
check('PROFILE_DIR_RE rejects Default2', !profiles.PROFILE_DIR_RE.test('Default2'));

// ---- 4. discovery ------------------------------------------------------

const descriptor = profiles.readUserDataDir(UDD, 'custom');
check('readUserDataDir returns a descriptor', !!descriptor && Array.isArray(descriptor.profiles));
check('readUserDataDir keeps the dir and kind',
  descriptor.dir === UDD && descriptor.kind === 'custom');
check('discovery lists every profile directory', descriptor.profiles.length === 3,
  'got: ' + descriptor.profiles.length);
check('Default sorts first', descriptor.profiles[0].id === 'Default');
check('Profile N sorts numerically',
  descriptor.profiles.map((p) => p.id).join(',') === 'Default,Profile 1,Profile 2',
  descriptor.profiles.map((p) => p.id).join(','));
check('name comes from Local State', descriptor.profiles[0].label === 'Work');
check('email comes from account_info', descriptor.profiles[1].account === 'me@example.com');
check('a profile without an account reports none', descriptor.profiles[2].account === '');
check('local_profile_name is honoured before Preferences',
  descriptor.profiles[2].label === 'Old Name', descriptor.profiles[2].label);
check('key is dir::id', descriptor.profiles[0].key === UDD + '::Default', descriptor.profiles[0].key);

// labelFor precedence, exercised directly so the order is on the record.
check('Preferences is the last fallback before the id',
  profiles.readUserDataDir(UDD, 'custom').profiles[0].label === 'Work');
const prefsOnly = writeUserDataDir(path.join(TMP, 'chrome-prefs'), { Default: {} }, {
  prefs: { Default: { profile: { name: 'Preferences Only' } } }
});
check('a profile named only in Preferences uses that name',
  profiles.readUserDataDir(prefsOnly, 'custom').profiles[0].label === 'Preferences Only');
const unnamed = writeUserDataDir(path.join(TMP, 'chrome-unnamed'), { Default: {} });
check('an unnamed profile falls back to its directory id',
  profiles.readUserDataDir(unnamed, 'custom').profiles[0].label === 'Default');

check('a directory that is not a user-data-dir returns null',
  profiles.readUserDataDir(NOT_UDD, 'custom') === null);
check('a missing directory returns null',
  profiles.readUserDataDir(path.join(TMP, 'nope'), 'custom') === null);

// A user-data-dir whose Local State is corrupt must degrade, not throw.
const corrupt = path.join(TMP, 'chrome-corrupt');
fs.mkdirSync(path.join(corrupt, 'Default'), { recursive: true });
fs.writeFileSync(path.join(corrupt, 'Local State'), '{ not json');
const corruptDesc = profiles.readUserDataDir(corrupt, 'custom');
check('a malformed Local State still yields the profile directories',
  !!corruptDesc && corruptDesc.profiles.length === 1 && corruptDesc.profiles[0].id === 'Default');

// Directory on disk with no info-cache entry (stale cache).
const staleDesc = profiles.readUserDataDir(UDD_STALE, 'custom');
check('directory present but absent from the info cache is still listed',
  staleDesc.profiles.some((p) => p.id === 'Profile 7'),
  staleDesc.profiles.map((p) => p.id).join(','));
check('a profile with no metadata is labelled by its directory id',
  staleDesc.profiles.find((p) => p.id === 'Profile 7').label === 'Profile 7');

// scanUserDataDirs dedupes and honours the requested dirs.
const scan = profiles.scanUserDataDirs({ dirs: [UDD, UDD, NOT_UDD] });
check('scan dedupes a repeated dir',
  scan.filter((d) => d.dir === UDD).length === 1, scan.map((d) => d.dir).join(','));
check('scan drops a directory that is not a user-data-dir',
  !scan.some((d) => d.dir === NOT_UDD));
check('scan keeps the requested dir first', scan[0].dir === UDD, scan[0].dir);

// ---- 5. endpoints ------------------------------------------------------

check('splitEndpoint reads host and port',
  JSON.stringify(profiles.splitEndpoint('http://127.0.0.1:9223'))
  === JSON.stringify({ host: '127.0.0.1', port: 9223, url: 'http://127.0.0.1:9223' }));
check('splitEndpoint defaults the http port to 80',
  profiles.splitEndpoint('http://example.com').port === 80);
check('splitEndpoint defaults the https port to 443',
  profiles.splitEndpoint('https://example.com').port === 443);
check('splitEndpoint reads an https port',
  profiles.splitEndpoint('https://example.com:9443').port === 9443);
check('splitEndpoint rejects a non-http scheme',
  profiles.splitEndpoint('ws://127.0.0.1:9222') === null);
check('splitEndpoint rejects junk', profiles.splitEndpoint('nonsense') === null);
check('splitEndpoint rejects empty input', profiles.splitEndpoint('') === null);

const built = profiles.buildProfileList([descriptor], {}, { globalUrl: 'http://127.0.0.1:9222' });
check('buildProfileList flattens every profile', built.profiles.length === 3);
check('an unconfigured profile inherits the global URL',
  built.profiles[0].url === 'http://127.0.0.1:9222' && built.profiles[0].configured === false);
check('buildProfileList reports the global and default URLs',
  built.globalUrl === 'http://127.0.0.1:9222' && built.defaultUrl === inspector.defaultDebuggerUrl());
check('buildProfileList reports the scanned dirs',
  Array.isArray(built.dirs) && built.dirs[0] === UDD);

// A discovered user-data-dir with no profiles is real: a Chrome that was
// started once and never asked to create a profile leaves a `Local State`
// with no info_cache and no `Default/`. It must stay labelled as
// scanner-found — deriving "added" from "has no profiles" gave it a Remove
// button for a directory the user never registered.
const emptyUdd = path.join(TMP, 'chrome-empty');
fs.mkdirSync(emptyUdd, { recursive: true });
fs.writeFileSync(path.join(emptyUdd, LOCAL_STATE_NAME), JSON.stringify({ signin: {} }));
const emptyDesc = profiles.readUserDataDir(emptyUdd, 'auto');
check('a user-data-dir with no profiles is still discovered',
  !!emptyDesc && emptyDesc.profiles.length === 0);
const emptyList = profiles.buildProfileList([emptyDesc], {}, { globalUrl: 'http://127.0.0.1:9222' });
check('a profile-less discovered dir is listed',
  emptyList.dirs.includes(emptyUdd), JSON.stringify(emptyList.dirs));
check('a profile-less discovered dir is NOT reported as user-added',
  !emptyList.addedDirs.includes(emptyUdd), JSON.stringify(emptyList.addedDirs));
const customDesc = profiles.readUserDataDir(UDD, 'custom');
check('kind: custom is what marks a dir as user-added',
  profiles.buildProfileList([customDesc], {}, {}).addedDirs.includes(UDD));
check('addedDirs is always an array',
  Array.isArray(built.addedDirs) && Array.isArray(profiles.buildProfileList([], {}, {}).addedDirs));
const overridden = profiles.buildProfileList([descriptor], {
  endpoints: { [UDD + '::Default']: 'http://127.0.0.1:9333' },
  activeId: 'Default'
}, { globalUrl: 'http://127.0.0.1:9222' });
check('a per-profile override wins over the global URL',
  overridden.profiles[0].url === 'http://127.0.0.1:9333', overridden.profiles[0].url);
check('an override is marked configured', overridden.profiles[0].configured === true);
check('an override reports its port', overridden.profiles[0].port === 9333);
check('the active profile is flagged', overridden.profiles[0].active === true);
check('only the active profile is flagged',
  overridden.profiles.filter((p) => p.active).length === 1);

// ---- 6. mutations ------------------------------------------------------

const saved = profiles.setProfileEndpoint('Profile 1', 'http://127.0.0.1:9444/', { dir: UDD });
check('setProfileEndpoint returns the normalised url', saved.url === 'http://127.0.0.1:9444');
check('setProfileEndpoint does not switch',
  inspector.getDebuggerUrl() === inspector.defaultDebuggerUrl(), inspector.getDebuggerUrl());
check('setProfileEndpoint persists for that profile only',
  profileOf('Profile 1').url === 'http://127.0.0.1:9444' && profileOf('Default').url !== 'http://127.0.0.1:9444');
check('setProfileEndpoint rejects a non-http url',
  (() => { try { profiles.setProfileEndpoint('Default', 'ws://x:1', { dir: UDD }); return false; }
    catch (e) { return e.code === 'EBADURL'; } })());
check('setProfileEndpoint rejects an unknown profile',
  (() => { try { profiles.setProfileEndpoint('Nope', 'http://127.0.0.1:1', { dir: UDD }); return false; }
    catch (e) { return e.code === 'EPROFILE_NOT_FOUND'; } })());

const switched = profiles.switchProfile('Profile 1', { dir: UDD });
check('switchProfile writes the global debugger URL',
  inspector.getDebuggerUrl() === 'http://127.0.0.1:9444', inspector.getDebuggerUrl());
check('switchProfile returns the endpoint', switched.url === 'http://127.0.0.1:9444');
check('switchProfile records the active profile',
  profileOf('Profile 1').active === true && profileOf('Default').active === false);
check('activeProfile names the active profile',
  profiles.activeProfile().id === 'Profile 1' && profiles.activeProfile().label === 'Personal',
  JSON.stringify(profiles.activeProfile()));
check('switchProfile rejects an unknown profile',
  (() => { try { profiles.switchProfile('Nope', { dir: UDD }); return false; }
    catch (e) { return e.code === 'EPROFILE_NOT_FOUND'; } })());
check('clearActive forgets the active profile',
  (() => {
    profiles.clearActive();
    return profiles.activeProfile() === null;
  })());

// addDir / removeDir
check('addDir rejects a directory that is not a user-data-dir',
  (() => { try { profiles.addDir(NOT_UDD); return false; }
    catch (e) { return e.code === 'ENOTPROFILEDIR'; } })());
check('addDir rejects an empty path',
  (() => { try { profiles.addDir(''); return false; }
    catch (e) { return e.code === 'EBADINPUT'; } })());
const added = profiles.addDir(UDD_STALE);
check('addDir reports the profile count found', added.profiles === 1, JSON.stringify(added));
check('an added directory is scanned afterwards',
  profiles.listProfiles().profiles.some((p) => p.id === 'Profile 7'));
check('addDir does not store a duplicate',
  profiles.addDir(UDD_STALE).dir === UDD_STALE && settings.getApp().inspectorProfiles.dirs.length === 1,
  JSON.stringify(settings.getApp().inspectorProfiles.dirs));

// removeDir drops the directory's endpoint overrides and any active
// profile that lived there.
profiles.setProfileEndpoint('Profile 7', 'http://127.0.0.1:9555');
profiles.switchProfile('Profile 7');
check('the active profile can live in an added directory',
  profiles.activeProfile().id === 'Profile 7');
const removed = profiles.removeDir(UDD_STALE);
check('removeDir reports the removal', removed.removed === true);
check('removeDir drops the endpoint overrides for that directory',
  removed.endpoints === 1, 'dropped ' + removed.endpoints);
check('removeDir forgets an active profile that lived there',
  profiles.activeProfile() === null, JSON.stringify(profiles.activeProfile()));
check('a removed directory is no longer scanned',
  !profiles.listProfiles().profiles.some((p) => p.id === 'Profile 7'));
check('removeDir on an unknown directory is a no-op',
  profiles.removeDir('/nowhere/at/all').removed === false);

// Restore a known state for the HTTP half.
inspector.setDebuggerUrl('');
profiles.clearActive();
profiles.addDir(UDD);

// ---- 7. HTTP surface ---------------------------------------------------

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf || '{}'); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const { createServer, destroyOpenSockets } = require('../src/index.js');
  const server = createServer(0);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  try {
    // GET /api/inspector/profiles
    const list = await request(port, 'GET', '/api/inspector/profiles');
    check('GET /api/inspector/profiles is 200', list.status === 200, 'got ' + list.status);
    check('the list carries profiles', Array.isArray(list.body.profiles) && list.body.profiles.length >= 3,
      JSON.stringify(list.body.profiles && list.body.profiles.length));
    check('the list carries the global url', typeof list.body.globalUrl === 'string');
    check('the list carries the scanned dirs', Array.isArray(list.body.dirs) && list.body.dirs.includes(UDD));
    check('the list carries addedDirs',
    Array.isArray(list.body.addedDirs) && list.body.addedDirs.includes(UDD),
    JSON.stringify(list.body.addedDirs));
    check('every profile row has an id, key, dir and url',
      list.body.profiles.every((p) => p.id && p.key && p.dir && p.url));
    check('the HTTP row shape matches the module',
      JSON.stringify(list.body.profiles.find((p) => p.id === 'Default').port)
      === JSON.stringify(profiles.listProfiles().profiles.find((p) => p.id === 'Default').port));

    // GET /api/inspector/config gains activeProfile
    const cfg = await request(port, 'GET', '/api/inspector/config');
    check('GET /api/inspector/config is 200', cfg.status === 200);
    check('GET /api/inspector/config reports activeProfile (null when none)',
      cfg.body.activeProfile === null, JSON.stringify(cfg.body.activeProfile));

    // POST /api/inspector/profiles/switch
    const sw = await request(port, 'POST', '/api/inspector/profiles/switch', { id: 'Profile 1' });
    check('POST profiles/switch is 200', sw.status === 200, 'got ' + sw.status);
    check('POST profiles/switch returns the url', typeof sw.body.url === 'string' && sw.body.url.startsWith('http://'));
    check('POST profiles/switch names the profile',
      sw.body.profile && sw.body.profile.id === 'Profile 1' && sw.body.profile.label === 'Personal');
    const cfgAfter = await request(port, 'GET', '/api/inspector/config');
    check('the switch is visible on the config endpoint',
      cfgAfter.body.activeProfile && cfgAfter.body.activeProfile.label === 'Personal',
      JSON.stringify(cfgAfter.body.activeProfile));
    check('the switch wrote the debugger url',
      cfgAfter.body.url === sw.body.url, cfgAfter.body.url + ' vs ' + sw.body.url);

    const swBad = await request(port, 'POST', '/api/inspector/profiles/switch', { id: 'Nope' });
    check('POST profiles/switch with an unknown id is 404', swBad.status === 404, 'got ' + swBad.status);
    const swNoId = await request(port, 'POST', '/api/inspector/profiles/switch', {});
    check('POST profiles/switch without id is 400', swNoId.status === 400, 'got ' + swNoId.status);

    // POST /api/inspector/profiles/endpoint
    const ep = await request(port, 'POST', '/api/inspector/profiles/endpoint', { id: 'Default', url: 'http://127.0.0.1:9333' });
    check('POST profiles/endpoint is 200', ep.status === 200, 'got ' + ep.status);
    check('POST profiles/endpoint normalises the url', ep.body.url === 'http://127.0.0.1:9333');
    const list2 = await request(port, 'GET', '/api/inspector/profiles');
    check('a saved endpoint shows up as configured',
      list2.body.profiles.find((p) => p.id === 'Default').configured === true);
    const epBadUrl = await request(port, 'POST', '/api/inspector/profiles/endpoint', { id: 'Default', url: 'not-a-url' });
    check('POST profiles/endpoint with a bad url is 400', epBadUrl.status === 400, 'got ' + epBadUrl.status);
    const epBadId = await request(port, 'POST', '/api/inspector/profiles/endpoint', { id: 'Nope', url: 'http://127.0.0.1:1' });
    check('POST profiles/endpoint with an unknown id is 404', epBadId.status === 404, 'got ' + epBadId.status);
    const epNoUrl = await request(port, 'POST', '/api/inspector/profiles/endpoint', { id: 'Default' });
    check('POST profiles/endpoint without url is 400', epNoUrl.status === 400, 'got ' + epNoUrl.status);

    // POST/DELETE /api/inspector/profiles/dirs
    const addDir = await request(port, 'POST', '/api/inspector/profiles/dirs', { dir: UDD_STALE });
    check('POST profiles/dirs is 200', addDir.status === 200, 'got ' + addDir.status);
    check('POST profiles/dirs reports the profile count', addDir.body.profiles === 1, JSON.stringify(addDir.body));
    const addBad = await request(port, 'POST', '/api/inspector/profiles/dirs', { dir: NOT_UDD });
    check('POST profiles/dirs with a non-profile dir is 404', addBad.status === 404, 'got ' + addBad.status);
    const addNone = await request(port, 'POST', '/api/inspector/profiles/dirs', {});
    check('POST profiles/dirs without dir is 400', addNone.status === 400, 'got ' + addNone.status);

    const del = await request(port, 'DELETE', '/api/inspector/profiles/dirs?dir=' + encodeURIComponent(UDD_STALE));
    check('DELETE profiles/dirs is 200', del.status === 200, 'got ' + del.status);
    check('DELETE profiles/dirs reports the removal', del.body.removed === true);
    const delNone = await request(port, 'DELETE', '/api/inspector/profiles/dirs');
    check('DELETE profiles/dirs without dir is 400', delNone.status === 400, 'got ' + delNone.status);

    // PUT /api/inspector/config clears the active profile: a hand-typed URL
    // is no longer attributable to a profile.
    await request(port, 'POST', '/api/inspector/profiles/switch', { id: 'Profile 1' });
    const put = await request(port, 'PUT', '/api/inspector/config', { url: 'http://127.0.0.1:9999' });
    check('PUT /api/inspector/config is 200', put.status === 200, 'got ' + put.status);
    check('PUT /api/inspector/config clears the active profile',
      put.body.activeProfile === null, JSON.stringify(put.body.activeProfile));
    const cfgFinal = await request(port, 'GET', '/api/inspector/config');
    check('the cleared active profile stays cleared',
      cfgFinal.body.activeProfile === null && cfgFinal.body.url === 'http://127.0.0.1:9999');
    check('the previously saved per-profile endpoint survived the manual URL',
      (await request(port, 'GET', '/api/inspector/profiles')).body.profiles
        .find((p) => p.id === 'Default').url === 'http://127.0.0.1:9333');

    // The debugger default port is untouched by any of this.
    check('the debugger default port is still 9222',
      inspector.defaultDebuggerUrl().endsWith(':9222'), inspector.defaultDebuggerUrl());
  } finally {
    await new Promise((resolve) => { server.close(resolve); destroyOpenSockets(); });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
