// mouaif web — built-in prompt launchers
//
// The built-in prompt-size profiles (Very small / Average / Extensive /
// Chat) are not custom prompts: their text is fixed server-side. They can
// still carry the two launcher fields a custom prompt has — an `icon` and
// `showOnProjectCard` — so a project card can offer a one-tap "new chat
// with this prompt style" button.
//
// Stored under the `profileLaunchers` settings key, in the app store or in
// the project's `.mouaif.json` (project wins, per the normal
// defaults -> app -> project resolution):
//
//   { "profileLaunchers": { "chat": { "icon": "pencil", "showOnProjectCard": true } } }
//
// Pure helpers only; exercised by scripts/test-profile-launchers.mjs.

export const PROFILE_PREFIX = 'profile:';
export const DEFAULT_LAUNCHER_ICON = 'sparkles';
const ICON_IDS = ['sparkles', 'code', 'search', 'pencil', 'bug', 'book'];

// normalizeLauncher(raw) -> { icon, showOnProjectCard }
export function normalizeLauncher(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    icon: ICON_IDS.includes(r.icon) ? r.icon : DEFAULT_LAUNCHER_ICON,
    showOnProjectCard: r.showOnProjectCard === true
  };
}

// readLaunchers(value) -> { [profileId]: { icon, showOnProjectCard } }
// Drops anything that is not a plain object keyed by a non-empty id.
export function readLaunchers(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const id of Object.keys(value)) {
    if (!id) continue;
    const entry = value[id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    out[id] = normalizeLauncher(entry);
  }
  return out;
}

// launcherSource({ app, project }, id, hasProject) -> 'project' | 'app'
// Where the effective value for `id` comes from, which is also where the
// editor saves by default: the project when it overrides the id (or when
// nobody has set it yet on a project screen), else the app store.
export function launcherSource(maps, id, hasProject) {
  const project = (maps && maps.project) || {};
  const app = (maps && maps.app) || {};
  if (hasProject && Object.prototype.hasOwnProperty.call(project, id)) return 'project';
  if (Object.prototype.hasOwnProperty.call(app, id)) return 'app';
  return hasProject ? 'project' : 'app';
}

// effectiveLauncher({ app, project }, id, hasProject) -> { icon, showOnProjectCard }
export function effectiveLauncher(maps, id, hasProject) {
  const project = (maps && maps.project) || {};
  const app = (maps && maps.app) || {};
  if (hasProject && project[id]) return normalizeLauncher(project[id]);
  return normalizeLauncher(app[id]);
}

// withLauncher(map, id, entry) -> a new map with `id` set to `entry`.
export function withLauncher(map, id, entry) {
  const next = Object.assign({}, readLaunchers(map));
  next[id] = normalizeLauncher(entry);
  return next;
}

// pinnedProfiles(profiles, resolvedLaunchers) -> [{ id, label, icon }]
// The built-in prompts the project card should show, in profile order.
export function pinnedProfiles(profiles, resolvedLaunchers) {
  const map = readLaunchers(resolvedLaunchers);
  return (Array.isArray(profiles) ? profiles : [])
    .filter((p) => p && p.id && map[p.id] && map[p.id].showOnProjectCard)
    .map((p) => ({ id: p.id, label: p.label || p.id, icon: map[p.id].icon }));
}
