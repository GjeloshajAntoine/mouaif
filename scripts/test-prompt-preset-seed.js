'use strict';

// A custom prompt's Chat preset is a creation-time seed: a chat created from
// the prompt starts with the preset's tools, agent files and skills stored on
// its own record, and nothing is merged per turn. Also covers the preset tool
// names (file operations, MCP server wildcards) and that the tool preview
// lists exactly what the stream advertises.
//
// Run: node scripts/test-prompt-preset-seed.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-preset-seed-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const root = path.join(tmp, 'project');
fs.mkdirSync(root, { recursive: true });

const settings = require('../src/settings.js');
const prompts = require('../src/prompts.js');
const chats = require('../src/chats.js');
const messages = require('../src/messages.js');
const aiStream = require('../src/ai-stream.js');
const { handleChats } = require('../src/server-handlers-chats.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   - ' + name); }
  catch (e) { fail++; console.log('  FAIL - ' + name + ' :: ' + e.message.split('\n')[0]); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ok   - ' + name); }
  catch (e) { fail++; console.log('  FAIL - ' + name + ' :: ' + e.message.split('\n')[0]); }
}
function response() {
  return {
    statusCode: 0, body: '',
    writeHead(code) { this.statusCode = code; },
    write(chunk) { this.body += chunk; },
    end(chunk) { this.body += chunk || ''; },
    setHeader() {}, getHeader() {}
  };
}

async function main() {
  // ---- normalizePreset --------------------------------------------------
  check('file operations are valid preset tool names', () => {
    assert.deepEqual(prompts.normalizePreset({ tools: ['shell', 'read_file', 'edit_file', 'group_read'] }).tools,
      ['shell', 'read_file', 'edit_file', 'group_read']);
  });
  check('the legacy `file` family name expands to every file operation', () => {
    const tools = prompts.normalizePreset({ tools: ['file'] }).tools;
    assert.ok(tools.includes('read_file') && tools.includes('write_file') && tools.includes('group_edit'));
    assert.equal(tools.includes('file'), false);
  });
  check('an MCP server wildcard is kept', () => {
    assert.deepEqual(prompts.normalizePreset({ tools: ['mcp__gh__*'] }).tools, ['mcp__gh__*']);
  });
  check('an explicit empty tool list is kept (start with no tools)', () => {
    assert.deepEqual(prompts.normalizePreset({ tools: [] }), { tools: [], agentFiles: undefined, skills: undefined });
  });
  check('a list of only unknown names counts as absent', () => {
    assert.equal(prompts.normalizePreset({ tools: ['chats', 'mouaif'] }), null);
  });

  // ---- seeding at creation ------------------------------------------------
  const toolsOnly = prompts.createPrompt(root, { title: 'Tools', content: 'Use shell.', scope: 'project',
    preset: { tools: ['shell', 'read_file'] } });
  const withToggles = prompts.createPrompt(root, { title: 'Toggles', content: 'Plain.', scope: 'project',
    preset: { tools: [], agentFiles: false, skills: true } });
  const plain = prompts.createPrompt(root, { title: 'Plain', content: 'No preset.', scope: 'project' });

  check('a new chat starts with the preset tools as its allowlist', () => {
    const chat = chats.createChat(root, { promptId: toolsOnly.id });
    assert.deepEqual(chat.tools, ['shell', 'read_file']);
  });
  check('a tools-only preset leaves agent files and skills at the chat default', () => {
    const chat = chats.createChat(root, { promptId: toolsOnly.id });
    assert.equal(chat.agentFiles, undefined);
    assert.equal(chat.skills, undefined);
  });
  check('preset toggles and an empty tool list are copied onto the chat', () => {
    const chat = chats.createChat(root, { promptId: withToggles.id });
    assert.deepEqual(chat.tools, []);
    assert.equal(chat.agentFiles, false);
    assert.equal(chat.skills, true);
  });
  check('explicit create options win over the preset', () => {
    const chat = chats.createChat(root, { promptId: withToggles.id, tools: ['task'], skills: false });
    assert.deepEqual(chat.tools, ['task']);
    assert.equal(chat.skills, false);
    assert.equal(chat.agentFiles, false);
  });
  check('a prompt with no preset leaves every tool on', () => {
    assert.equal(chats.createChat(root, { promptId: plain.id }).tools, undefined);
  });

  // ---- attaching to an existing chat --------------------------------------
  check('attaching a prompt to an empty chat seeds it', () => {
    const chat = chats.createChat(root, {});
    const next = chats.updateChat(root, chat.id, { promptId: toolsOnly.id });
    assert.deepEqual(next.tools, ['shell', 'read_file']);
  });
  check('fields in the same patch win over the seed', () => {
    const chat = chats.createChat(root, {});
    const next = chats.updateChat(root, chat.id, { promptId: toolsOnly.id, tools: null });
    assert.equal(next.tools == null, true, 'tools: null means every tool');
  });
  check('attaching a prompt to a chat with messages leaves its settings alone', () => {
    const chat = chats.createChat(root, {});
    messages.appendMessage(root, chat.id, { role: 'user', content: 'hi' });
    const next = chats.updateChat(root, chat.id, { promptId: toolsOnly.id });
    assert.equal(next.tools, undefined);
    assert.equal(next.promptSnapshot.content, 'Use shell.');
  });
  check('detaching keeps the seeded settings', () => {
    const chat = chats.createChat(root, { promptId: toolsOnly.id });
    const next = chats.updateChat(root, chat.id, { promptId: null });
    assert.deepEqual(next.tools, ['shell', 'read_file']);
  });
  check('a tool the user unchecks after creation stays off', () => {
    const chat = chats.createChat(root, { promptId: toolsOnly.id });
    chats.updateChat(root, chat.id, { tools: ['shell'] });
    assert.deepEqual(chats.getChat(root, chat.id).tools, ['shell']);
  });

  // ---- allowlist matching -------------------------------------------------
  check('an MCP server wildcard covers that server only', () => {
    const list = ['shell', 'mcp__gh__*'];
    assert.equal(aiStream.toolListed(list, 'mcp__gh__create_issue'), true);
    assert.equal(aiStream.toolListed(list, 'mcp__ghx__create_issue'), false);
    assert.equal(aiStream.toolListed(list, 'shell'), true);
    assert.equal(aiStream.toolListed(list, 'task'), false);
  });

  // ---- preview matches the stream -----------------------------------------
  async function preview(chat) {
    const res = response();
    await handleChats({ method: 'GET' }, res, { pathname: '/api/chats/' + chat.id + '/tool-preview', query: { projectDir: root } }, null);
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body).tools.map((t) => t.name);
  }
  function streamed(chat) {
    return aiStream.collectToolSpecs({ projectDir: root, chatId: chat.id, chat,
      enabledTools: Array.isArray(chat.tools) ? chat.tools : null }).visibleToolSpecs.map((s) => s.function.name);
  }
  await checkAsync('the preview lists the same tools the stream advertises', async () => {
    const chat = chats.createChat(root, { promptSize: 'extensive' });
    const names = await preview(chat);
    assert.deepEqual(names, streamed(chat));
    for (const name of ['task', 'group_cli', 'schedule_wake', 'hook_create', 'subagent_status']) {
      assert.ok(names.includes(name), name + ' missing from the preview');
    }
  });
  await checkAsync('the preview of a seeded chat lists only the preset tools', async () => {
    const chat = chats.createChat(root, { promptId: toolsOnly.id, promptSize: 'extensive' });
    const names = (await preview(chat)).filter((n) => n !== 'activate_skill');
    assert.deepEqual(names.sort(), ['read_file', 'shell']);
  });

  settings.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
