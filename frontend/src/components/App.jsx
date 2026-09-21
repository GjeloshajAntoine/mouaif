// mouaif web — App shell, Header, BottomTab
import { h } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { route, activeProject, setActiveProject } from '../api.js';
import { nav } from '../router.js';
import { PwaBanners } from './PwaBanners.jsx';
import { SettingsHomeView } from './SettingsHome.jsx';
import { AccessSettingsView } from './AccessAuth.jsx';
import { ProjectsView } from './Projects.jsx';
import { ProjectPickerView } from './ProjectPicker.jsx';
import { ChatView } from './chat/Chat.jsx';
// Lazy-load every heavyweight, rarely-opened settings sub-page so its
// code is excluded from the entry bundle that every chat session loads.
// The chat / projects path only ever reaches the settings tab and the
// cheap `SettingsHomeView` index, so none of these sub-pages need to be
// in the initial JS. This drops the entry index-*.js by most of the
// ~250 kB of settings UI (the rest of the reduction is bundles that were
// already lazy: Inspector, FileEditor, and the CodeMirror chunk).
// `lazyNamed` wraps dynamic import() in Preact's <Suspense>-compatible
// lazy() and maps the module's named export to the default slot that
// Preact expects.
const lazyNamed = (loader, name) => lazy(() => loader().then((m) => ({ default: m[name] })));
const InspectorView = lazy(() => import('./Inspector.jsx').then((module) => ({ default: module.InspectorView })));
const SettingsProvidersView = lazyNamed(() => import('./SettingsProviders.jsx'), 'SettingsProvidersView');
const SettingsProviderEditView = lazyNamed(() => import('./SettingsProviders.jsx'), 'SettingsProviderEditView');
const SettingsProjectView = lazyNamed(() => import('./SettingsProject.jsx'), 'SettingsProjectView');
const SettingsHiddenContentView = lazyNamed(() => import('./SettingsHiddenContent.jsx'), 'SettingsHiddenContentView');
const SettingsDefaultsView = lazyNamed(() => import('./SettingsDefaults.jsx'), 'SettingsDefaultsView');
const SettingsNotificationsView = lazyNamed(() => import('./SettingsNotifications.jsx'), 'SettingsNotificationsView');
const SettingsAboutView = lazyNamed(() => import('./SettingsAbout.jsx'), 'SettingsAboutView');
const SettingsPromptsView = lazyNamed(() => import('./SettingsPrompts.jsx'), 'SettingsPromptsView');
const SettingsAgentsView = lazyNamed(() => import('./SettingsAgents.jsx'), 'SettingsAgentsView');
const SettingsAgentEditView = lazyNamed(() => import('./SettingsAgents.jsx'), 'SettingsAgentEditView');
const SettingsActionsView = lazyNamed(() => import('./SettingsActions.jsx'), 'SettingsActionsView');
const SettingsActionEditView = lazyNamed(() => import('./SettingsActions.jsx'), 'SettingsActionEditView');
const SettingsMcpView = lazyNamed(() => import('./SettingsMcp.jsx'), 'SettingsMcpView');
const SettingsMcpEditView = lazyNamed(() => import('./SettingsMcpEdit.jsx'), 'SettingsMcpEditView');
const SettingsMcpRegistryView = lazyNamed(() => import('./SettingsMcpRegistry.jsx'), 'SettingsMcpRegistryView');
const SettingsTagsView = lazyNamed(() => import('./SettingsTags.jsx'), 'SettingsTagsView');
const SettingsPricingView = lazyNamed(() => import('./SettingsPricing.jsx'), 'SettingsPricingView');
const SettingsProjectsView = lazyNamed(() => import('./SettingsProjects.jsx'), 'SettingsProjectsView');
const DictationView = lazyNamed(() => import('./DictationPage.jsx'), 'DictationView');
const ROUTES = {
chats: [ProjectsView],
// Dictation is a settings sub-page now (Settings → App defaults → Dictation),
// so it is lazy like the rest of them: the mic-recording helpers the chat
// composer shares live in `frontend/src/dictation.js`, not here, so the chat
// path no longer pays for this page's code.
settingsDictation: [DictationView],
inspector: [InspectorView],
picker: [ProjectPickerView, ({ dir }) => ({ dir })],
chat: [ChatView, ({ chatId, projectDir }) => ({ chatId, projectDir })],
settings: [SettingsHomeView],
settingsProviders: [SettingsProvidersView],
settingsProviderNew: [SettingsProviderEditView, () => ({ id: '' })],
settingsProviderEdit: [SettingsProviderEditView, ({ id }) => ({ id })],
settingsProject: [SettingsProjectView, ({ projectDir, chatId, from }) => ({ projectDir, chatId, from })],
settingsProjectTechnical: [SettingsProjectView, ({ projectDir, chatId, from }) => ({ projectDir, chatId, from, page: 'technical' })],
settingsProjectOutput: [SettingsProjectView, ({ projectDir, from }) => ({ projectDir, from, page: 'output' })],
settingsProjectPreview: [SettingsProjectView, ({ projectDir, from }) => ({ projectDir, from, page: 'preview' })],
settingsProjectHide: [SettingsHiddenContentView, ({ projectDir, from, filePath }) => ({ projectDir, from, filePath })],
settingsDefaults: [SettingsDefaultsView],
settingsNotifications: [SettingsNotificationsView],
settingsPrompts: [SettingsPromptsView, ({ projectDir, id = '', scope = '', from }) => ({ projectDir, initialId: id, scope, from })],
settingsAgents: [SettingsAgentsView, ({ projectDir, from, chatId }) => ({ projectDir, from, chatId })],
settingsAgentEdit: [SettingsAgentEditView, ({ id, projectDir, from, chatId, returnTo, isNew }) => ({ id, projectDir, from, chatId, returnTo, isNew })],
settingsActions: [SettingsActionsView, ({ projectDir, from }) => ({ projectDir, from })],
settingsActionEdit: [SettingsActionEditView, ({ id, projectDir, from }) => ({ id, projectDir, from })],
settingsMcp: [SettingsMcpView, ({ projectDir, from }) => ({ projectDir, from })],
settingsMcpEdit: [SettingsMcpEditView, ({ id, projectDir, scope, from }) => ({ id, projectDir, scope, from })],
settingsMcpRegistry: [SettingsMcpRegistryView, ({ projectDir, from }) => ({ projectDir, from })],
settingsTags: [SettingsTagsView, ({ projectId, projectDir }) => ({ projectId, projectDir })],
settingsPricing: [SettingsPricingView],
settingsProjects: [SettingsProjectsView],
settingsAccess: [AccessSettingsView],
// The access screens are rendered inside AccessGate, before a session
// exists, so this entry only keeps the App shell on the default chat list
// for that hash.
disableAccess: [AccessSettingsView],
setup: [ProjectsView],
settingsAbout: [SettingsAboutView]
};
const FULL_PAGE_ROUTES = new Set([
'chat', 'picker', 'disableAccess', 'setup', ...Object.keys(ROUTES).filter((name) => name.startsWith('settings') && name !== 'settings')
]);
// Set of route names whose view component is a Preact lazy() component.
// Only these need a <Suspense> boundary; the eager views resolve
// synchronously so the fallback never paints for them.
const LAZY_ROUTE_NAMES = new Set([
'inspector', 'settingsDictation',
'settingsProviders', 'settingsProviderNew', 'settingsProviderEdit',
'settingsProject', 'settingsProjectTechnical', 'settingsProjectOutput', 'settingsProjectPreview', 'settingsProjectHide',
'settingsDefaults', 'settingsNotifications', 'settingsAbout',
'settingsPrompts', 'settingsAgents', 'settingsAgentEdit',
'settingsActions', 'settingsActionEdit',
'settingsMcp', 'settingsMcpEdit', 'settingsMcpRegistry',
'settingsTags', 'settingsPricing', 'settingsProjects'
]);
function renderRoute(view) {
const [View = ProjectsView, getProps] = ROUTES[view.name] || [];
// Key the view on its identity parameters so navigating to the same route
// with a different projectDir / id / scope remounts it (fresh state + refs).
// Without this, e.g. #/settings/prompts ⇄ #/settings/prompts?projectDir=…
// reuse one component instance and leave stale selection/state behind.
const viewKey = view.name + '|' +
(view.projectDir || '') + '|' +
(view.id || '') + '|' +
(view.scope || '') + '|' +
(view.page || '') + '|' +
(view.chatId || '') + '|' + (view.isNew ? 'new' : '');
const node = h(View, { key: viewKey, ...(getProps ? getProps(view) : null) });
if (!LAZY_ROUTE_NAMES.has(view.name)) return node;
return h(Suspense, {
fallback: h('p', { class: 'muted', role: 'status' }, 'Loading…')
}, node);
}
// ---- Tab icons ---------------------------------------------------------
const TabIcon = {
  chats: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9.5l-3.72 3.72A1 1 0 0 1 4 22.56V18H5a3 3 0 0 1-3-3V5Z', fill: 'currentColor' })),
  inspector: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
  h('path', { d: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 3v2h16V7H4Zm0 4v2h7v-2H4Zm0 4v2h7v-2H4Zm9 0v2h7v-2h-7Z', fill: 'currentColor' })),
  settings: h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    h('path', { d: 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88L2.78 14.16a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.04-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z', fill: 'currentColor' }))
};

function BottomNav() {
  const view = route.value;
  const tabs = [
  { to: 'projects', name: 'chats', label: 'Chats' },
  { to: 'inspector', name: 'inspector', label: 'Inspector' },
  { to: 'settings', name: 'settings', label: 'Settings' }
  ];
  return h('nav', { class: 'app__tabbar', 'aria-label': 'Primary' },
  h('ul', {
    class: 'app__tablist',
    // The grid's column count comes from the tab list itself, so this
    // array stays the only place a tab is declared (see layout.css).
    style: { '--tab-count': tabs.length }
  },
      tabs.map(t => h('li', { class: 'app__tabitem' },
        h('a', {
          href: '#/' + t.to,
          class: 'app__tab' + (view.name === t.name ? ' is-active' : ''),
          'aria-current': view.name === t.name ? 'page' : null
        },
          h('span', { class: 'app__tab-icon' }, TabIcon[t.name]),
          h('span', { class: 'app__tab-label' }, t.label)
        )
      ))
    )
  );
}

// The brand mark inside the header logo — the same round-capped "m"
// stroke used by the PWA icon generator (frontend/build/generate-icons.js)
// for small tiles, so the in-app logo and the launcher icon stay in sync.
// Geometric angled "M" mark — a clean, angular brand glyph that stays
// legible at the 16px header size. Distinct from the lowercase "m" the
// PWA launcher uses, so the in-app header reads as its own mark.
const BrandMark = h('svg', {
viewBox: '-0.05 0.04 1.16 1.04',
width: 11,
height: 11,
fill: 'none',
stroke: 'currentColor',
'stroke-width': '0.17',
'stroke-linecap': 'round',
'stroke-linejoin': 'round',
'aria-hidden': 'true'
}, h('path', { d: 'M0.16 0.98 L0.16 0.14 L0.50 0.62 L0.84 0.14 L0.84 0.98' }));

function Header() {
  return h('header', { class: 'app__header' },
    h('div', { class: 'app__brand' },
      h('span', { class: 'app__logo', 'aria-hidden': 'true' }, BrandMark),
      h('h1', { class: 'app__title' }, 'mouaif')
    )
  );
}

export function App() {
  const view = route.value;
  // Detect OAuth sign-in completion from the redirect-back flow (iOS PWA /
  // popup-blocked fallback). When startSignIn() redirects the current page to
  // the OAuth provider, the callback handler auto-redirects back to /
  // after the exchange completes. On mount, check sessionStorage for a
  // pending-oauth marker and, if found, navigate to the provider settings so
  // the user sees the signed-in account without having to find the provider
  // manually. The marker is removed after one read so a subsequent page
  // reload doesn't re-trigger the navigation.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('oauthPending');
      if (!raw) return;
      sessionStorage.removeItem('oauthPending');
      const pending = JSON.parse(raw);
      if (pending && pending.provider && Date.now() - (pending.started || 0) < 10 * 60 * 1000) {
        // Navigate only if the user isn't already on a deeper route
        // (e.g. they navigated away after the sign-in completed).
        if (view.name === 'chats' || view.name === 'settings' || view.name === 'settingsProviders') {
          nav('settings/providers/' + encodeURIComponent(pending.provider));
        }
      }
    } catch (_) { /* sessionStorage unavailable */ }
  }, []);

  // Track the active project so SettingsPrompts (and any other
  // project-scoped view reached from Settings) can resolve the
  // project directory without asking the user to type it. The chat
  // route is the authoritative source; the picker route is a
  // tentative "the user is browsing this folder" signal.
  const chatDir = (view.name === 'chat' && view.projectDir) || '';
  useEffect(() => {
    if (chatDir && chatDir !== activeProject.value.dir) setActiveProject(chatDir, '');
  }, [chatDir]);
    const showTabBar = !FULL_PAGE_ROUTES.has(view.name);
  const body = renderRoute(view);
  return h('div', { class: 'app__shell' },
    h(Header, null),
    h(PwaBanners, null),
    h('main', {
      class: 'app__main'
        + (showTabBar ? '' : ' app__main--flush')
        + (view.name === 'chat' ? ' app__main--chat' : '')
    }, body),
    showTabBar ? h(BottomNav, null) : null
  );
}
