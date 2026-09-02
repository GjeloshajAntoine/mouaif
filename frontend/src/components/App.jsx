// mouaif web — App shell, Header, BottomTab
import { h } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { route, activeProject, setActiveProject } from '../api.js';
import { nav } from '../router.js';
import { PwaBanners } from './PwaBanners.jsx';
import { SettingsHomeView } from './SettingsHome.jsx';
import { SettingsProvidersView, SettingsProviderEditView } from './SettingsProviders.jsx';
import { SettingsProjectView } from './SettingsProject.jsx';
import { SettingsDefaultsView } from './SettingsDefaults.jsx';
import { SettingsNotificationsView } from './SettingsNotifications.jsx';
import { SettingsAboutView } from './SettingsAbout.jsx';
import { AccessSettingsView } from './AccessAuth.jsx';
import { SettingsPromptsView } from './SettingsPrompts.jsx';
import { SettingsAgentsView, SettingsAgentEditView } from './SettingsAgents.jsx';
import { SettingsActionsView, SettingsActionEditView } from './SettingsActions.jsx';
import { SettingsMcpView } from './SettingsMcp.jsx';
import { SettingsMcpEditView } from './SettingsMcpEdit.jsx';
import { SettingsMcpRegistryView } from './SettingsMcpRegistry.jsx';
import { SettingsTagsView } from './SettingsTags.jsx';
import { SettingsPricingView } from './SettingsPricing.jsx';
import { SettingsProjectsView } from './SettingsProjects.jsx';
import { ProjectsView } from './Projects.jsx';
import { ProjectPickerView } from './ProjectPicker.jsx';
import { ChatView } from './chat/Chat.jsx';

const InspectorView = lazy(() => import('./Inspector.jsx').then((module) => ({ default: module.InspectorView })));
const ROUTES = {
chats: [ProjectsView],
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
settingsDefaults: [SettingsDefaultsView],
settingsNotifications: [SettingsNotificationsView],
settingsPrompts: [SettingsPromptsView, ({ projectDir, id = '', scope = '', from }) => ({ projectDir, initialId: id, scope, from })],
settingsAgents: [SettingsAgentsView, ({ projectDir, from }) => ({ projectDir, from })],
settingsAgentEdit: [SettingsAgentEditView, ({ id, projectDir, from }) => ({ id, projectDir, from })],
settingsActions: [SettingsActionsView, ({ projectDir, from }) => ({ projectDir, from })],
settingsActionEdit: [SettingsActionEditView, ({ id, projectDir, from }) => ({ id, projectDir, from })],
settingsMcp: [SettingsMcpView, ({ projectDir, from }) => ({ projectDir, from })],
settingsMcpEdit: [SettingsMcpEditView, ({ id, projectDir, scope, from }) => ({ id, projectDir, scope, from })],
settingsMcpRegistry: [SettingsMcpRegistryView, ({ projectDir, from }) => ({ projectDir, from })],
settingsTags: [SettingsTagsView, ({ projectId, projectDir }) => ({ projectId, projectDir })],
settingsPricing: [SettingsPricingView],
settingsProjects: [SettingsProjectsView],
settingsAccess: [AccessSettingsView],
settingsAbout: [SettingsAboutView]
};
const FULL_PAGE_ROUTES = new Set([
'chat', 'picker', ...Object.keys(ROUTES).filter((name) => name.startsWith('settings') && name !== 'settings')
]);
function renderRoute(view) {
if (view.name === 'inspector') return h(Suspense, {
fallback: h('p', { class: 'muted', role: 'status' }, 'Loading Inspector…')
}, h(InspectorView));
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
(view.chatId || '');
return h(View, { key: viewKey, ...(getProps ? getProps(view) : null) });
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
    h('ul', { class: 'app__tablist' },
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
const BrandMark = h('svg', {
viewBox: '-0.02 0 1.06 1.06',
width: 11,
height: 11,
fill: 'none',
stroke: 'currentColor',
'stroke-width': '0.20',
'stroke-linecap': 'round',
'stroke-linejoin': 'round',
'aria-hidden': 'true'
}, h('path', { d: 'M0.16 1 L0.16 0.32 L0.2 0.0 L0.38 0.0 L0.5 0.13 L0.5 0.44 L0.52 0.13 L0.64 0.0 L0.82 0.0 L0.86 0.32 L0.86 1' }));

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
