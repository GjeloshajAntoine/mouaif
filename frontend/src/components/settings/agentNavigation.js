// Keep the editor's immediate caller separate from project settings' origin.
export function agentQuery({ projectDir = '', from = '', chatId = '', returnTo = '' } = {}) {
  const params = new URLSearchParams();
  if (projectDir) params.set('projectDir', projectDir);
  if (chatId) params.set('chatId', chatId);
  if (from) params.set('from', from);
  if (returnTo === 'project') params.set('returnTo', returnTo);
  return params.toString();
}
export function agentEditorPath(name, context) {
  const query = agentQuery(context);
  // `edit=1` disambiguates an existing agent literally named "new"; the `&`
  // is only used when there is something to join (a project-less context,
  // e.g. the Settings root, skips the `?`).
  return 'settings/agents/' + encodeURIComponent(name)
    + (query ? '?' + query : '')
    + (name === 'new' ? (query ? '&' : '?') + 'edit=1' : '');
}
export function agentBackPath(context) {
  return (context.returnTo === 'project' ? 'settings/project?' : 'settings/agents?')
    + agentQuery({ ...context, returnTo: '' });
}
