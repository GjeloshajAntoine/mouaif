'use strict';

// Agent skills — named, project-scoped skill definitions under
// `<projectDir>/.agents/skills/<name>/SKILL.md`.
//
// Each subdirectory of the skills root whose name matches the
// NAME_RE contract and that contains a `SKILL.md` file is treated
// as one skill. The skill's Markdown body is injected into the
// upstream system context at stream time, after the agent files
// and before the tagged files and the custom prompt, so it sits
// close to the agent-instruction context. Each skill rides as its
// own `system` message so the model can see the skill boundary.
//
// The directory is watched read-only: we never create, modify, or
// delete skill files. Missing skills are silently skipped. Files
// larger than MAX_BYTES are truncated so a huge SKILL.md does not
// blow the context budget.
//
// Public surface:
//   SKILLS_DIR                     : path segment of the skills root ('.agents/skills')
//   MAX_BYTES                      : per-file size cap (default 64 KiB)
//   NAME_RE                        : accepted skill directory name pattern
//   discover(projectDir)           -> [{ name, dir, file, size }]
//   load(projectDir)               -> [{ name, title, role, content }]
//   resolveEnabled({chat, projectDir}) -> boolean

const fs = require('fs');
const path = require('path');
const settings = require('./settings.js');

// Canonical skills root, relative to the project directory.
const SKILLS_DIR = path.join('.agents', 'skills');

// Per-file size cap. Files larger than this are truncated to the cap
// with a trailing note so the model knows it is not the whole file.
const MAX_BYTES = 64 * 1024;

// Skill directory names must be short, non-empty, and free of path
// separators. Hidden directories (starting with a dot) are skipped.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// resolveEnabled({ chat, projectDir }) -> boolean
//
// Full resolution: per-chat override -> project-level setting -> profile
// default. The per-chat toggle is `chat.skills` (boolean); the project
// setting is `project.skills` (boolean). The profile default mirrors
// agentFiles: very-small = OFF, average/extensive = ON. When skills
// are disabled, the directory is not even read at stream time.
function resolveEnabled({ chat, projectDir }) {
  if (chat && typeof chat.skills === 'boolean') return chat.skills;
  if (projectDir) {
    try {
      const project = settings.getProject(projectDir);
      if (project && typeof project.skills === 'boolean') return project.skills;
    } catch { /* fall through to profile default */ }
  }
  const size = (chat && chat.promptSize) || 'average';
  return size !== 'very-small';
}

// discover(projectDir) -> [{ name, dir, file, size }]
//
// Return the skills that exist under the project's skills root. Each
// entry is a directory whose name passes NAME_RE and that contains a
// `SKILL.md` file. The result is sorted by directory name so the most
// specific skill (alphabetically first) is deterministic. Missing or
// unreadable entries are skipped silently.
function discover(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return [];
  const root = path.join(projectDir, SKILLS_DIR);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!NAME_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, 'SKILL.md');
    try {
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ name: entry.name, dir, file, size: st.size });
    } catch { /* missing or unreadable SKILL.md — skip */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// load(projectDir) -> [{ name, title, role, content }]
//
// Read every discovered skill and return it as a system-message
// payload. Files larger than MAX_BYTES are truncated. Unreadable
// skills are skipped. The content is wrapped in a small header so
// the model knows which skill it came from.
function load(projectDir) {
  const skills = discover(projectDir);
  const out = [];
  for (const s of skills) {
    let text;
    try {
      const buf = fs.readFileSync(s.file);
      if (buf.length > MAX_BYTES) {
        text = buf.slice(0, MAX_BYTES).toString('utf8')
          + '\n\n[... truncated at ' + MAX_BYTES + ' bytes ...]';
      } else {
        text = buf.toString('utf8');
      }
    } catch { continue; }
    if (!text.trim()) continue;
    // Use the first heading as a human-friendly title when present;
    // otherwise fall back to the directory name.
    const firstHeading = text.match(/^#\s+(.+)$/m);
    const title = firstHeading ? firstHeading[1].trim() : s.name;
    out.push({
      name: s.name,
      title,
      role: 'system',
      content: 'Agent skill "' + title + '" from ' + path.join(SKILLS_DIR, s.name, 'SKILL.md') + ':\n\n' + text
    });
  }
  return out;
}

function create(projectDir, opts) {
  const name = opts && typeof opts.name === 'string' ? opts.name.trim() : '';
  const content = opts && typeof opts.content === 'string' ? opts.content.trim() : '';
  if (!NAME_RE.test(name)) {
    const error = new Error('Skill name must use letters, numbers, dots, underscores, or hyphens');
    error.code = 'EBADINPUT';
    throw error;
  }
  if (!content) {
    const error = new Error('Skill instructions are required');
    error.code = 'EBADINPUT';
    throw error;
  }
  if (discover(projectDir).some(skill => skill.name === name)) {
    const error = new Error('Skill already exists');
    error.code = 'EEXISTS';
    throw error;
  }
  const dir = path.join(projectDir, SKILLS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content + '\n', { encoding: 'utf8', flag: 'wx' });
  return load(projectDir).find(skill => skill.name === name) || null;
}

module.exports = {
  SKILLS_DIR,
  MAX_BYTES,
  NAME_RE,
  discover,
  load,
  create,
  resolveEnabled
};
