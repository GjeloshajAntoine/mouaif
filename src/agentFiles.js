'use strict';

// Agent files — well-known instruction files at the project root that
// coding assistants read (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md).
//
// When enabled for a chat, the content of every agent file found at the
// project root is injected into the upstream system context, after the
// prompt-size profile and before the custom prompt. Each file rides as
// its own `system` message so the model can see the file boundary.
//
// Discovery is read-only: we never create, modify, or delete these files.
// Missing files are silently skipped. Files larger than MAX_BYTES are
// truncated so a huge AGENTS.md does not blow the context budget.
//
// Public surface:
//   DEFAULT_AGENT_FILE_NAMES         : ordered list of basenames we look for
//   MAX_BYTES                        : per-file size cap (default 64 KiB)
//   discover(projectDir)             -> [{ name, absPath, size }]
//   load(projectDir)                 -> [{ name, role, content }]
//   isEnabledForChat(chat)           -> boolean
//   resolveEnabled({chat, projectDir}) -> boolean
//   resolveFileNames({chat, projectDir}) -> string[]

const fs = require('fs');
const path = require('path');
const settings = require('./settings.js');

// Basenames we look for, in priority order. First match wins per slot;
// all matches are injected (they are complementary, not exclusive).
// The project-level `agentFileNames` setting can override this list.
const DEFAULT_AGENT_FILE_NAMES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md'
];

// Per-file size cap. Files larger than this are truncated to the cap
// with a trailing note so the model knows it is not the whole file.
const MAX_BYTES = 64 * 1024;

// resolveFileNames({ chat, projectDir }) -> string[]
//
// Return the list of basenames to look for. Resolution order:
//   1. project.agentFileNames (array of strings) — explicit override
//   2. DEFAULT_AGENT_FILE_NAMES
// The chat record does not carry its own file list; the per-chat toggle
// is a boolean on/off, not a per-file picker.
function resolveFileNames({ chat, projectDir }) {
  void chat; // reserved for future per-chat file lists
  if (projectDir) {
    try {
      const project = settings.getProject(projectDir);
      if (project && Array.isArray(project.agentFileNames) && project.agentFileNames.length) {
        return project.agentFileNames.map(String).filter(Boolean);
      }
    } catch { /* fall through to default */ }
  }
  return DEFAULT_AGENT_FILE_NAMES.slice();
}

// discover(projectDir, names?) -> [{ name, absPath, size }]
//
// Return the agent files that exist at the project root. Missing files
// are skipped silently. The result is ordered by the names list so the
// most specific file (AGENTS.md) is first. If no names are given the
// project-level/default list is used.
function discover(projectDir, names) {
  if (!projectDir || typeof projectDir !== 'string') return [];
  const list = Array.isArray(names) && names.length ? names : resolveFileNames({ projectDir });
  const out = [];
  for (const name of list) {
    const absPath = path.join(projectDir, name);
    try {
      const st = fs.statSync(absPath);
      if (st.isFile()) out.push({ name, absPath, size: st.size });
    } catch { /* missing or unreadable — skip */ }
  }
  return out;
}

// load(projectDir, names?) -> [{ name, role, content }]
//
// Read every discovered agent file and return it as a system-message
// payload. Files larger than MAX_BYTES are truncated. Unreadable files
// are skipped. The content is wrapped in a small header so the model
// knows which file it came from. If no names are given the
// project-level/default list is used.
function load(projectDir, names) {
  const files = discover(projectDir, names);
  const out = [];
  for (const f of files) {
    let text;
    try {
      const buf = fs.readFileSync(f.absPath);
      if (buf.length > MAX_BYTES) {
        text = buf.slice(0, MAX_BYTES).toString('utf8')
          + '\n\n[... truncated at ' + MAX_BYTES + ' bytes ...]';
      } else {
        text = buf.toString('utf8');
      }
    } catch { continue; }
    if (!text.trim()) continue;
    out.push({
      name: f.name,
      role: 'system',
      content: 'Project agent instructions from ' + f.name + ':\n\n' + text
    });
  }
  return out;
}

// isEnabledForChat(chat) -> boolean
//
// Per-chat toggle. The chat record carries an `agentFiles` field:
//   true  -> inject agent files
//   false -> do not inject
//   undefined / null -> fall through to the profile default
// The profile default is: very-small = OFF, average/extensive = ON.
function isEnabledForChat(chat) {
  if (!chat || typeof chat !== 'object') return true;
  if (chat.agentFiles === false) return false;
  if (chat.agentFiles === true) return true;
  // No explicit per-chat choice: fall back to the prompt-size profile.
  // very-small is meant to be the tightest context, so agent files are
  // off there. average and extensive get them by default.
  const size = chat.promptSize || 'average';
  return size !== 'very-small';
}

// resolveEnabled({ chat, projectDir }) -> boolean
//
// Full resolution: per-chat override -> profile default.
// Settings → Project edits the file-name list only; it no longer has a
// project-wide disable/default switch. Legacy `project.agentFiles` values are
// ignored so old hidden settings cannot silently lock agent files off.
function resolveEnabled({ chat, projectDir }) {
  void projectDir; // names still use project settings; enabled state is chat-only
  if (chat && typeof chat.agentFiles === 'boolean') return chat.agentFiles;
  return isEnabledForChat(chat);
}

module.exports = {
  DEFAULT_AGENT_FILE_NAMES,
  MAX_BYTES,
  discover,
  load,
  isEnabledForChat,
  resolveEnabled,
  resolveFileNames
};
