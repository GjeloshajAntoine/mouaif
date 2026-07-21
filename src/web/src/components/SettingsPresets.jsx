// mouaif web — Preset settings view
import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus, activeProject } from '../api.js';
import { nav } from '../router.js';

export function SettingsPresetsView({ projectDir: initialDir } = {}) {
  const dir = (initialDir || '').trim() || (activeProject.value && activeProject.value.dir) || '';
  const statusEl = useRef(null);
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [prompts, setPrompts] = useState([]);
  const [skills, setSkills] = useState([]);
  // Creation modal
  const [showCreate, setShowCreate] = useState(false);
  const createTitle = useRef(null);
  const createPromptId = useRef(null);
  const createToolsValue = useRef(null);
  const createSkillRefs = useRef({});
  const createStatus = useRef(null);

  async function load() {
    if (!dir) { setStatus(statusEl, 'no project selected', 'error'); setLoading(false); return; }
    setLoading(true);
    const [presetsR, promptsR, skillsR] = await Promise.all([
      fetchJson('/api/presets?projectDir=' + encodeURIComponent(dir)),
      fetchJson('/api/prompts?projectDir=' + encodeURIComponent(dir)),
      fetchJson('/api/skills?projectDir=' + encodeURIComponent(dir))
    ]);
    if (presetsR.status === 200) setPresets(Array.isArray(presetsR.body.presets) ? presetsR.body.presets : []);
    if (promptsR.status === 200) setPrompts(Array.isArray(promptsR.body.prompts) ? promptsR.body.prompts : []);
    if (skillsR.status === 200) setSkills(Array.isArray(skillsR.body.skills) ? skillsR.body.skills : []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    const title = createTitle.current && createTitle.current.value.trim();
    if (!title) { setStatus(createStatus, 'title required', 'error'); return; }
    const promptId = createPromptId.current && createPromptId.current.value || null;
    // Parse tools from comma-separated string
    const toolsStr = createToolsValue.current && createToolsValue.current.value.trim();
    const enabledTools = toolsStr ? toolsStr.split(',').map(s => s.trim()).filter(Boolean) : null;
    // Collect selected skills
    const selectedSkills = [];
    for (const [name, ref] of Object.entries(createSkillRefs.current)) {
      if (ref && ref.checked) selectedSkills.push(name);
    }
    setStatus(createStatus, 'creating…', 'busy');
    const r = await fetchJson('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir: dir, title, promptId, enabledTools, selectedSkills: selectedSkills.length ? selectedSkills : null })
    });
    if (r.status !== 201) { setStatus(createStatus, 'HTTP ' + r.status, 'error'); return; }
    setShowCreate(false);
    await load();
  }

  async function handleDelete(id) {
    if (!confirm('Delete this preset? Chats that reference it will keep their current settings.')) return;
    const r = await fetchJson('/api/presets/' + encodeURIComponent(id) + '?projectDir=' + encodeURIComponent(dir), { method: 'DELETE' });
    if (r.status !== 200) { setStatus(statusEl, 'delete failed', 'error'); return; }
    await load();
  }

  function skillCheckbox(name, title) {
    return h('label', { class: 'checkbox-row', style: 'display:flex;align-items:center;gap:6px;font-size:0.9rem;' },
      h('input', { type: 'checkbox', ref: el => { if (el) createSkillRefs.current[name] = el; }, 'aria-label': 'select skill ' + title }),
      h('span', null, title || name)
    );
  }

  return h('section', { class: 'settings-scroll' },
    h('div', { class: 'settings-header' },
      h('button', { type: 'button', class: 'settings-back', onClick: () => nav('settings'), 'aria-label': 'Back' }, '←'),
      h('h2', null, 'Agent presets'),
      h('span', { ref: statusEl, class: 'settings-status' })
    ),
    !dir
      ? h('p', { class: 'hint hint--compact' }, 'Open a chat or select a project first.')
      : loading
        ? h('p', { class: 'hint' }, 'Loading…')
        : h('div', { class: 'group' },
            h('div', { class: 'group__title' },
              'Presets (' + presets.length + ')',
              h('button', { type: 'button', class: 'btn btn--small', style: 'margin-left:8px', onClick: () => setShowCreate(true) }, '+ New')
            ),
            presets.length === 0
              ? h('p', { class: 'hint hint--compact' }, 'No presets yet. Create one to bundle a prompt, tool filter, and skill selection.')
              : h('ul', { class: 'group__list' },
                  presets.map(p =>
                    h('li', { key: p.id, class: 'card card--row' },
                      h('div', { class: 'card__main', style: 'flex:1' },
                        h('div', { class: 'card__title' }, p.title),
                        h('div', { class: 'card__summary', style: 'font-size:0.8rem;color:var(--text-secondary)' },
                          p.promptId ? 'prompt: ' + p.promptId + ' · ' : '',
                          p.enabledTools ? p.enabledTools.length + ' tool(s)' : 'all tools',
                          p.selectedSkills ? ' · ' + p.selectedSkills.length + ' skill(s)' : ''
                        )
                      ),
                      h('button', { type: 'button', class: 'btn btn--danger btn--small', onClick: () => handleDelete(p.id), 'aria-label': 'Delete ' + p.title }, '×')
                    )
                  )
                )
          ),
    // Create modal (inline overlay)
    showCreate && h('div', { class: 'overlay', style: 'padding:16px' },
      h('form', { onSubmit: handleCreate, class: 'form' },
        h('h3', null, 'New preset'),
        h('label', { class: 'field' },
          h('span', { class: 'field__label' }, 'Title *'),
          h('input', { ref: createTitle, type: 'text', class: 'input', required: true, placeholder: 'e.g. Code reviewer' })
        ),
        prompts.length > 0 && h('label', { class: 'field' },
          h('span', { class: 'field__label' }, 'Prompt'),
          h('select', { ref: createPromptId, class: 'input' },
            h('option', { value: '' }, '— none —'),
            prompts.map(p => h('option', { value: p.id }, p.title))
          )
        ),
        h('label', { class: 'field' },
          h('span', { class: 'field__label' }, 'Tool filter (comma-separated tool names, empty = all)'),
          h('input', { ref: createToolsValue, type: 'text', class: 'input', placeholder: 'e.g. shell, read_file, list_files' })
        ),
        skills.length > 0 && h('div', { class: 'field' },
          h('span', { class: 'field__label' }, 'Skills (check to include, none = all)'),
          skills.map(s => skillCheckbox(s.name, s.title))
        ),
        h('div', { class: 'field__actions' },
          h('button', { type: 'submit', class: 'btn btn--primary' }, 'Create'),
          h('button', { type: 'button', class: 'btn', onClick: () => setShowCreate(false) }, 'Cancel')
        ),
        h('span', { ref: createStatus, class: 'settings-status' })
      )
    )
  );
}