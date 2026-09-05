// Keep the editor's immediate caller separate from project settings' origin.
export function agentQuery({ projectDir = '', from = '', chatId = '', returnTo = '' } = {}) {
  const params = new URLSearchParams({ projectDir });
  if (chatId) params.set('chatId', chatId);
  if (from) params.set('from', from);
  if (returnTo === 'project') params.set('returnTo', returnTo);
  return params.toString();
}
export function agentEditorPath(name, context) {
  return 'settings/agents/' + encodeURIComponent(name) + '?' + agentQuery(context)
    + (name === 'new' ? '&edit=1' : '');
}
export function agentBackPath(context) {
  return (context.returnTo === 'project' ? 'settings/project?' : 'settings/agents?')
    + agentQuery({ ...context, returnTo: '' });
}
