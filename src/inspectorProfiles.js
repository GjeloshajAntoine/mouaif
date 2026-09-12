'use strict';

// Inspector — Chrome *user profiles* and the debug endpoint each one
// points at.
//
// The Inspector has always had exactly one debug endpoint (`inspector.
// getDebuggerUrl()`, default `http://127.0.0.1:9222`). That is fine
// until the user has more than one Chrome profile: Chrome only
// exposes `--remote-debugging-port` for the instance that was started
// with it, so "my work profile is on 9223, my personal one on 9224"
// means the Inspector needs to know *which* profile the user means —
// not just a URL the user has to remember and retype.
//
// This module supplies that mapping:
//
//   1. it discovers the Chrome *user-data-dirs* on this machine,
//      which is where Chrome keeps its profiles;
//   2. it lists the profile inside each one (`Default`,
//      `Profile 1`, ...) with the human name from Chrome's own
//      `Local State` / `Preferences` and the signed-in account when
//      there is one;
//   3. it holds a per-profile endpoint override in the app settings
//      store, and can make one profile *active* — which is just
//      "write this profile's endpoint into the existing global
//      debugger URL", so every other Inspector code path (targets,
//      open, close, navigate, the CDP proxy) keeps working unchanged.
//
// Deliberate scope limits:
//
//   * mouaif never launches or stops Chrome. The Inspector attaches to
//     a browser the user started; this module only *describes* the
//     profiles on disk and points the Inspector at one of them.
//   * Discovery is read-only and offline-safe: it reads two JSON files
//     per user-data-dir and never opens a socket, so the list still
//     renders when no Chrome is running.
//   * `id` is the *directory* name (`Default`), not the *GUID* Chrome
//     keeps in `Local State`. The directory name is what a user
//     recognises and what a command line names
//     (`--profile-directory="Profile 1"`); the GUID is opaque and
//     changes when a profile is recreated. `key` (dir + '::' + id) is
//     the storage key, so two user-data-dirs may each have a `Default`
//     without colliding.

const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('./settings.js');
const inspector = require('./inspector.js');

// App-settings key. Shape:
//   { activeId: 'Default' | null,
//     endpoints: { '<key>': 'http://127.0.0.1:9223' },
//     dirs: ['/abs/custom/user-data-dir'] }
// `endpoints` is keyed by `key` (see the header) so a profile keeps its
// port even when the same directory name exists in two user-data-dirs.
const APP_KEY_PROFILES = 'inspectorProfiles';

// Chrome's two metadata files, relative to a user-data-dir.
const LOCAL_STATE = 'Local State';
const PREFERENCES = 'Preferences';

// Chrome's profile directories. Everything else in a user-data-dir
// (`ShaderCache`, `Crashpad`, `Extensions`, ...) is shared state, not a
// profile. The `Default` profile is always present in a real
// user-data-dir; `Profile N` appear as the user adds profiles.
const PROFILE_DIR_RE = /^(Default|Profile \d+)$/;
const DEFAULT_PROFILE = 'Default';

// The user-data-dir scripts/start-chrome-debug.ps1 boots for the
// Inspector. It is tagged `mouaif` in the list so a machine with only
// this one profile still shows something familiar rather than
// "Default" for a directory the user never created.
const MOUAIF_PROFILE_DIR = path.join(os.tmpdir(), 'mouaif-chrome-debug-profile');

// ---- candidate user-data-dirs ------------------------------------------

