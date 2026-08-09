// mouaif web — SettingsPromptsView + SettingsPromptEditView
//
// Both views are project-scoped. The active project is resolved in
// this order:
//   1. The `projectDir` prop passed in from the router (used by
//      deep links and tests).
//   2. The `activeProject` signal (set when the user opened a chat).
// If neither resolves, the view shows a "pick a project" empty
// state and never calls the API.
import { h, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { fetchJson, activeProject } from '../api.js';
import { nav } from '../router.js';

// Tool *family* names a prompt preset can enable. These mirror the
// per-chat tool filter (decisions: chat.tools) and the authorization
// family names in src/tools/authorization.js. File tools are all
// represented by their family id `file`.
const PRESET_TOOL_CHOICES = [
  { value: 'shell', label: 'Shell' },
  { value: 'file', label: 'File tools (read/list/search/write/edit)' },
  { value: 'subagent', label: 'Subagent' },
  { value: 'report_progress', label: 'Progress updates' },
  { value: 'task', label: 'Task' },
  { value: 'ask_user', label: 'Ask user' }
];

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
    try {
      const ta = document.createElement('textarea');
      ta.value = text || '';
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

function resolveProjectDir(view) {
  if (view && view.projectDir) return view.projectDir;
  return (activeProject.value && activeProject.value.dir) || '';
}

export function SettingsPromptsView(props) {
  const projectDir = resolveProjectDir(props);
  const [prompts, setPrompts] = useState([]);
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });

  function Copier({ text }) {
    const [status, setStatus] = useState('Copy');
    const doCopy = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyText(text);
      setStatus(ok ? 'Copied' : 'Copy failed');
      setTimeout(() => setStatus('Copy'), 1400);
    };
    return h('button', {
      type: 'button', class: 'prompt-row__copy' + (status === 'Copied' ? ' is-copied' : (status === 'Copy failed' ? ' is-error' : '')),
      'aria-label': 'Copy prompt to clipboard',
      onClick: doCopy
    }, status);
  }

  async function load() {
    if (!projectDir) {
      setPrompts([]);
      setStatusMsg({ text: 'open a chat to pick a project first', kind: 'error' });
      return;
    }
    setStatusMsg({ text: 'loading…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); return; }
    const list = r.body.prompts || [];
    setPrompts(list);
    setStatusMsg({ text: list.length + (list.length === 1 ? ' prompt' : ' prompts'), kind: 'success' });
  }

  useEffect(() => { load(); }, [projectDir]);

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
        h('h2', { class: 'view-title' }, 'Custom prompts')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'No project selected. Open a chat to pick a project, or use the picker to add a new one.'),
        h('div', { class: 'row row--actions' },
          h('a', { href: '#/projects/new', class: 'btn btn--primary' }, 'Open project picker')
        )
      )
    );
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back to project' }, '←'),
      h('h2', { class: 'view-title' }, 'Custom prompts')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, 'Per-project system prompts. Saved in the project\'s .mouaif.json alongside other settings.'),
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('ul', { class: 'prompts__list', 'aria-label': 'Custom prompts' },
        prompts.length === 0 ? h('li', { class: 'prompts__empty' }, 'No custom prompts yet. Tap "Add prompt" to create your first one.') : prompts.map(p => {
          let presetBadge = null;
          if (p.preset && Object.keys(p.preset).length) {
            const bits = [];
            if (Array.isArray(p.preset.tools) && p.preset.tools.length) {
              bits.push(p.preset.tools.map(t => {
                const choice = PRESET_TOOL_CHOICES.find(c => c.value === t);
                return choice ? choice.label : t;
              }).join(', '));
            }
            if (p.preset.agentFiles === true) bits.push('agent files on');
            presetBadge = h('div', { class: 'prompt-row__preset' }, 'preset: ' + bits.join(' · '));
          }
          return h('li', { key: p.id, class: 'prompt-row' },
            h('a', { class: 'prompt-row__main', href: '#/settings/prompts/' + encodeURIComponent(p.id) + '?projectDir=' + encodeURIComponent(projectDir) },
              h('div', { class: 'prompt-row__title' }, p.title || p.id),
              h('div', { class: 'prompt-row__meta' }, p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content),
              h('div', { class: 'prompt-row__chev' }, '›')
            ),
            presetBadge,
            h(Copier, { text: p.content })
          );
        })
      ),
      h('div', { class: 'row row--actions' },
        h('a', {
          href: '#/settings/prompts/new?projectDir=' + encodeURIComponent(projectDir),
          class: 'btn btn--primary'
        }, '+ Add prompt'),
        h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text)
      )
    )
  );
}

