'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-agent-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-agent-project-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const agents = require('../src/agents.js');
const chats = require('../src/chats.js');
const prompts = require('../src/prompts.js');
const presets = require('../src/agentPresets.js');

function writeInstruction(kind, name, filename, content) {
  const dir = path.join(projectDir, '.agents', kind, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

try {
  writeInstruction('agents', 'reviewer', 'AGENT.md', '# Reviewer\n\nReview carefully.');
  writeInstruction('agents', 'builder', 'AGENT.md', '# Builder\n\nImplement carefully.');
  writeInstruction('skills', 'testing', 'SKILL.md', '# Testing\n\nRun focused tests.');
  writeInstruction('skills', 'security', 'SKILL.md', '# Security\n\nCheck trust boundaries.');

  assert.deepEqual(agents.discover(projectDir).map(agent => agent.name), ['builder', 'reviewer']);
  assert.equal(agents.getDefault(projectDir), null);
  assert.equal(agents.setDefault(projectDir, 'missing'), false);
  assert.equal(agents.setDefault(projectDir, 'reviewer'), true);
  assert.equal(agents.getDefault(projectDir), 'reviewer');

  const prompt = prompts.createPrompt(projectDir, { title: 'Review prompt', content: 'Be concise.' });
  const config = agents.setConfig(projectDir, 'reviewer', {
    promptId: prompt.id,
    selectedSkills: ['testing'],
    tools: null
  });
  assert.equal(config.promptId, prompt.id);
  assert.deepEqual(config.selectedSkills, ['testing']);

  const chat = chats.createChat(projectDir, { title: 'Agent test' });
  assert.equal(agents.resolveSelected({ chat, projectDir }), 'reviewer');
  let updated = chats.updateChat(projectDir, chat.id, { agentId: 'builder', selectedSkills: [] });
  assert.equal(agents.resolveSelected({ chat: updated, projectDir }), 'builder');
  assert.deepEqual(updated.selectedSkills, []);
  updated = chats.updateChat(projectDir, chat.id, { agentId: null, selectedSkills: null });
  assert.equal(agents.resolveSelected({ chat: updated, projectDir }), 'reviewer');
  assert.equal(updated.selectedSkills, null);

  const preset = presets.createPreset(projectDir, {
    title: 'Testing only',
    promptId: prompt.id,
    selectedSkills: ['testing', 'missing']
  });
  assert.deepEqual(presets.applyPreset({ projectDir, presetId: preset.id }).selectedSkills, ['testing']);
  fs.rmSync(path.join(projectDir, '.agents', 'skills', 'testing'), { recursive: true, force: true });
  assert.deepEqual(presets.applyPreset({ projectDir, presetId: preset.id }).selectedSkills, []);

  console.log('agent config: all assertions passed');
} finally {
  settings.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
