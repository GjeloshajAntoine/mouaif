// mouaif web — App shell, Header, BottomTab
import { h, Fragment } from 'preact';
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

function Header() {
  return h('header', { class: 'app__header' },
    h('div', { class: 'app__brand' },
      h('span', { class: 'app__logo', 'aria-hidden': 'true' }, 'm'),
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
  const showTabBar = view.name !== 'chat' && view.name !== 'picker'
    && view.name !== 'settingsProviders' && view.name !== 'settingsProviderNew'
    && view.name !== 'settingsProviderEdit' && view.name !== 'settingsProject'
    && view.name !== 'settingsProjectTechnical'
    && view.name !== 'settingsProjectOutput'
    && view.name !== 'settingsDefaults' && view.name !== 'settingsNotifications'
    && view.name !== 'settingsPrompts'
    && view.name !== 'settingsAgents' && view.name !== 'settingsAgentEdit'
    && view.name !== 'settingsMcp' && view.name !== 'settingsMcpEdit' && view.name !== 'settingsMcpRegistry'
    && view.name !== 'settingsTags'
    && view.name !== 'settingsPricing'
    && view.name !== 'settingsProjects'
    && view.name !== 'settingsAccess'
    && view.name !== 'settingsAbout';
  let body = null;
  if (view.name === 'chats') body = h(ProjectsView, null);
  else if (view.name === 'picker') body = h(ProjectPickerView, { dir: view.dir });
  else if (view.name === 'chat') body = h(ChatView, { chatId: view.chatId, projectDir: view.projectDir });
  else if (view.name === 'settings') body = h(SettingsHomeView, null);
  else if (view.name === 'settingsProviders') body = h(SettingsProvidersView, null);
  else if (view.name === 'settingsProviderNew') body = h(SettingsProviderEditView, { id: '' });
  else if (view.name === 'settingsProviderEdit') body = h(SettingsProviderEditView, { id: view.id });
  else if (view.name === 'settingsProject') body = h(SettingsProjectView, { projectDir: view.projectDir, chatId: view.chatId });
  else if (view.name === 'settingsProjectTechnical') body = h(SettingsProjectView, { projectDir: view.projectDir, page: 'technical', chatId: view.chatId });
  else if (view.name === 'settingsProjectOutput') body = h(SettingsProjectView, { projectDir: view.projectDir, page: 'output' });
  else if (view.name === 'settingsDefaults') body = h(SettingsDefaultsView, null);
  else if (view.name === 'settingsNotifications') body = h(SettingsNotificationsView, null);
  else if (view.name === 'settingsPrompts') body = h(SettingsPromptsView, { projectDir: view.projectDir, initialId: view.id || '', scope: view.scope || '' });
  else if (view.name === 'settingsAgents') body = h(SettingsAgentsView, { projectDir: view.projectDir });
  else if (view.name === 'settingsAgentEdit') body = h(SettingsAgentEditView, { id: view.id, projectDir: view.projectDir });
  else if (view.name === 'settingsMcp') body = h(SettingsMcpView, { projectDir: view.projectDir });
  else if (view.name === 'settingsMcpEdit') body = h(SettingsMcpEditView, { id: view.id, projectDir: view.projectDir, scope: view.scope });
  else if (view.name === 'settingsMcpRegistry') body = h(SettingsMcpRegistryView, { projectDir: view.projectDir });
  else if (view.name === 'settingsTags') body = h(SettingsTagsView, { projectId: view.projectId, projectDir: view.projectDir });
  else if (view.name === 'settingsPricing') body = h(SettingsPricingView, null);
  else if (view.name === 'settingsProjects') body = h(SettingsProjectsView, null);
  else if (view.name === 'settingsAccess') body = h(AccessSettingsView, null);
  else if (view.name === 'settingsAbout') body = h(SettingsAboutView, null);
  else if (view.name === 'inspector') body = h(Suspense, {
    fallback: h('p', { class: 'muted', role: 'status' }, 'Loading Inspector…')
  }, h(InspectorView, null));
  else body = h(ProjectsView, null);
  return h('div', { class: 'app__shell' },
    h(Header, null),
    h(PwaBanners, null),
    h('main', { class: 'app__main' + (showTabBar ? '' : ' app__main--flush') }, body),
    showTabBar ? h(BottomNav, null) : null
  );
}