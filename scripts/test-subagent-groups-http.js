'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-http-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const { handleChatStream } = require('../src/server-handlers-chats.js');
const auth = require('../src/tools/authorization.js');
let round = 0, childStarted = false, groupId;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    const nested = body.messages.some((m) => typeof m.content === 'string' && m.content.includes('Task:\nmember task'));
    const send = (name, args, id) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = name ? { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } : { content: 'done' };
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    };
    if (nested) {
      childStarted = true;
      assert.ok(body.messages.some((m) => typeof m.content === 'string' && m.content.includes('shared HTTP goal')));
      // Default depth budget: a member is a local parent for its own groups;
      // approving the parent's group is still rejected by validateControl.
      assert.ok(body.tools.some((t) => t.function.name === 'subagent_group_update'));
      const last = body.messages.filter((m) => m.role === 'tool').at(-1);
      if (!last) return send('subagent_publish', { name: 'HTTP-artifact', summary: 'ready', files: ['src/a.js'] }, 'artifact');
      return send();
    }
    round++;
    if (round === 1) return send('subagent_group_create', { name: 'HTTP-group', objective: 'shared HTTP goal', members: [{ memberId: 'worker', role: 'review', workspace: 'declared-branch' }] }, 'group');
    const tools = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    if (round === 2) {
      groupId = tools.at(-1).groupId;
      return send('subagent', { task: 'member task', background: true, groupId, memberId: 'worker' }, 'worker');
    }
    if (round === 3) return setTimeout(() => send('subagent_group_status', { groupId }, 'status'), 100);
    assert.equal(tools.at(-1).complete, true);
    assert.equal(tools.at(-1).members[0].actualWorkspace, tmp);
    assert.deepEqual(tools.at(-1).artifacts, ['HTTP-artifact']);
    send();
  });
});
(async () => {
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port }] });
    settings.setProject(tmp, { models: [{ id: 'mock', provider: 'openai-compatible' }], tools: { subagent: { mode: 'allow' }, file: { mode: 'off' } } });
    const chat = chats.createChat(tmp, {});
    const req = { method: 'POST', headers: {}, on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify({ projectDir: tmp, modelId: 'mock', content: 'parent' }))));
      if (event === 'end') process.nextTick(cb);
    } };
    const res = { body: '', writeHead() {}, write(chunk) { this.body += chunk; }, end() {}, setHeader() {}, getHeader() {}, on() {}, off() {} };
    await handleChatStream(req, res, chat.id, null);
    assert.ok(childStarted);
    assert.ok(res.body.includes('HTTP-artifact'));
    assert.equal(require('../src/messages.js').listMessages(tmp, chat.id).filter((m) => m.role === 'tool' && m.phase === 'result' && m.toolCallId === 'worker').length, 1);
    // Group metadata cannot confer File tools or override a disabled send leaf.
    await assert.rejects(auth.authorize({ projectDir: tmp, chatId: chat.id, tool: 'read_file', callId: 'file' }), { code: 'ETOOL_DISABLED' });
    settings.setProject(tmp, { tools: { subagent: { mode: 'allow' }, subagent_send: { mode: 'off' } } });
    await assert.rejects(auth.authorize({ projectDir: tmp, chatId: chat.id, tool: 'subagent_send', callId: 'send' }), { code: 'ETOOL_DISABLED' });
    console.log('cooperative groups HTTP: member context, artifact provenance, completion, saved result and file/leaf authorization passed');
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); settings.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
