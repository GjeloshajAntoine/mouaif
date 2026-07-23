// mouaif web — hash router
// No history API; the Node server doesn't rewrite unknown paths to
// index.html, so deep links would 404 anyway; the hash is enough.
import { route } from './api.js';

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (!h) return { name: 'chats' };
  if (h === 'projects') return { name: 'chats' };
  if (h === 'settings') return { name: 'settings' };
  if (h === 'auth') return { name: 'settings' };
  if (h === 'inspector') return { name: 'inspector' };
  if (h === 'settings/providers') return { name: 'settingsProviders' };
  if (h === 'settings/providers/new') return { name: 'settingsProviderNew' };
  if (h.startsWith('settings/providers/')) {
    const id = decodeURIComponent(h.slice('settings/providers/'.length));
    if (id && id !== 'new') return { name: 'settingsProviderEdit', id };
  }
  if (h === 'settings/project' || h.startsWith('settings/project?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsProject', projectDir: params.get('projectDir') || '', chatId: params.get('chatId') || '' };
  }
  if (h === 'settings/defaults') return { name: 'settingsDefaults' };
  if (h === 'settings/notifications') return { name: 'settingsNotifications' };
  // Legacy alias: the GitHub Copilot OAuth-app config used to live on its own
  // screen. It now lives inside the Copilot provider form, so keep old links
  // working by resolving straight to that provider's edit view.
  if (h === 'settings/copilot') return { name: 'settingsProviderEdit', id: 'github-copilot' };
  if (h === 'settings/pricing') return { name: 'settingsPricing' };
  // settings/prompts is project-scoped. The active project (set when
  // the user opened a chat or visited Settings → Project) is the
  // source of truth. The route hash can override it for testing
  // (e.g. settings/prompts?projectDir=...).
  if (h === 'settings/prompts' || h.startsWith('settings/prompts?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsPrompts', projectDir: params.get('projectDir') || '' };
  }
  if (h.startsWith('settings/prompts/')) {
    const rest = h.slice('settings/prompts/'.length);
    const [id, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return { name: 'settingsPromptEdit', id, projectDir: params.get('projectDir') || '' };
  }
  // #/settings/mcp/registry routes to the browse view (before the generic
  // settings/mcp match, which only catches hash === settings/mcp or ?qs).
  if (h === 'settings/mcp/registry' || h.startsWith('settings/mcp/registry?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsMcpRegistry', projectDir: params.get('projectDir') || '' };
  }
  // settings/mcp lists servers in both scopes (app-wide + per project).
  // The active project is the source of truth for the Project tab; the
  // route hash can override it via ?projectDir=... for deep links and
  // tests. ?scope=app|project on the editor route pre-selects the scope
  // an add creates in (and tells an edit which list it came from).
  if (h === 'settings/mcp' || h.startsWith('settings/mcp?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsMcp', projectDir: params.get('projectDir') || '' };
  }
  // "New" must be checked before the generic /:id match so that
  // #/settings/mcp/new?scope=... does not look up a server with id
  // "new" and fail with "Server not found".
  if (h === 'settings/mcp/new' || h.startsWith('settings/mcp/new?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return {
      name: 'settingsMcpEdit', id: '',
      projectDir: params.get('projectDir') || '',
      scope: params.get('scope') === 'app' ? 'app' : (params.get('scope') === 'project' ? 'project' : '')
    };
  }
  if (h.startsWith('settings/mcp/')) {
    const rest = h.slice('settings/mcp/'.length);
    const [id, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return {
      name: 'settingsMcpEdit', id,
      projectDir: params.get('projectDir') || '',
      scope: params.get('scope') === 'app' ? 'app' : (params.get('scope') === 'project' ? 'project' : '')
    };
  }
  // settings/tags is project-scoped (file tagging, decisions §15). It
  // needs the registered project id for the REST surface plus the path
  // for display. Both ride the query string.
  if (h === 'settings/tags' || h.startsWith('settings/tags?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsTags', projectId: params.get('projectId') || '', projectDir: params.get('projectDir') || '' };
  }
  if (h === 'settings/about') return { name: 'settingsAbout' };
  if (h === 'settings/client-domains' || h.startsWith('settings/client-domains?')) {
    return { name: 'settingsClientDomains' };
  }
  if (h === 'settings/client-domains/new' || h.startsWith('settings/client-domains/new?')) {
    return { name: 'settingsClientDomainNew' };
  }
  if (h.startsWith('settings/client-domains/')) {
    const rest = h.slice('settings/client-domains/'.length);
    const [id, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return { name: 'settingsClientDomainEdit', id, projectDir: params.get('projectDir') || '' };
  }
  if (h === 'settings/project/import' || h.startsWith('settings/project/import?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsImport', projectDir: params.get('projectDir') || '' };
  }
  if (h.startsWith('chat/')) {
    const rest = h.slice('chat/'.length);
    const [chatId, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return { name: 'chat', chatId, projectDir: params.get('projectDir') || '' };
  }
  if (h.startsWith('projects/new')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'picker', dir: params.get('dir') || '' };
  }
  return { name: 'chats' };
}

route.value = parseHash();

window.addEventListener('hashchange', () => { route.value = parseHash(); });

export function nav(toHash) {
  window.location.hash = '#/' + toHash;
}