// candidateRoots(opts) — the per-platform default user-data-dirs for the
// Chromium-family browsers, in preference order. Only the paths matter;
// a path that does not exist is filtered out later by the scanner, so an
// Edge-less machine costs nothing.
//
// `opts` is injectable so the platforms are unit-testable without
// std::{darwin,win32} hardware:
//   { platform, home, env }  (defaults: process.platform, os.homedir(), process.env)
function candidateRoots(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const platform = o.platform || process.platform;
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };

  if (platform === 'darwin') {
    push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'));
    push(path.join(home, 'Library', 'Application Support', 'Chromium'));
    push(path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'));
    push(path.join(home, 'Library', 'Application Support', 'Microsoft Edge'));
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    push(path.join(local, 'Google', 'Chrome', 'User Data'));
    push(path.join(local, 'Chromium', 'User Data'));
    push(path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'));
    push(path.join(local, 'Microsoft', 'Edge', 'User Data'));
  } else {
    const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
    push(path.join(config, 'google-chrome'));
    push(path.join(config, 'chromium'));
    push(path.join(config, 'BraveSoftware', 'Brave-Browser'));
    push(path.join(config, 'microsoft-edge'));
  }
  return out;
}

// isDir — fs.statSync wrapped so a missing path is `false`, not a throw.
function isDir(abs) {
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

// listDirs — directory names inside `abs`, or [] when unreadable.
function listDirs(abs) {
  try { return fs.readdirSync(abs); } catch { return []; }
}

// readJsonFile — Chrome's metadata files are large and can be caught
// mid-write; a malformed one must degrade to "no metadata", never throw.
function readJsonFile(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

// ---- naming ------------------------------------------------------------

// labelFor(prefsEntry, prefsFile, id) — the name Chrome shows in its own
// profile picker. `Local State`'s `profile.info_cache[<dir>].name` is the
// renamed profile ("Work"); `local_profile_name` (older builds) and
// `Preferences`' `profile.name` are the fallbacks. A profile Chrome has
// never renamed falls back to the directory name, which is what Chrome
// itself displays ("Person 1" lives only in Preferences, so the
// directory name is a better default than an invented one).
function labelFor(infoEntry, prefsFile, id) {
  const candidates = [
    infoEntry && infoEntry.name,
    infoEntry && infoEntry.local_profile_name,
    prefsFile && prefsFile.profile && prefsFile.profile.name
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return id;
}

// accountFor(infoEntry) — the signed-in account's email, when the
// profile has one. Optional decoration only: a signed-out profile has no
// `account_info` and simply reports nothing.
function accountFor(infoEntry) {
  const list = infoEntry && infoEntry.account_info;
  if (!Array.isArray(list) || !list.length) return '';
  const first = list.find((a) => a && typeof a.email === 'string' && a.email.trim()) || list[0];
  return (first && typeof first.email === 'string') ? first.email.trim() : '';
}

// ---- scanning ----------------------------------------------------------

// profileIdSort — `Default` first, then `Profile 1`, `Profile 2`, ...
// Chrome's own order. Parsed numerically so `Profile 10` follows
// `Profile 9` instead of sorting between `Profile 1` and `Profile 2`.
function profileIdSort(a, b) {
  const rank = (id) => {
    if (id === DEFAULT_PROFILE) return -1;
    const m = /^Profile (\d+)$/.exec(id);
    return m ? Number(m[1]) : 0;
  };
  const diff = rank(a) - rank(b);
  return diff !== 0 ? diff : String(a).localeCompare(String(b));
}

// readUserDataDir(abs, kind) — describe one user-data-dir, or `null` when
// the directory is not one. A real Chrome user-data-dir has either a
// `Local State` file or a `Default` directory (Chrome creates `Default`
// eagerly, `Local State` on first write), so requiring one of the two
// keeps `--user-data-dir=/tmp/whatever` and a plain source checkout out
// of the list.
function readUserDataDir(abs, kind) {
  if (!isDir(abs)) return null;
  const localState = readJsonFile(path.join(abs, LOCAL_STATE));
  const hasDefault = isDir(path.join(abs, DEFAULT_PROFILE));
  if (!localState && !hasDefault) return null;

  const infoCache = (localState && localState.profile && localState.profile.info_cache) || {};
  const ids = new Set();
  for (const id of Object.keys(infoCache)) if (PROFILE_DIR_RE.test(id)) ids.add(id);
  if (hasDefault) ids.add(DEFAULT_PROFILE);
  // The info cache can be stale (a profile directory added by a newer
  // Chrome, or a hand-copied one), so the directories on disk are the
  // floor and the cache only adds names.
  for (const name of listDirs(abs)) {
    if (PROFILE_DIR_RE.test(name) && isDir(path.join(abs, name))) ids.add(name);
  }

  const profiles = Array.from(ids).sort(profileIdSort).map((id) => {
    const infoEntry = infoCache[id] || {};
    const prefsFile = readJsonFile(path.join(abs, id, PREFERENCES));
    return {
      id,
      key: abs + '::' + id,
      dir: abs,
      label: labelFor(infoEntry, prefsFile, id),
      account: accountFor(infoEntry),
      kind: kind || 'auto',
      builtin: true
    };
  });

  return { dir: abs, kind: kind || 'auto', profiles };
}

// scanUserDataDirs(opts) — every Chrome user-data-dir we can find, in
// preference order: the explicit `opts.dir` (one dir, used by tests and
// by "add a profile folder"), then `opts.dirs`, then the user's extra
// dirs from settings, then the per-platform candidates. Duplicates are
// dropped by realpath so a symlinked home does not list the same
// profile twice.
//
// opts: { dir, dirs, extraDirs, app, platform, home, env }
function scanUserDataDirs(opts) {
  const o = opts || {};
  const app = o.app || settings.getApp() || {};
  const store = app[APP_KEY_PROFILES] || {};

  const explicit = [];
  if (typeof o.dir === 'string' && o.dir.trim()) explicit.push({ dir: o.dir.trim(), kind: 'custom' });
  if (Array.isArray(o.dirs)) for (const d of o.dirs) if (typeof d === 'string' && d.trim()) explicit.push({ dir: d.trim(), kind: 'custom' });

  const requested = explicit.slice();
  const extra = Array.isArray(o.extraDirs) ? o.extraDirs : (Array.isArray(store.dirs) ? store.dirs : []);
  for (const d of extra) if (typeof d === 'string' && d.trim()) requested.push({ dir: d.trim(), kind: 'custom' });
  for (const d of candidateRoots(o)) requested.push({ dir: d, kind: 'auto' });
  if (!o.dir && !Array.isArray(o.dirs)) requested.push({ dir: MOUAIF_PROFILE_DIR, kind: 'mouaif' });

  const seen = new Set();
  const out = [];
  for (const entry of requested) {
    let real = entry.dir;
    try { real = fs.realpathSync(entry.dir); } catch { /* keep as written */ }
    if (seen.has(real)) continue;
    seen.add(real);
    const found = readUserDataDir(entry.dir, entry.kind);
    if (found) out.push(found);
  }
  return out;
}

// ---- endpoints ---------------------------------------------------------

// splitEndpoint(url) — the host/port behind a debugger URL, or null for
// anything that is not an http(s) URL. Used to show the port on the
// profile row ("127.0.0.1:9223") without re-parsing in the UI.
function splitEndpoint(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname, port, url: u.origin };
  } catch { return null; }
}

// buildProfileList(descriptors, store) — flatten the scanned dirs into the
// flat profile list the API returns, merging in the per-profile endpoint
// override and the active flag. Pure: everything it needs is an argument,
// which is what the module's tests assert against.
//
// Endpoint precedence, per profile:
//   1. the profile's own saved override  (`store.endpoints[key]`);
//   2. the current global debugger URL — there is only one Inspector
//      attach point today, so "not configured yet" honestly means "this
//      profile would use the endpoint you already have".
function buildProfileList(descriptors, store, globals) {
  const s = store || {};
  const g = globals || {};
  const endpoints = s.endpoints && typeof s.endpoints === 'object' ? s.endpoints : {};
  const globalUrl = typeof g.globalUrl === 'string' && g.globalUrl ? g.globalUrl : inspector.getDebuggerUrl();
  const activeId = typeof s.activeId === 'string' && s.activeId ? s.activeId : '';

  const profiles = [];
  for (const desc of descriptors || []) {
    for (const p of (desc && desc.profiles) || []) {
      const saved = typeof endpoints[p.key] === 'string' ? endpoints[p.key].trim() : '';
      const url = saved || globalUrl;
      const endpoint = splitEndpoint(url);
      profiles.push({
        id: p.id,
        key: p.key,
        dir: p.dir,
        label: p.label,
        account: p.account || '',
        kind: p.kind || 'auto',
        builtin: p.builtin !== false,
        url,
        port: endpoint ? endpoint.port : null,
        configured: !!saved,
        active: !!activeId && p.id === activeId
      });
    }
  }
  return {
    activeId,
    globalUrl,
    defaultUrl: inspector.defaultDebuggerUrl(),
    dirs: (descriptors || []).map((d) => d.dir),
    profiles
  };
}

// listProfiles(opts) — discovery + endpoints in one call. `opts` is
// forwarded to scanUserDataDirs; `opts.app` also supplies the store.
function listProfiles(opts) {
  const o = opts || {};
  const app = o.app || settings.getApp() || {};
  const store = app[APP_KEY_PROFILES] || {};
  const descriptors = scanUserDataDirs(o);
  return buildProfileList(descriptors, store, { globalUrl: inspector.getDebuggerUrl() });
}

// resolveProfile(id, opts) — the flat profile record for a profile id, or
// null. The *first* match wins, which is the same order the UI lists, so
// tapping a row and resolving by id agree on which row was tapped.
function resolveProfile(id, opts) {
  const wanted = String(id == null ? '' : id);
  if (!wanted) return null;
  const list = listProfiles(opts);
  return list.profiles.find((p) => p.id === wanted) || null;
}

// ---- mutations (app settings only) -------------------------------------

function readStore() {
  const app = settings.getApp() || {};
  const store = app[APP_KEY_PROFILES];
  return store && typeof store === 'object' && !Array.isArray(store) ? store : {};
}

function writeStore(patch) {
  const next = Object.assign({}, readStore(), patch);
  settings.setApp({ [APP_KEY_PROFILES]: next });
  return next;
}

// setProfileEndpoint(id, url, opts) — remember the endpoint for ONE
// profile, without making it active. `url` must be an http(s) URL;
// validated so a stored typo cannot turn into a broken attach later.
// `opts` is forwarded to the scan (see scanUserDataDirs) so a caller can
// resolve an id in a specific user-data-dir; the HTTP route passes none,
// which resolves against every dir the settings know about.
function setProfileEndpoint(id, url, opts) {
  const profile = resolveProfile(id, opts);
  if (!profile) {
    const err = new Error('unknown profile: ' + String(id));
    err.code = 'EPROFILE_NOT_FOUND';
    throw err;
  }
  const cleaned = String(url == null ? '' : url).trim();
  const endpoint = splitEndpoint(cleaned);
  if (!endpoint) {
    const err = new Error('url must be an http or https URL');
    err.code = 'EBADURL';
    throw err;
  }
  const store = readStore();
  const endpoints = Object.assign({}, store.endpoints || {});
  endpoints[profile.key] = endpoint.url;
  writeStore({ endpoints });
  return { profile, url: endpoint.url };
}

// switchProfile(id, opts) — make a profile the Inspector's attach point.
// This is intentionally just "write the global debugger URL": every other
// Inspector code path (targets, open/close, navigate, the CDP proxy)
// already reads that one value, so no other module needs to learn about
// profiles. `opts` is forwarded to the scan, as in setProfileEndpoint.
function switchProfile(id, opts) {
  const profile = resolveProfile(id, opts);
  if (!profile) {
    const err = new Error('unknown profile: ' + String(id));
    err.code = 'EPROFILE_NOT_FOUND';
    throw err;
  }
  const endpoint = splitEndpoint(profile.url);
  if (!endpoint) {
    const err = new Error('profile has no usable endpoint');
    err.code = 'EBADURL';
    throw err;
  }
  inspector.setDebuggerUrl(endpoint.url);
  // The label is stored alongside the id so the setup screen can name the
  // active profile with no discovery pass at all (see activeProfile).
  // Chrome's own display name can drift from what was stored when the
  // user renames a profile, which is why the profiles sheet — which
  // re-scans — remains the authority on names.
  writeStore({ activeId: profile.id, activeLabel: profile.label });
  return { profile, url: endpoint.url };
}

// activeProfile() — `{ id, label }` for the active profile, or null when
// none is active. Read straight from the store: no filesystem scan, so
// the Inspector's mount path can call it for free.
function activeProfile() {
  const store = readStore();
  const id = typeof store.activeId === 'string' ? store.activeId : '';
  if (!id) return null;
  return { id, label: typeof store.activeLabel === 'string' && store.activeLabel ? store.activeLabel : id };
}

// clearActive() — forget the active profile. Called when the user edits
// the debugger URL by hand: that URL is no longer "some profile's
// endpoint", and keeping the badge would claim an association that no
// longer holds.
function clearActive() {
  writeStore({ activeId: '', activeLabel: '' });
  return { activeId: '' };
}

// addDir(dir) — register an extra user-data-dir the scan does not know
// about (a portable Chrome, or a profile tree on another volume). The
// directory must actually look like a Chrome user-data-dir, so a typo or
// an unrelated folder is rejected at the door instead of silently
// returning an empty list forever.
function addDir(dir) {
  const abs = String(dir == null ? '' : dir).trim();
  if (!abs) {
    const err = new Error('dir is required');
    err.code = 'EBADINPUT';
    throw err;
  }
  const found = readUserDataDir(abs, 'custom');
  if (!found) {
    const err = new Error('not a Chrome user-data-dir: ' + abs);
    err.code = 'ENOTPROFILEDIR';
    throw err;
  }
  const store = readStore();
  const dirs = Array.isArray(store.dirs) ? store.dirs.slice() : [];
  if (!dirs.includes(abs)) dirs.push(abs);
  writeStore({ dirs });
  return { dir: abs, profiles: found.profiles.length };
}

// removeDir(dir) — unregister an extra user-data-dir. Only the extras
// list is touched: a per-platform candidate is discovered, not stored, so
// it needs no removal.
function removeDir(dir) {
  const abs = String(dir == null ? '' : dir).trim();
  const store = readStore();
  const dirs = Array.isArray(store.dirs) ? store.dirs : [];
  const next = dirs.filter((d) => d !== abs);
  // Endpoint overrides for profiles that lived in the removed directory
  // are dropped with it. Leaving them behind would let the same
  // directory name in *another* user-data-dir inherit a stale port.
  const endpoints = Object.assign({}, store.endpoints || {});
  let dropped = 0;
  for (const key of Object.keys(endpoints)) {
    if (key.startsWith(abs + '::')) { delete endpoints[key]; dropped++; }
  }
  const patch = { dirs: next, endpoints };
  if (typeof store.activeId === 'string' && store.activeId) {
    // `extraDirs: next` overrides the store's list for this one probe.
    // Without it the removed directory is still in `store.dirs` (the
    // write has not happened yet), so the scan would find the profile it
    // is supposed to be forgetting.
    const stillThere = listProfiles({ extraDirs: next }).profiles.some((p) => p.id === store.activeId);
    if (!stillThere) { patch.activeId = ''; patch.activeLabel = ''; }
  }
  writeStore(patch);
  return { dir: abs, removed: dirs.length !== next.length, endpoints: dropped };
}

module.exports = {
  APP_KEY_PROFILES,
  DEFAULT_PROFILE,
  PROFILE_DIR_RE,
  MOUAIF_PROFILE_DIR,
  candidateRoots,
  readUserDataDir,
  scanUserDataDirs,
  buildProfileList,
  listProfiles,
  resolveProfile,
  splitEndpoint,
  setProfileEndpoint,
  switchProfile,
  activeProfile,
  clearActive,
  addDir,
  removeDir
};
