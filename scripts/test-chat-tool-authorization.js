'use strict';

// Regression test: the Off / Ask / Allow segments in the CHAT view are
// chat-scoped (decisions §17).
//
// The bug this locks down: the chat's Tools card and the composer tool
// popup PUT the same `/api/tools/authorization` body the project settings
// page used, so tapping a segment in a chat rewrote
// `<projectDir>/.mouaif.json` (and `.mcp.json`). One chat's preference
// silently became the project default for every chat — and after a reload
// there was no way to tell where the value came from.
//
// What must hold now:
//   1. a chat write lands on the CHAT record (`chat.toolAuth`) and leaves
//      the project file byte-identical;
//   2. the chat-scoped view resolves chat-over-project and reports the
//      project mode elsewhere;
//   3. the advertisement gate (`effectiveConfig`) drops a tool this chat
//      turned `off` while another chat — and project settings — keep it;
//   4. a cleared override falls back to the project value;
//   5. a project conversation is not affected by another chat's override.
//
// Everything runs in-process against temporary project + home dirs, so no
// server and no `.mouaif.json` of the real repo is touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-auth-home-'));
process.env.MOUAIF_HOME = home;

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-chat-auth-proj-'));

const chats = require('../src/chats.js');
const settings = require('../src/settings.js');
const authz = require('../src/tools/authorization.js');

