'use strict';

// Regression test: the performance profiler's fixtures and report helpers.
//
// `scripts/perf-profile.mjs` writes chats into the app store of whatever
// machine it runs on, so the parts that decide WHAT it writes and HOW it reads
// a report back are worth pinning down without Chrome, without the server, and
// without the real store:
//
//   * fixtures are deterministic (same profile -> same bytes), so two runs can
//     be compared and a regression in the seeder cannot masquerade as a
//     performance change;
//   * seeded chats are ordinary chats the app can list, open and delete, and
//     removal leaves the store exactly as it was found;
//   * the chat that `longestRealChats` picks excludes the fixtures, because a
//     fixture masquerading as "the longest real chat" would measure itself;
//   * the report's summary and notes are built from recorded fields only, and
//     stay silent when a measurement is missing instead of inventing numbers.
//
// Everything runs against a temporary MOUAIF_HOME, never ~/.mouaif.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-perf-test-'));
process.env.MOUAIF_HOME = HOME;
process.env.MOUAIF_ALLOW_ANY_ROOT = '1';
const PROJECT = fs.mkdtempSync(path.join(HOME, 'project-'));

(async () => {
  const fixtures = await import('./lib/perf-fixtures.mjs');
  const profiler = await import('./perf-profile.mjs?test=' + Date.now()).catch(() => null);

  // ---- fixtures are deterministic -----------------------------------------
  const a = fixtures.buildTranscript('medium');
  const b = fixtures.buildTranscript('medium');
  assert.equal(a.length, 500, 'medium profile makes exactly 500 rows');
  assert.deepEqual(a, b, 'the same profile produces byte-identical rows on every run');
  const different = fixtures.buildTranscript('long');
  assert.notDeepEqual(a, different, 'different profiles differ');
  console.log('PASS fixtures are deterministic and sized as declared');

  // ---- fixture rows look like a real transcript ---------------------------
  const roles = new Set(a.map((r) => r.role));
  assert.ok(roles.has('user') && roles.has('assistant'), 'a fixture alternates user and assistant');
  assert.ok(a.some((r) => r.role === 'tool' && r.phase === 'call'), 'a fixture contains tool calls');
  assert.ok(a.some((r) => r.role === 'tool' && r.phase === 'result' && r.toolCallId), 'tool results keep their call id');
  // Tool payloads sit in `content` as JSON, the way this project's own store
  // holds them. A fixture that used a separate `args` column would draw far
  // more cards than a real chat does and flatter the profile.
  const toolCall = a.find((r) => r.role === 'tool' && r.phase === 'call');
  const decoded = JSON.parse(toolCall.content);
  assert.equal(decoded.name, toolCall.name, 'a tool call names itself inside its content payload');
  assert.equal(typeof decoded.args, 'object', 'a tool call carries its arguments inside that payload');
  console.log('PASS tool rows are shaped like the ones the app store holds');
  assert.ok(a.some((r) => r.role === 'assistant' && typeof r.reasoning === 'string'), 'some answers carry reasoning');
  const codeRows = a.filter((r) => typeof r.content === 'string' && r.content.includes('```'));
  assert.ok(codeRows.length > 0, 'some rows contain fenced code, so the markdown slow path is exercised');
  console.log('PASS fixture rows carry the shapes the renderer has to draw');

  // ---- seeding, listing, opening and deleting -----------------------------
  const states = require('../src/chatdb.js');
  const settings = require('../src/settings.js');
  const before = states.listChats(PROJECT, {}).length;

  const manifest = fixtures.seedChats({
    home: HOME,
    projectDir: PROJECT,
    profiles: ['tiny', 'medium'],
    stamp: 'test-stamp'
  });
  assert.equal(manifest.chats.length, 2, 'one chat per profile');
  assert.equal(manifest.chats[0].rows, 30);
  assert.equal(manifest.chats[1].rows, 500);
  for (const chat of manifest.chats) {
    assert.match(chat.id, /^[a-f0-9]{8}$/, 'seeded chat ids are the 8-hex ids the app requires');
    const stored = states.getChat(PROJECT, chat.id);
    assert.ok(stored, 'the app can read the seeded chat');
    assert.match(stored.title, /^\[perf\] /, 'seeded chats are marked with the fixture title prefix');
    const rows = states.listMessages(PROJECT, chat.id);
    assert.equal(rows.length, chat.rows, 'every declared row is persisted');
    assert.equal(rows[0].seq, 0);
    assert.equal(rows[rows.length - 1].seq, chat.rows - 1, 'seq is contiguous from zero');
  }
  assert.equal(states.listChats(PROJECT, {}).length, before + 2, 'seeded chats show up in the chat list');
  console.log('PASS seeded chats are ordinary, readable, listed chats');

  // The window the chat view opens with.
  const windowed = states.listMessagesWindow(PROJECT, manifest.chats[1].id, { limit: 100 });
  assert.equal(windowed.length, 100, 'the newest page is 100 rows, like the app asks for');
  assert.equal(windowed[99].seq, 499, 'the window ends at the newest row');
  console.log('PASS the seeded transcript pages exactly like a real one');

  // ---- longestRealChats never returns a fixture --------------------------
  const real = fixtures.longestRealChats(HOME, PROJECT, 5);
  for (const row of real) {
    assert.ok(!manifest.chats.some((c) => c.id === row.id), 'a fixture is never offered as a real chat');
  }
  // A chat that IS longer than every fixture must still win.
  const longReal = states.createChat(PROJECT, { id: 'abcdef01', title: 'a real long chat' });
  const db = settings.getDb();
  const insert = db.prepare('INSERT INTO message_store (project_dir, chat_id, seq, role, content, ts) VALUES (?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < 600; i++) insert.run(PROJECT, longReal.id, i, i % 2 ? 'assistant' : 'user', 'x', new Date().toISOString());
  db.exec('COMMIT');
  const picked = fixtures.longestRealChats(HOME, PROJECT, 3);
  assert.equal(picked[0].id, longReal.id, 'the longest real chat ranks first');
  assert.equal(picked[0].rows, 600);
  assert.ok(!manifest.chats.some((c) => c.id === picked[0].id));
  console.log('PASS longestRealChats ranks real chats and skips fixtures');

  // ---- removal restores the store ----------------------------------------
  const removed = fixtures.removeSeeded(manifest, HOME);
  assert.equal(removed.removed, 2, 'both seeded chats are removed');
  assert.deepEqual(removed.missing, [], 'nothing was missing');
  for (const chat of manifest.chats) {
    assert.equal(states.getChat(PROJECT, chat.id), null, 'the seeded chat is gone');
    assert.equal(states.listMessages(PROJECT, chat.id).length, 0, 'its rows are gone too');
  }
  assert.equal(states.listChats(PROJECT, {}).length, before + 1, 'only the real chat remains');
  console.log('PASS removal deletes the seeded chats and their rows only');

  // ---- strays from an interrupted run are cleaned by title --------------
  fixtures.seedChats({ home: HOME, projectDir: PROJECT, profiles: ['tiny'], stamp: 'stray' });
  assert.equal(fixtures.removeStrays(HOME, PROJECT), 1, 'a leftover fixture chat is removed by its title prefix');
  assert.equal(states.getChat(PROJECT, longReal.id) !== null, true, 'the real chat survives the stray sweep');
  console.log('PASS leftover fixtures are swept without touching real chats');

  // ---- report summary and notes only state recorded numbers -------------
  assert.ok(profiler && typeof profiler.summarizeReport === 'function', 'the profiler exports its summary builder');
  const report = {
    app: { shellMs: 100, vitals: { fcpMs: 10, lcpMs: 20, domContentLoadedMs: 30, loadMs: 40 }, heapAfterLoad: { jsHeapUsed: 1000 } },
    server: { pid: 1, rssBytes: 2048, threads: 2 },
    environment: { store: { path: '/x/store.sqlite', bytes: 4096 } },
    transcripts: [
      {
        label: 'synthetic tiny', kind: 'synthetic', source: { rows: 30, bytes: 100 },
        open: { firstRowMs: 10, completeMs: 20, metrics: {} },
        heap: { domNodes: 100, jsHeapUsed: 500, baselineDelta: 100, retainedAfterLeave: 0 },
        trace: { longTaskCount: 0, longestTasks: [] },
        windowing: { ratio: 0.5 }
      },
      {
        label: 'synthetic long', kind: 'synthetic', source: { rows: 2000, bytes: 2000000 },
        open: { firstRowMs: 20, completeMs: 200, metrics: {} },
        heap: { domNodes: 10000, jsHeapUsed: 5000, baselineDelta: 900, retainedAfterLeave: 3 * 1024 * 1024 },
        trace: { longTaskCount: 2, longestTasks: [{ ms: 120 }] },
        fullHistory: {
        pages: 15, rowsAfter: 1700, heapAfter: 9000, perRowBytes: 5, nodesAfter: 9000,
        pageMs: { median: 40 }, error: null
        },
        windowingAfter: { ratio: 0.16 }
      }
    ]
  };
  const summary = profiler.summarizeReport(report);
  assert.equal(summary.shell.fcpMs, 10);
  assert.equal(summary.transcripts.length, 2);
  assert.equal(summary.transcripts[1].rows, 2000);
  assert.equal(summary.server.pid, 1);

  const notes = profiler.buildNotes(report);
  const text = notes.join('\n');
  assert.match(text, /Time to first row: 2×/, 'open cost is stated as a like-for-like ratio');
  assert.match(text, /Heap added by the open page: 100 B at 30 rows vs 900 B at 2000 rows \(9×\)/,
    'heap cost is stated as a baseline-relative delta');
  assert.match(text, /15 page\(s\)/, 'the drained pagination is reported');
  assert.match(text, /does not return the tab to its previous heap/, 'retention over the threshold is called out');
  assert.ok(!/returns to \(or below\)/.test(text), 'retention below the threshold is reported as such, not as a leak');
  assert.match(text, /long task\(s\) over 50 ms/, 'long tasks are reported');
  console.log('PASS the summary and notes only state measured numbers');

  // ---- heap snapshot summariser agrees with JSON.parse -------------------
  //
  // The profiler reads a 40-200 MB .heapsnapshot with a scanner (instead of
  // JSON.parse, which needs several times the file size in RAM). This case
  // pins the scanner to the same answer as the obvious implementation,
  // including escaped strings.
  const snapshotFile = path.join(HOME, 'small.heapsnapshot');
  const meta = {
    node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
    node_types: [
      ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number',
        'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'],
      'string', 'number', 'number', 'number', 'number'
    ]
  };
  const names = ['A', 'B', 'C', 'x"y', 'tab\there', 'uni\u00e9'];
  const nodes = [];
  for (let i = 0; i < 50; i++) nodes.push(i % 6, i % names.length, 100 + i, (i * 13) % 400, 0, 0);
  fs.writeFileSync(snapshotFile, JSON.stringify({
    snapshot: { meta: meta, node_count: 50, edge_count: 0 },
    nodes: nodes,
    strings: names,
    edges: []
  }));
  const snapshotSummary = profiler.summarizeHeapSnapshot(snapshotFile);
  const parsed = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const stride = meta.node_fields.length;
  const expectedBy = new Map();
  let expectedTotal = 0;
  for (let i = 0; i < parsed.nodes.length; i += stride) {
    const type = meta.node_types[0][parsed.nodes[i]];
    const name = parsed.strings[parsed.nodes[i + 1]];
    const size = parsed.nodes[i + 3];
    expectedTotal += size;
    const key = type + '|' + name;
    const prev = expectedBy.get(key) || { type, name, count: 0, selfBytes: 0 };
    prev.count++;
    prev.selfBytes += size;
    expectedBy.set(key, prev);
  }
  const expectedTop = [...expectedBy.values()].sort((a, b) => b.selfBytes - a.selfBytes)
    .slice(0, 12).map((e) => ({ type: e.type, name: String(e.name).slice(0, 80), count: e.count, selfBytes: e.selfBytes }));
  assert.equal(snapshotSummary.nodeCount, 50, 'the scanner counts every node');
  assert.equal(snapshotSummary.stringCount, names.length, 'the scanner reads the whole string table');
  assert.equal(snapshotSummary.totalSelfBytes, expectedTotal, 'self sizes add up to the same total as JSON.parse');
  assert.deepEqual(snapshotSummary.top, expectedTop, 'the per-constructor table matches JSON.parse exactly');
  fs.rmSync(snapshotFile, { force: true });
  console.log('PASS the snapshot scanner matches JSON.parse, including escaped strings');

  // Missing measurements stay silent rather than becoming zeros.
  const empty = profiler.summarizeReport({ transcripts: [] });
  assert.deepEqual(empty.transcripts, []);
  assert.deepEqual(profiler.buildNotes({ transcripts: [] }), [], 'an empty report produces no claims');
  console.log('PASS a report with no measurements makes no claims');

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nAll perf-profile tests passed.');
})().catch((e) => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* gone */ }
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