export function SettingsPromptEditView(props) {
  const promptId = (props && props.id) || '';
  const projectDir = resolveProjectDir(props);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [statusMsg, setStatusMsg] = useState({ text: '', kind: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // The preset lives in state so toggling a tool / the agent-files
  // checkbox re-renders the checklist. Loaded from the prompt record;
  // saved back into the prompt on Save.
  const [preset, setPreset] = useState(null);

  // presetActive() — is the preset feature on for this prompt at all?
  // A non-null object counts even if it momentarily has an empty tools
  // list and a false agentFiles (the Save path normalizes that away).
  function presetActive() {
    return !!preset;
  }

  function toolSelected(tool) {
    return !!(preset && Array.isArray(preset.tools) && preset.tools.includes(tool));
  }

  function toggleTool(tool, checked) {
    setPreset((prev) => {
      const base = prev || {};
      const tools = Array.isArray(base.tools) ? base.tools.slice() : (checked ? [] : []);
      if (checked && !tools.includes(tool)) tools.push(tool);
      if (!checked) {
        const i = tools.indexOf(tool);
        if (i >= 0) tools.splice(i, 1);
      }
      return { tools, agentFiles: base.agentFiles };
    });
  }

  // Turning on "apply preset" seeds an empty tools list so the toggle is
  // meaningful; turning it off clears the whole preset.
  function togglePresetOn(checked) {
    setPreset((prev) => {
      if (checked) {
        const base = prev || {};
        return { tools: Array.isArray(base.tools) ? base.tools.slice() : [], agentFiles: base.agentFiles };
      }
      return null;
    });
  }

  function toggleAgentFiles(checked) {
    // prev || { tools: [] } makes toggling agent-files on from an empty
    // state also activate the preset (non-null object).
    setPreset((prev) => Object.assign({}, prev || { tools: [] }, { agentFiles: checked }));
  }

  async function load() {
    if (!projectDir) {
      setStatusMsg({ text: 'no project selected', kind: 'error' });
      return;
    }
    if (!promptId) {
      // New prompt — nothing to load; refs are pre-cleared, preset empty.
      setTitle('');
      setContent('');
      setPreset(null);
      setStatusMsg({ text: '', kind: '' });
      return;
    }
    setStatusMsg({ text: 'loading…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); return; }
    const p = r.body.prompt;
    setTitle(p.title || '');
    setContent(p.content || '');
    setPreset(p.preset && (Array.isArray(p.preset.tools) || typeof p.preset.agentFiles === 'boolean') ? {
      tools: Array.isArray(p.preset.tools) ? p.preset.tools.slice() : [],
      agentFiles: p.preset.agentFiles
    } : null);
    setStatusMsg({ text: 'loaded', kind: 'success' });
  }

  async function save() {
    if (!projectDir) { setStatusMsg({ text: 'no project selected', kind: 'error' }); return; }
    const t = title.trim();
    const c = content.trim();
    if (!c) { setStatusMsg({ text: 'prompt content is required', kind: 'error' }); return; }
    setIsSaving(true);
    setStatusMsg({ text: 'saving…', kind: 'busy' });
    const body = { projectDir, title: t, content: c };
    // Persist the preset only when it is active; otherwise send an explicit
    // clear so a previously-saved preset is removed.
    if (presetActive()) {
      body.preset = {
        tools: (preset.tools || []).slice(),
        agentFiles: preset.agentFiles === true
      };
    } else {
      body.preset = null;
    }
    const url = promptId ? '/api/prompts/' + encodeURIComponent(promptId) : '/api/prompts';
    const method = promptId ? 'PATCH' : 'POST';
    let r;
    try { r = await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); setIsSaving(false); return; }
    setIsSaving(false);
    if (r.status !== 200 && r.status !== 201) { setStatusMsg({ text: 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), kind: 'error' }); return; }
    setStatusMsg({ text: 'saved.', kind: 'success' });
    if (!promptId && r.status === 201) {
      nav('settings/prompts/' + encodeURIComponent(r.body.prompt.id) + '?projectDir=' + encodeURIComponent(projectDir));
    }
  }

  async function deletePrompt() {
    if (!promptId) return;
    if (!projectDir) { setStatusMsg({ text: 'no project selected', kind: 'error' }); return; }
    if (!confirm('Delete this prompt? Chats that referenced it will fall back to no custom prompt.')) return;
    setIsDeleting(true);
    setStatusMsg({ text: 'deleting…', kind: 'busy' });
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' }); }
    catch (err) { setStatusMsg({ text: 'network error', kind: 'error' }); setIsDeleting(false); return; }
    if (r.status !== 200) { setStatusMsg({ text: 'HTTP ' + r.status, kind: 'error' }); setIsDeleting(false); return; }
    nav('settings/prompts?projectDir=' + encodeURIComponent(projectDir));
  }

  useEffect(() => { load(); }, [projectDir, promptId]);

  if (!projectDir) {
    return h(Fragment, null,
      h('div', { class: 'view-head' },
        h('a', { href: '#/settings/project', class: 'view-back', 'aria-label': 'Back' }, '←'),
        h('h2', { class: 'view-title' }, promptId ? 'Edit prompt' : 'Add prompt')
      ),
      h('section', null,
        h('p', { class: 'hint' }, 'No project selected. Open a chat to pick a project, or use the picker to add a new one.'),
        h('div', { class: 'row row--actions' },
          h('a', { href: '#/projects/new', class: 'btn btn--primary' }, 'Open project picker')
        )
      )
    );
  }

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/prompts?projectDir=' + encodeURIComponent(projectDir), class: 'view-back', 'aria-label': 'Back to prompts' }, '←'),
      h('h2', { class: 'view-title' }, promptId ? 'Edit prompt' : 'Add prompt')
    ),
    h('section', null,
      h('p', { class: 'hint hint--compact' }, h('code', null, projectDir)),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-title' }, 'Title'),
        h('input', { value: title, onInput: e => setTitle(e.target.value), class: 'input', id: 'spe-title', type: 'text', placeholder: 'My custom prompt' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-content' }, 'Prompt content'),
        h('textarea', { value: content, onInput: e => setContent(e.target.value), class: 'input prompts__textarea', id: 'spe-content', rows: 6, placeholder: 'You are a helpful assistant specialized in…' })
      ),
      // ---- Prompt preset ---------------------------------------------
      // A preset is chat-default packaging: when a chat references this
      // prompt, its tool allowlist and agent-files toggle ride along. It
      // only ADDS capability — a chat already inheriting all tools keeps
      // them, and the project's off/ask/allow gate stays authoritative.
      h('div', { class: 'row prompts__preset' },
        h('label', { class: 'prompts__preset-head' },
          h('span', { class: 'label prompt-label' }, 'Chat preset'),
          h('span', { class: 'prompts__preset-main' },
            h('label', { class: 'switch' },
              h('input', {
                id: 'spe-preset-on',
                type: 'checkbox',
                role: 'switch',
                'aria-checked': String(!!presetActive()),
                checked: !!presetActive(),
                onChange: (e) => togglePresetOn(e.currentTarget.checked)
              }),
              h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
            ),
            h('span', { class: 'prompts__preset-desc' }, 'Tools & agent files a chat gets when it uses this prompt.')
          )
        ),
        h('p', { class: 'hint hint--compact prompts__preset-note' }, 'Tools are additive — a chat that already has a tool keeps it, and the project’s Off/Ask/Allow still wins. Agent files inject AGENTS.md / CLAUDE.md.')
      ),
      !presetActive() ? null : h('div', { class: 'row prompts__preset-body' },
        h('label', { class: 'label', for: 'spe-preset-tools' }, 'Tools to enable'),
        h('div', { class: 'prompts__preset-tools', id: 'spe-preset-tools' },
          PRESET_TOOL_CHOICES.map((c) =>
            h('label', { key: c.value, class: 'prompts__preset-tool' },
              h('input', {
                type: 'checkbox',
                checked: toolSelected(c.value),
                onChange: (e) => toggleTool(c.value, e.currentTarget.checked)
              }),
              h('span', null, c.label)
            )
          )
        ),
        h('label', { class: 'prompts__preset-tool prompts__preset-agentfiles' },
          h('input', {
            type: 'checkbox',
            checked: !!(preset && preset.agentFiles),
            onChange: (e) => toggleAgentFiles(e.currentTarget.checked)
          }),
          h('span', null, 'Also enable agent files')
        )
      ),
      h('div', { class: 'row row--actions' },
        h('button', { class: 'btn btn--primary', type: 'button', onClick: save, disabled: isSaving }, promptId ? 'Save' : 'Create'),
        h('button', { class: 'btn btn--danger', type: 'button', onClick: deletePrompt, hidden: !promptId, disabled: isDeleting }, 'Delete'),
        h('span', { class: 'status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text)
      )
    )
  );
}