const PROJECT_FILE = path.join(projectDir, '.mouaif.json');
const MCP_FILE = path.join(projectDir, '.mcp.json');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function fetchJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf || '{}'); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Project baseline: shell asks, and the project file exists so a stray
  // write is detectable byte for byte.
  settings.setProject(projectDir, { tools: { shell: { mode: 'ask', allowlist: [] } } });
  const projectBefore = readIfExists(PROJECT_FILE);
  const mcpBefore = readIfExists(MCP_FILE);

  const chatA = chats.createChat(projectDir, { title: 'Chat A' });
  const chatB = chats.createChat(projectDir, { title: 'Chat B' });

  // 1. A chat write stores on the chat, never on the project.
  const viewA = authz.setChatAuthorization(projectDir, chatA.id, {
    native: { shell: { mode: 'allow', allowlist: [] } }
  });
  check('chat write echoes the chat scope', !!viewA && !!viewA.chat, JSON.stringify(viewA && viewA.chat));
  check('chat write resolves shell to allow',
    viewA.tools.shell.mode === 'allow' && viewA.tools.shell.source === 'chat',
    JSON.stringify(viewA.tools.shell));
  check('project .mouaif.json untouched',
    readIfExists(PROJECT_FILE) === projectBefore,
    'project file changed: ' + readIfExists(PROJECT_FILE));
  check('.mcp.json untouched', readIfExists(MCP_FILE) === mcpBefore);

  const storedA = chats.getChat(projectDir, chatA.id);
  check('override persisted on the chat record',
    !!(storedA.toolAuth && storedA.toolAuth.native && storedA.toolAuth.native.shell),
    JSON.stringify(storedA.toolAuth));

  // 2. Another chat is unaffected; the project view still reads `ask`.
  const projectView = authz.getAuthorization(projectDir);
  check('project view keeps ask', projectView.tools.shell.mode === 'ask', JSON.stringify(projectView.tools.shell));
  check('project view carries no chat block', projectView.chat === undefined);
  const viewB = authz.getAuthorization(projectDir, chatB.id);
  check('sibling chat keeps ask', viewB.tools.shell.mode === 'ask', JSON.stringify(viewB.tools.shell));

  // 3. The advertisement gate honors the chat override only for that chat.
  const gateA = authz.effectiveConfig(projectDir, 'shell', chatA.id);
  const gateB = authz.effectiveConfig(projectDir, 'shell', chatB.id);
  check('chat override reaches the gate', gateA.mode === 'allow' && gateA.source === 'chat', JSON.stringify(gateA));
  check('sibling chat still asks at the gate', gateB.mode === 'ask' && gateB.source === 'project', JSON.stringify(gateB));

  // 3b. `off` in one chat hides the tool there only.
  authz.setChatAuthorization(projectDir, chatA.id, { native: { task: { mode: 'off' } } });
  check('chat off hides task for that chat',
    authz.effectiveConfig(projectDir, 'task', chatA.id).mode === 'off');
  check('chat off leaves task advertised in another chat',
    authz.effectiveConfig(projectDir, 'task', chatB.id).mode === 'ask');

  // 4. A cleared override falls back to the project value.
  authz.setChatAuthorization(projectDir, chatA.id, { native: { shell: null } });
  const afterClear = authz.getAuthorization(projectDir, chatA.id);
  check('cleared override falls back to project ask',
    afterClear.tools.shell.mode === 'ask' && afterClear.tools.shell.source === 'project',
    JSON.stringify(afterClear.tools.shell));
  check('cleared override is gone from the record',
    !(afterClear.chat && afterClear.chat.native && afterClear.chat.native.shell),
    JSON.stringify(afterClear.chat && afterClear.chat.native));

  // 5. File operations share the family key, so one control covers all five.
  authz.setChatAuthorization(projectDir, chatA.id, { native: { read_file: { mode: 'off' } } });
  check('per-leaf file write lands on the file family',
    authz.effectiveConfig(projectDir, 'read_file', chatA.id).mode === 'off');
  check('the other file leaves follow the family gate',
    authz.effectiveConfig(projectDir, 'write_file', chatA.id).mode === 'off');

  // 6. MCP overrides: per-server and the chat's shared gate, chat-scoped.
  authz.setChatAuthorization(projectDir, chatA.id, {
    mcp: { servers: { myserver: { mode: 'allow' } } }
  });
  check('chat MCP server override wins for that chat',
    authz.effectiveConfig(projectDir, 'mcp__myserver__do', chatA.id).mode === 'allow',
    JSON.stringify(authz.effectiveConfig(projectDir, 'mcp__myserver__do', chatA.id)));
  check('chat MCP server override does not leak to another chat',
    authz.effectiveConfig(projectDir, 'mcp__myserver__do', chatB.id).source !== 'chat-server');

  authz.setChatAuthorization(projectDir, chatA.id, {
    mcp: { servers: { myserver: null }, shared: { mode: 'off' } }
  });
  check('cleared MCP server override falls back to the chat shared gate',
    authz.effectiveConfig(projectDir, 'mcp__myserver__do', chatA.id).mode === 'off',
    JSON.stringify(authz.effectiveConfig(projectDir, 'mcp__myserver__do', chatA.id)));

  // Clearing every override drops the map entirely (one representation of
  // "no chat overrides").
  authz.setChatAuthorization(projectDir, chatA.id, {
    native: { read_file: null, task: null },
    mcp: { shared: null }
  });
  const cleaned = chats.getChat(projectDir, chatA.id);
  check('clearing every override drops the stored map',
    cleaned.toolAuth === undefined,
    JSON.stringify(cleaned.toolAuth));

  // 7. Deleting the chat takes its overrides with it (nothing stale is
  // left behind for a recycled id to pick up).
  chats.deleteChat(projectDir, chatA.id);
  check('deleted chat has no record left', chats.getChat(projectDir, chatA.id) === null);
  check('override lookup on a missing chat is null',
    authz.readChatAuthOverrides(projectDir, chatA.id) === null);

  // 8. Project file still byte-identical after the whole run.
  check('project file byte-identical at the end',
    readIfExists(PROJECT_FILE) === projectBefore,
    'project file changed: ' + readIfExists(PROJECT_FILE));

  // 9. The HTTP surface the chat view actually talks to: PUT with
  // `scope: 'chat'` writes the chat, GET with `chatId` answers the
  // chat-scoped view, and the project-scoped GET still answers settings.
  const server = require('../src/index.js').createServer(0, { lifecycle: { restarting: false, restart: async () => {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const chatC = chats.createChat(projectDir, { title: 'Chat C' });

    let r = await fetchJson(port, 'PUT', '/api/tools/authorization', {
      scope: 'chat', projectDir, chatId: chatC.id,
      chat: { native: { shell: { mode: 'allow', allowlist: [] } } }
    });
    check('PUT scope=chat is 200', r.status === 200, JSON.stringify(r).slice(0, 200));
    check('PUT scope=chat resolves shell to allow', r.body && r.body.tools && r.body.tools.shell.mode === 'allow',
      JSON.stringify(r.body && r.body.tools && r.body.tools.shell));
    check('PUT scope=chat did not touch the project file',
      readIfExists(PROJECT_FILE) === projectBefore);

    r = await fetchJson(port, 'GET',
      '/api/tools/authorization?projectDir=' + encodeURIComponent(projectDir) + '&chatId=' + encodeURIComponent(chatC.id), null);
    check('GET ?chatId= is 200', r.status === 200);
    check('GET ?chatId= reports the chat override', r.body && r.body.chat && !!r.body.chat.native.shell,
      JSON.stringify(r.body && r.body.chat));
    check('GET ?chatId= resolves the effective mode', r.body && r.body.tools.shell.mode === 'allow');

    r = await fetchJson(port, 'GET', '/api/tools/authorization?projectDir=' + encodeURIComponent(projectDir), null);
    check('GET with no chatId is still the project view',
      r.status === 200 && r.body.tools.shell.mode === 'ask' && r.body.chat === undefined,
      JSON.stringify(r.body && r.body.tools && r.body.tools.shell));

    // A missing chat is a 404, not a silent project-scoped write.
    r = await fetchJson(port, 'PUT', '/api/tools/authorization', {
      scope: 'chat', projectDir, chatId: 'deadbeef', chat: { native: { shell: { mode: 'allow' } } }
    });
    check('PUT scope=chat on a missing chat is 404', r.status === 404, JSON.stringify(r).slice(0, 200));
    r = await fetchJson(port, 'PUT', '/api/tools/authorization', {
      scope: 'chat', projectDir, chat: { native: { shell: { mode: 'allow' } } }
    });
    check('PUT scope=chat without chatId is 400', r.status === 400, JSON.stringify(r).slice(0, 200));

    // Legacy body (projectDir + tools, no scope) still writes the project —
    // that is what project settings sends.
    r = await fetchJson(port, 'PUT', '/api/tools/authorization', {
      projectDir, tools: { shell: { mode: 'allow', allowlist: [] } }
    });
    check('legacy project-scoped PUT still writes the project',
      r.status === 200 && r.body.tools.shell.mode === 'allow');
    check('legacy project-scoped PUT did change the project file',
      readIfExists(PROJECT_FILE) !== projectBefore);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
