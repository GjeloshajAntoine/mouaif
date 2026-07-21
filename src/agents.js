'use strict';

// Project agents — named, project-scoped agent presets stored in
// <projectDir>/.mouaif.json under `agentPresets`.
//
// Each preset = { id, title, content, promptSize?, modelId?, providerId?, tools? }
//   id:         short kebab-case id, unique within the project
//   title:      human-readable label
//   content:    the instructions text (system prompt)
//   promptSize: optional 'very-small' | 'average' | 'extensive'
//   modelId:    optional model slug to use when this agent is active
//   providerId: optional provider id (e.g. 'openrouter')
//   tools:      optional array of tool names to enable (overrides chat filter)
//
// When a chat selects an agent, all these fields are applied to the chat
// at selection time (the server copies them onto the chat record).

const crypto = require('crypto');
const settings = require('./settings.js');

const MAX_BYTES = 64 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VALID_SIZES = new Set(['very-small', 'average', 'extensive']);

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null;
  return {
    id: raw.id,
    title: raw.title.trim(),
    content: typeof raw.content === 'string' ? raw.content : '',
    role: 'system',
    promptSize: raw.promptSize && VALID_SIZES.has(raw.promptSize) ? raw.promptSize : undefined,
    modelId: typeof raw.modelId === 'string' && raw.modelId.trim() ? raw.modelId.trim() : undefined,
    providerId: typeof raw.providerId === 'string' && raw.providerId.trim() ? raw.providerId.trim() : undefined,
    tools: Array.isArray(raw.tools) ? raw.tools.map(String).filter(Boolean) : undefined,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString()
  };
}

function listPresets(projectDir) {
  if (!projectDir) return [];
  const project = settings.getProject(projectDir);
  const raw = Array.isArray(project.agentPresets) ? project.agentPresets : [];
  return raw.map(normalizePreset).filter(Boolean);
}

function load(projectDir) {
  return listPresets(projectDir).map(p => ({
    name: p.id,
    title: p.title,
    role: 'system',
    content: 'Project agent "' + p.title + '":\n\n' + (p.content || ''),
    promptSize: p.promptSize,
    modelId: p.modelId,
    providerId: p.providerId,
    tools: p.tools
  }));
}

function loadOne(projectDir, name) {
  if (!isValidName(name)) return null;
  const p = listPresets(projectDir).find(a => a.id === name);
  if (!p) return null;
  return {
    name: p.id,
    title: p.title,
    role: 'system',
    content: 'Project agent "' + p.title + '":\n\n' + (p.content || ''),
    promptSize: p.promptSize,
    modelId: p.modelId,
    providerId: p.providerId,
    tools: p.tools
  };
}

function create(projectDir, opts) {
  const title = opts && typeof opts.title === 'string' ? opts.title.trim() : '';
  const content = opts && typeof opts.content === 'string' ? opts.content.trim() : '';
  if (!title) {
    const error = new Error('Agent title is required');
    error.code = 'EBADINPUT';
    throw error;
  }
  const project = settings.getProject(projectDir);
  const list = Array.isArray(project.agentPresets) ? project.agentPresets.slice() : [];
  let baseId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  let id = baseId;
  let counter = 1;
  while (list.some(p => p && p.id === id)) {
    id = baseId + '-' + (counter++);
  }
  const preset = normalizePreset({
    id,
    title,
    content: content || '',
    role: 'system',
    promptSize: opts && VALID_SIZES.has(opts.promptSize) ? opts.promptSize : undefined,
    modelId: opts && typeof opts.modelId === 'string' ? opts.modelId.trim() || undefined : undefined,
    providerId: opts && typeof opts.providerId === 'string' ? opts.providerId.trim() || undefined : undefined,
    tools: Array.isArray(opts.tools) ? opts.tools : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  if (!preset) {
    const error = new Error('Failed to normalize agent');
    error.code = 'EBADINPUT';
    throw error;
  }
  list.push(preset);
  settings.setProject(projectDir, { agentPresets: list });
  return loadOne(projectDir, id);
}

function updatePreset(projectDir, id, patch) {
  if (!id || !isValidName(id)) return null;
  const project = settings.getProject(projectDir);
  const list = Array.isArray(project.agentPresets) ? project.agentPresets.slice() : [];
  const idx = list.findIndex(p => p && p.id === id);
  if (idx < 0) return null;
  const current = normalizePreset(list[idx]);
  if (!current) return null;
  const merged = Object.assign({}, current, patch, { id: current.id, updatedAt: new Date().toISOString() });
  list[idx] = normalizePreset(merged) || merged;
  settings.setProject(projectDir, { agentPresets: list });
  return loadOne(projectDir, id);
}

function deletePreset(projectDir, id) {
  if (!id) return false;
  const project = settings.getProject(projectDir);
  const list = Array.isArray(project.agentPresets) ? project.agentPresets.slice() : [];
  const idx = list.findIndex(p => p && p.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  settings.setProject(projectDir, { agentPresets: list });
  return true;
}

function resolveSelected({ chat, projectDir } = {}) {
  if (chat && typeof chat.agentId === 'string' && chat.agentId && loadOne(projectDir, chat.agentId)) return chat.agentId;
  if (projectDir) {
    try {
      const project = settings.getProject(projectDir);
      const value = project && (project.agentId || project.defaultAgentId);
      if (typeof value === 'string' && value && loadOne(projectDir, value)) return value;
    } catch { /* fall through */ }
  }
  return null;
}

function loadSelected({ chat, projectDir } = {}) {
  const name = resolveSelected({ chat, projectDir });
  return name ? loadOne(projectDir, name) : null;
}

function getDefault(projectDir) {
  if (!projectDir) return null;
  let project;
  try { project = settings.getProject(projectDir); } catch { return null; }
  const name = project && (project.agentId || project.defaultAgentId);
  return typeof name === 'string' && loadOne(projectDir, name) ? name : null;
}

function setDefault(projectDir, name) {
  const next = typeof name === 'string' && name ? name : null;
  if (next && !loadOne(projectDir, next)) return false;
  settings.setProject(projectDir, { agentId: next });
  return true;
}

module.exports = {
  MAX_BYTES,
  NAME_RE,
  load,
  loadOne,
  create,
  updatePreset,
  deletePreset,
  loadSelected,
  resolveSelected,
  getDefault,
  setDefault,
  isValidName,
  normalizePreset,
  listPresets
};