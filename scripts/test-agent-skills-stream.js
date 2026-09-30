'use strict';

// Exercise the real REST/SSE handler and delegated loop with an isolated
// SQLite store and a local mock provider. Never start the mouaif CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-skills-stream-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');
const settings = require('../src/settings.js');
const chats = require('../src/chats.js');
const { handleChats, handleChatStream } = require('../src/server-handlers-chats.js');

function request(body) {
  return {
    method: 'POST', headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))));
      if (event === 'end') process.nextTick(cb);
    }
  };
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
function skillNames(req) {
  return req.tools?.find((s) => s.function.name === 'activate_skill')?.function.parameters.properties.name.enum || [];
}
function activationFeedback(req) {
  return req.messages.filter((m) => m.role === 'tool' && m.name === 'activate_skill').map((m) => m.content).join('\n');
}

async function main() {
  let seen = [];
  let steps = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      const step = steps.shift();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
      if (step) {
        write({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + seen.length, function: { name: step.name, arguments: JSON.stringify(step.args) } }] } }] });
        write({ choices: [{ index: 0, finish_reason: 'tool_calls' }] });
      } else {
        write({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  settings.setApp({ providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + server.address().port }] });
  const activation = { name: 'activate_skill', args: { name: 'testing' } };
  const delegate = { name: 'subagent', args: { task: 'Review skills' } };
  let count = 0;
  try {
    async function run(opts, sequence, projectPatch = {}) {
      const projectDir = path.join(tmp, 'project-' + count++);
      for (const name of ['other', 'testing']) {
        const dir = path.join(projectDir, '.agents', 'skills', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: Run ' + name + '.\n---\nINSTRUCTIONS_' + name);
      }
      settings.setProject(projectDir, Object.assign({ models: [{ id: 'mock', provider: 'openai-compatible' }], tools: { subagent: { mode: 'allow' } } }, projectPatch));
      const chat = chats.createChat(projectDir, opts);
      const preview = response();
      await handleChats({ method: 'GET' }, preview, { pathname: '/api/chats/' + chat.id + '/system-prompt', query: { projectDir } }, null);
      assert.equal(preview.statusCode, 200);
      seen = []; steps = sequence.slice();
      const out = response();
      await handleChatStream(request({ projectDir, modelId: 'mock', content: 'Review' }), out, chat.id, null);
      assert.equal(out.statusCode, 200);
      assert.equal(steps.length, 0);
      return { requests: seen.slice(), preview: JSON.parse(preview.body), out };
    }

    const on = await run({ skills: false, promptSnapshot: { content: 'Prompt', preset: { skills: true } } }, [activation, null]);
    assert.equal(on.preview.skillsEnabled, true);
    assert.deepEqual(skillNames(on.requests[0]), ['other', 'testing']);
    assert.match(activationFeedback(on.requests[1]), /INSTRUCTIONS_testing/);

    const off = await run({ skills: true, promptSnapshot: { content: 'Prompt', preset: { skills: false } } }, [activation, null]);
    assert.equal(off.preview.skillsEnabled, false);
    assert.deepEqual(skillNames(off.requests[0]), []);
    assert.match(activationFeedback(off.requests[1]), /ENO_SKILL/);

    const nested = await run({ disabledSkills: ['testing'] }, [delegate, activation, null, null]);
    assert.deepEqual(skillNames(nested.requests[0]), ['other']);
    assert.deepEqual(skillNames(nested.requests[1]), ['other']);
    assert.match(activationFeedback(nested.requests[2]), /ENO_SKILL/);

    for (const tools of [['shell'], []]) {
    const selected = await run({ tools }, [activation, null]);
    assert.deepEqual(skillNames(selected.requests[0]), ['other', 'testing']);
    assert.match(activationFeedback(selected.requests[1]), /INSTRUCTIONS_testing/);
    assert.equal(selected.requests[0].tools.some((s) => s.function.name === 'subagent'), false);
    }
    const filteredNested = await run({ tools: ['subagent'] }, [delegate, activation, null, null]);
    assert.deepEqual(skillNames(filteredNested.requests[1]), ['other', 'testing']);
    assert.match(activationFeedback(filteredNested.requests[2]), /INSTRUCTIONS_testing/);

    const restricted = await run({ tools: ['subagent'] }, [
    { name: 'subagent', args: { task: 'Review', agent: 'Limited' } }, null, null
    ], { agents: [{ name: 'Limited', content: 'Use shell only.', tools: ['shell'] }] });
    assert.deepEqual(skillNames(restricted.requests[1]), []);

    const locked = await run({ skills: true }, [activation, null], { skills: false });
    assert.deepEqual(skillNames(locked.requests[0]), []);
    assert.match(activationFeedback(locked.requests[1]), /ENO_SKILL/);
    console.log('agent skills stream: preset parity, nested opt-outs, and project locks passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    settings.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
