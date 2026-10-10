// Opt-in defaults for unpinned delegations. Catalog browsing reuses the
// existing provider-qualified picker; mounting this component writes nothing.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchJson, fetchLiveModels } from '../api.js';
import { ModelPickerField } from './ModelPickerField.jsx';

export function SubagentModelDefaults({ projectDir, chatId, onProjectSaved }) {
  const [values, setValues] = useState(null);
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const [status, setStatus] = useState('Loading subagent defaults…');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setValues(null);
    const query = '?projectDir=' + encodeURIComponent(projectDir);
    async function load() {
      try {
        const [project, chat, saved, connections] = await Promise.all([
          fetchJson('/api/settings/resolved' + query),
          chatId ? fetchJson('/api/chats/' + encodeURIComponent(chatId) + query) : null,
          fetchJson('/api/ai/models' + query).catch(() => ({ body: {} })),
          fetchJson('/api/ai/models/providers').catch(() => ({ body: {} }))
        ]);
        if (project.status !== 200 || (chat && chat.status !== 200)) throw new Error('Cannot load defaults');
        if (cancelled) return;
        setValues({ project: project.body.resolved || {}, chat: chat ? chat.body.chat : {} });
        setStatus('Agent pins win over these defaults. Approval picks apply to one run only.');
        const ids = (connections.body.providers || []).map(provider => provider && provider.id).filter(Boolean);
        setProviders(ids);
        setModels(saved.body.models || []);
        const catalogs = await Promise.all(ids.map(async (provider) => {
          const groups = await Promise.all(['chat', 'image'].map(purpose =>
            fetchLiveModels(provider, { purpose }).catch(() => ({ models: [] }))));
          return groups.flatMap(group => (group.models || []).map(model => ({ ...model, provider })));
        }));
        if (!cancelled) setModels([...(saved.body.models || []), ...catalogs.flat()]);
      } catch (error) { if (!cancelled) setStatus(error.message || 'Cannot load defaults'); }
    }
    load();
    return () => { cancelled = true; };
  }, [projectDir, chatId]);

  async function onChange(scope, selection) {
    const patch = { subagentProviderId: selection ? selection.providerId : '', subagentModelId: selection ? selection.modelId : '' };
    setSaving(true);
    setStatus('Saving…');
    try {
      const response = await fetchJson(scope === 'chat' ? '/api/chats/' + encodeURIComponent(chatId) : '/api/settings/project', {
        method: scope === 'chat' ? 'PATCH' : 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir, ...patch })
      });
      if (response.status !== 200) throw new Error('HTTP ' + response.status);
      setValues(current => ({ ...current, [scope]: { ...current[scope], ...patch } }));
      if (scope === 'project' && onProjectSaved) onProjectSaved(response.body.project);
      setStatus('Saved. Agent pins still win; clearing follows the next default.');
    } catch (error) { setStatus('Not saved: ' + error.message); }
    finally { setSaving(false); }
  }
  return h('div', null,
    h('p', { class: 'hint hint--compact' }, 'Models for unpinned subagents'),
    values && ['project', ...(chatId ? ['chat'] : [])].map(scope => {
      const value = values[scope];
      return h('div', { class: 'row', key: scope },
        h('span', { class: 'label' }, scope === 'chat' ? 'This chat’s subagents' : 'Project subagents'),
        h(ModelPickerField, { models, extraProviders: providers, variant: 'sheet',
          value: value.subagentModelId ? { modelId: value.subagentModelId, providerId: value.subagentProviderId } : null,
          allowClear: true, clearLabel: scope === 'chat' ? 'Follow project default' : 'Same as the chat',
          ariaLabel: scope === 'chat' ? 'Default model for this chat’s subagents' : 'Project default model for subagents',
          disabled: saving, onChange: selection => onChange(scope, selection) })
      );
    }),
    h('p', { class: 'hint hint--compact', 'aria-live': 'polite' }, status)
  );
}
