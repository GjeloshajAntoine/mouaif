// mouaif web — hash router
// No history API; the Node server doesn't rewrite unknown paths to
// index.html, so deep links would 404 anyway; the hash is enough.
import { route } from './api.js';

// Normalize the `from` query param shared by the project-scoped settings
// views. It records where the user entered project settings from (the
// Projects tab, or Settings → Projects) so the back button can return to
// that exact place even after a round-trip through a sub-page. Anything
// else is ignored so the back button falls through to the default target.
function fromParam(params) {
  const from = params.get('from') || '';
  return from === 'projects' || from === 'settings/projects' ? from : '';
}

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (!h) return { name: 'chats' };
  if (h === 'projects') return { name: 'chats' };
  if (h === 'settings') return { name: 'settings' };
  if (h === 'settings/access') return { name: 'settingsAccess' };
  if (h === 'auth') return { name: 'settings' };
  if (h === 'inspector') return { name: 'inspector' };
  if (h === 'settings/providers') return { name: 'settingsProviders' };
  if (h === 'settings/providers/new') return { name: 'settingsProviderNew' };
  if (h.startsWith('settings/providers/')) {
    const id = decodeURIComponent(h.slice('settings/providers/'.length));
    if (id && id !== 'new') return { name: 'settingsProviderEdit', id };
  }
  if (h === 'settings/project/technical' || h.startsWith('settings/project/technical?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsProjectTechnical', projectDir: params.get('projectDir') || '', chatId: params.get('chatId') || '', from: fromParam(params) };
  }
  // settings/project/output — "File tool options" (size / structure / JSON),
  // a sibling of Technical details under Settings → Project.
  if (h === 'settings/project/output' || h.startsWith('settings/project/output?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsProjectOutput', projectDir: params.get('projectDir') || '', from: fromParam(params) };
  }
// settings/project/preview — "Web preview", a sibling of File tool options
// and Technical details under Settings → Project.
if (h === 'settings/project/preview' || h.startsWith('settings/project/preview?')) {
const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
const params = new URLSearchParams(qs);
return { name: 'settingsProjectPreview', projectDir: params.get('projectDir') || '', from: fromParam(params) };
}
// settings/project/hide — "Hide file content", redaction rules for the
// agent file tools.
if (h === 'settings/project/hide' || h.startsWith('settings/project/hide?')) {
const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
const params = new URLSearchParams(qs);
return { name: 'settingsProjectHide', projectDir: params.get('projectDir') || '', from: fromParam(params) };
}
  // Legacy alias: agent editing used to live under settings/project.
  // Redirect to the standalone agents editor so old links keep working.
  if (h.startsWith('settings/project/agents/')) {
    const rest = h.slice('settings/project/agents/'.length);
    const [name, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return {
      name: 'settingsAgentEdit', id: decodeURIComponent(name),
      projectDir: params.get('projectDir') || '', from: fromParam(params),
      chatId: params.get('chatId') || '', returnTo: 'project',
      isNew: name === 'new' && params.get('edit') !== '1'
    };
  }
  if (h === 'settings/project' || h.startsWith('settings/project?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return {
      name: 'settingsProject',
      projectDir: params.get('projectDir') || '',
      chatId: params.get('chatId') || '',
      from: fromParam(params)
    };
  }
  // settings/agents is project-scoped (same resolution as prompts: the
  // active project is the default, ?projectDir= overrides).
  if (h === 'settings/agents' || h.startsWith('settings/agents?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return {
      name: 'settingsAgents',
      projectDir: params.get('projectDir') || '',
      chatId: params.get('chatId') || '',
      from: fromParam(params)
    };
  }
  if (h.startsWith('settings/agents/')) {
    const rest = h.slice('settings/agents/'.length);
    const [id, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return {
      name: 'settingsAgentEdit', id: decodeURIComponent(id),
      projectDir: params.get('projectDir') || '',
      from: fromParam(params),
      chatId: params.get('chatId') || '',
      returnTo: params.get('returnTo') === 'project' ? 'project' : '',
      isNew: id === 'new' && params.get('edit') !== '1'
    };
  }
  if (h === 'settings/actions' || h.startsWith('settings/actions?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsActions', projectDir: params.get('projectDir') || '', from: fromParam(params) };
  }
  if (h.startsWith('settings/actions/')) {
    const rest = h.slice('settings/actions/'.length);
    const [id, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return { name: 'settingsActionEdit', id: decodeURIComponent(id), projectDir: params.get('projectDir') || '', from: fromParam(params) };
  }
  if (h === 'settings/projects') return { name: 'settingsProjects' };
  if (h === 'settings/defaults') return { name: 'settingsDefaults' };
  if (h === 'settings/notifications') return { name: 'settingsNotifications' };
  // Legacy alias: the GitHub Copilot OAuth-app config used to live on its own
  // screen. It now lives inside the Copilot provider form, so keep old links
  // working by resolving straight to that provider's edit view.
  if (h === 'settings/copilot') return { name: 'settingsProviderEdit', id: 'github-copilot' };
  if (h === 'settings/pricing') return { name: 'settingsPricing' };
  // settings/prompts can be app-wide (Settings → App defaults → Custom prompts)
  // or project-scoped (Settings → This project → Custom prompts).
  if (h === 'settings/prompts' || h.startsWith('settings/prompts?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsPrompts', projectDir: params.get('projectDir') || '', id: '', scope: params.get('scope') || '', from: fromParam(params) };
  }
  if (h.startsWith('settings/prompts/')) {
    const rest = h.slice('settings/prompts/'.length);
    const [id, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return { name: 'settingsPrompts', id, projectDir: params.get('projectDir') || '', scope: params.get('scope') || '', from: fromParam(params) };
  }
  // #/settings/mcp/registry routes to the browse view (before the generic
  // settings/mcp match, which only catches hash === settings/mcp or ?qs).
  if (h === 'settings/mcp/registry' || h.startsWith('settings/mcp/registry?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsMcpRegistry', projectDir: params.get('projectDir') || '', from: fromParam(params) };
  }
  // settings/mcp lists servers in both scopes (app-wide + per project).
  // The active project is the source of truth for the Project tab; the
  // route hash can override it via ?projectDir=... for deep links and
  // tests. ?scope=app|project on the editor route pre-selects the scope
  // an add creates in (and tells an edit which list it came from).
  if (h === 'settings/mcp' || h.startsWith('settings/mcp?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsMcp', projectDir: params.get('projectDir') || '', from: fromParam(params) };
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
      scope: params.get('scope') === 'app' ? 'app' : (params.get('scope') === 'project' ? 'project' : ''),
      from: fromParam(params)
    };
  }
  if (h.startsWith('settings/mcp/')) {
    const rest = h.slice('settings/mcp/'.length);
    const [id, qs] = rest.split('?');
    const params = new URLSearchParams(qs || '');
    return {
      name: 'settingsMcpEdit', id,
      projectDir: params.get('projectDir') || '',
      scope: params.get('scope') === 'app' ? 'app' : (params.get('scope') === 'project' ? 'project' : ''),
      from: fromParam(params)
    };
  }
  if (h === 'settings/tags' || h.startsWith('settings/tags?')) {
    const qs = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    return { name: 'settingsTags', projectId: params.get('projectId') || '', projectDir: params.get('projectDir') || '' };
  }
  if (h === 'settings/about') return { name: 'settingsAbout' };
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
