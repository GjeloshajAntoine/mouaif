// Regression test: the `assistant_turn_end` live broadcast must carry the
// REAL seq of the row the server persisted — not a prediction, and not the
// previous segment's number when the segment was never written.
//
// The old implementation kept a per-chat counter (`liveSeqByChat`) and
// broadcast `nextLiveMessageSeq(runKey, assistantSegmentHasText)`. Two ways
// that is wrong, both observable here:
//
//   1. The counter resets to 0 on restart while the store keeps assigning
//      `MAX(seq)+1`, so after a restart the first segment of an existing chat
//      was broadcast with seq 0/1 — a real row's key. A follower that adopted
//      it either had its fresh bubble culled as a duplicate or had it moved to
//      an older message's position.
//   2. A segment that produced no text is never persisted, but the old code
//      re-broadcast the last value instead of sending no seq.
//
// This test drives handleChatStream against a fake upstream with a transcript
// already holding rows (so the assigned seqs are NOT 0/1) and asserts the
// broadcast seq equals the seq on the assistant row that was actually stored.
// The counter's restart bug is reproduced directly: the module is required
// fresh (its counter starts at 0) with history already on disk.
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate the app store BEFORE requiring src modules (settings.js captures
// MOUAIF_HOME at require time).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-live-seq-'));
process.env.MOUAIF_HOME = path.join(tmp, 'home');

const { handleChatStream } = require('../src/server-handlers-chats.js');
const messages = require('../src/messages.js');
const chats = require('../src/chats.js');
const settings = require('../src/settings.js');
const liveChat = require('../src/live-chat.js');
const serverShared = require('../src/server-shared.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// Two upstream rounds: text + tool call, then the final answer. Both produce
// assistant text, so both persist a row.
function serve() {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      count++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (count === 1) {
        res.write('data: {"choices":[{"delta":{"content":"First segment."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"cmd\\":\\"echo one\\"}"}}]},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"Final answer."},"index":0}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":20,"completion_tokens":3}}\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function mockReq(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') process.nextTick(() => cb(Buffer.from(JSON.stringify(body))));
      if (event === 'end') process.nextTick(cb);
    }
  };
}
function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { this.body += chunk; },
    end() {},
    setHeader() {},
    getHeader() { return undefined; }
  };
}

// Capture what the run broadcasts to a follower: subscribe a fake SSE
// response to the live registry BEFORE the turn starts, and parse the
// `assistant_turn_end` frames out of it.
function collectLiveFrames(runKey) {
  const frames = [];
  liveChat.ensureLiveChat(runKey);
  const sub = {
    _chunks: [],
    writeHead() { return this; },
    write(c) { this._chunks.push(c); return true; },
    end() {},
    on() {}
  };
  liveChat.addSubscriber(runKey, null, sub);
  return {
    sub,
    turnEnds() {
      return sub._chunks.join('').split('\n\n').filter(Boolean)
        .map((f) => {
          let name = 'message', data = '';
          for (const line of f.split('\n')) {
            if (line.startsWith('event: ')) name = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6) + '\n';
          }
          let parsed = null;
          try { parsed = JSON.parse(data.trim()); } catch { /* keep null */ }
          return { name, data: parsed };
        })
        .filter((f) => f.name === 'assistant_turn_end');
    }
  };
}

(async function main() {
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  const { server, port } = await serve();
  settings.setProject(projectDir, {
    models: [{ id: 'mock', provider: 'openai-compatible', label: 'Mock' }],
    tools: { shell: { enabled: true, mode: 'allow' } }
  });
  settings.setApp({
    providers: [{ id: 'openai-compatible', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k' }]
  });

  const chat = chats.createChat(projectDir, { title: 'live seq test' });
  const chatId = chat.id;

  // Seed REAL history first, so the store's next seq is well past 0/1 — the
  // exact situation the old counter got wrong on a fresh process. A
  // process-local counter would predict 0 here.
  messages.appendMessage(projectDir, chatId, { role: 'user', content: 'old question 1' });
  messages.appendMessage(projectDir, chatId, { role: 'assistant', content: 'old answer 1', modelId: 'mock' });
  messages.appendMessage(projectDir, chatId, { role: 'user', content: 'old question 2' });
  messages.appendMessage(projectDir, chatId, { role: 'assistant', content: 'old answer 2', modelId: 'mock' });
  const seeded = messages.listMessages(projectDir, chatId);
  const nextSeqBeforeRun = seeded[seeded.length - 1].seq + 1;
  check('history seeded so the next store seq is not 0/1', nextSeqBeforeRun >= 4, 'nextSeq=' + nextSeqBeforeRun);

  const runKey = serverShared.runningKey(projectDir, chatId);
  const live = collectLiveFrames(runKey);

  const req = mockReq({ projectDir, modelId: 'mock', content: 'run it' });
  const res = mockRes();
  await handleChatStream(req, res, chatId, null);
  server.close();

  check('stream completed with 200', res.statusCode === 200, 'status=' + res.statusCode);

  const broadcast = live.turnEnds();
  check('the tool round broadcast one assistant_turn_end', broadcast.length === 1, 'saw ' + broadcast.length);

  const rows = messages.listMessages(projectDir, chatId);
  const assistantRows = rows.filter((m) => m && m.role === 'assistant');
  // The two seeded 'old answer' rows, the tool-round segment, and the final
  // answer.
  check('four assistant rows persisted', assistantRows.length === 4, 'got ' + assistantRows.length);

  const segmentRow = assistantRows[2];
  check('the segment row is the tool round text', segmentRow && segmentRow.content === 'First segment.',
    JSON.stringify(segmentRow && segmentRow.content));

  const frame = broadcast[0];
  check('the broadcast carries a seq at all', !!(frame && frame.data && typeof frame.data.seq === 'number'),
    JSON.stringify(frame && frame.data));
  // The whole point: the broadcast seq is the STORE's seq for the persisted
  // segment row, not a process-local prediction.
  check('broadcast seq equals the persisted segment row seq',
    frame && frame.data && frame.data.seq === segmentRow.seq,
    'broadcast=' + (frame && frame.data && frame.data.seq) + ' persisted=' + (segmentRow && segmentRow.seq));
  check('broadcast seq is not the restart-zero prediction',
    frame && frame.data && frame.data.seq !== 0 && frame.data.seq !== 1,
    'seq=' + (frame && frame.data && frame.data.seq));

  const seqCount = assistantRows.filter((m) => typeof m.seq === 'number').length;
  check('every persisted assistant row carries a seq', seqCount === 4, 'withSeq=' + seqCount);

  liveChat.finishLiveChat(runKey);
  console.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
