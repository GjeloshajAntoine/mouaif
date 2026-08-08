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
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus, activeProject } from '../api.js';
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
  const listEl = useRef(null);
  const statusEl = useRef(null);

  async function load() {
    if (!projectDir) {
      if (listEl.current) listEl.current.innerHTML = '';
      setStatus(statusEl, 'open a chat to pick a project first', 'error');
      return;
    }
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
    const list = r.body.prompts || [];
    renderList(list);
    setStatus(statusEl, list.length + (list.length === 1 ? ' prompt' : ' prompts'), 'success');
  }

  function renderList(list) {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'prompts__empty';
      li.textContent = 'No custom prompts yet. Tap "Add prompt" to create your first one.';
      listEl.current.appendChild(li);
      return;
    }
    for (const p of list) {
      const li = document.createElement('li');
      li.className = 'prompt-row';
      const main = document.createElement('a');
      main.className = 'prompt-row__main';
      main.href = '#/settings/prompts/' + encodeURIComponent(p.id) + '?projectDir=' + encodeURIComponent(projectDir);
      const name = document.createElement('div');
      name.className = 'prompt-row__title';
      name.textContent = p.title || p.id;
      const meta = document.createElement('div');
      meta.className = 'prompt-row__meta';
      meta.textContent = p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content;
      main.appendChild(name);
      main.appendChild(meta);
      const chev = document.createElement('div');
      chev.className = 'prompt-row__chev';
      chev.textContent = '›';
      main.appendChild(chev);
      li.appendChild(main);
      // Preset status badge — "preset: shell, file · files on" or nothing.
      if (p.preset && (Object.keys(p.preset).length)) {
        const badge = document.createElement('div');
        badge.className = 'prompt-row__preset';
        const bits = [];
        if (Array.isArray(p.preset.tools) && p.preset.tools.length) {
          bits.push(p.preset.tools.map((t) => {
            const choice = PRESET_TOOL_CHOICES.find((c) => c.value === t);
            return choice ? choice.label : t;
          }).join(', '));
        }
        if (p.preset.agentFiles === true) bits.push('agent files on');
        badge.textContent = 'preset: ' + bits.join(' · ');
        li.appendChild(badge);
      }
      // Copy-to-clipboard is a standalone action, not part of the row tap
      // (the row navigates to the editor). A stopPropagation isn't needed —
      // the button is a sibling of the link.
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'prompt-row__copy';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', 'Copy prompt to clipboard');
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ok = await copyText(p.content);
        copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        copyBtn.classList.add(ok ? 'is-copied' : 'is-error');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('is-copied', 'is-error');
        }, 1400);
      });
      li.appendChild(copyBtn);
      listEl.current.appendChild(li);
    }
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
      h('ul', { ref: listEl, class: 'prompts__list', 'aria-label': 'Custom prompts' }),
      h('div', { class: 'row row--actions' },
        h('a', {
          href: '#/settings/prompts/new?projectDir=' + encodeURIComponent(projectDir),
          class: 'btn btn--primary'
        }, '+ Add prompt'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}

export function SettingsPromptEditView(props) {
  const promptId = (props && props.id) || '';
  const projectDir = resolveProjectDir(props);
  const titleRef = useRef(null);
  const contentRef = useRef(null);
  const saveBtn = useRef(null);
  const deleteBtn = useRef(null);
  const statusEl = useRef(null);
  // The preset lives in state so toggling a tool / the agent-files
  // checkbox re-renders the checklist. Loaded from the prompt record;
  // saved back into the prompt on Save.
  const [preset, setPreset] = useState(null);
  const agentFilesRef = useRef(null);

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
      setStatus(statusEl, 'no project selected', 'error');
      return;
    }
    if (!promptId) {
      // New prompt — nothing to load; refs are pre-cleared, preset empty.
      if (titleRef.current) titleRef.current.value = '';
      if (contentRef.current) contentRef.current.value = '';
      setPreset(null);
      setStatus(statusEl, '', '');
      return;
    }
    setStatus(statusEl, 'loading…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir)); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); return; }
    const p = r.body.prompt;
    if (titleRef.current) titleRef.current.value = p.title || '';
    if (contentRef.current) contentRef.current.value = p.content || '';
    setPreset(p.preset && (Array.isArray(p.preset.tools) || typeof p.preset.agentFiles === 'boolean') ? {
      tools: Array.isArray(p.preset.tools) ? p.preset.tools.slice() : [],
      agentFiles: p.preset.agentFiles
    } : null);
    setStatus(statusEl, 'loaded', 'success');
  }

  async function save() {
    if (!projectDir) { setStatus(statusEl, 'no project selected', 'error'); return; }
    const title = (titleRef.current && titleRef.current.value || '').trim();
    const content = (contentRef.current && contentRef.current.value || '').trim();
    if (!content) { setStatus(statusEl, 'prompt content is required', 'error'); return; }
    if (saveBtn.current) saveBtn.current.disabled = true;
    setStatus(statusEl, 'saving…', 'busy');
    const body = { projectDir, title, content };
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
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (saveBtn.current) saveBtn.current.disabled = false; return; }
    if (saveBtn.current) saveBtn.current.disabled = false;
    if (r.status !== 200 && r.status !== 201) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ': ' + r.body.error : ''), 'error'); return; }
    setStatus(statusEl, 'saved.', 'success');
    if (!promptId && r.status === 201) {
      nav('settings/prompts/' + encodeURIComponent(r.body.prompt.id) + '?projectDir=' + encodeURIComponent(projectDir));
    }
  }

  async function deletePrompt() {
    if (!promptId) return;
    if (!projectDir) { setStatus(statusEl, 'no project selected', 'error'); return; }
    if (!confirm('Delete this prompt? Chats that referenced it will fall back to no custom prompt.')) return;
    if (deleteBtn.current) deleteBtn.current.disabled = true;
    setStatus(statusEl, 'deleting…', 'busy');
    let r;
    try { r = await fetchJson('/api/prompts/' + encodeURIComponent(promptId) + '?projectDir=' + encodeURIComponent(projectDir), { method: 'DELETE' }); }
    catch (err) { setStatus(statusEl, 'network error', 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status, 'error'); if (deleteBtn.current) deleteBtn.current.disabled = false; return; }
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
        h('input', { ref: titleRef, class: 'input', id: 'spe-title', type: 'text', placeholder: 'My custom prompt' })
      ),
      h('div', { class: 'row' },
        h('label', { class: 'label', for: 'spe-content' }, 'Prompt content'),
        h('textarea', { ref: contentRef, class: 'input prompts__textarea', id: 'spe-content', rows: 6, placeholder: 'You are a helpful assistant specialized in…' })
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
            ref: agentFilesRef,
            checked: !!(preset && preset.agentFiles),
            onChange: (e) => toggleAgentFiles(e.currentTarget.checked)
          }),
          h('span', null, 'Also enable agent files')
        )
      ),
      h('div', { class: 'row row--actions' },
        h('button', { ref: saveBtn, class: 'btn btn--primary', type: 'button', onClick: save }, promptId ? 'Save' : 'Create'),
        h('button', { ref: deleteBtn, class: 'btn btn--danger', type: 'button', onClick: deletePrompt, hidden: !promptId }, 'Delete'),
        h('span', { ref: statusEl, class: 'status', 'aria-live': 'polite' })
      )
    )
  );
}
