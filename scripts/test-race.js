'use strict';

// Parallel race-condition probe for the mouaif HTTP surface.
//
// Two app instances (see compose.race.yaml) share one MOUAIF_HOME volume, so
// every case below runs the same requests against both servers at once. The
// suite does not care WHICH server wins a race — only that the state left
// behind is one a single server could have produced. A case fails when the
// result is impossible without a race:
//
//   - a whole-body file write that comes back torn or half-applied
//   - a project-settings/chat update that loses a sibling field
//   - message rows that collide on `seq` or reuse a `clientId`
//   - a chat or provider entry that vanishes from a list after a concurrent add
//
// Run: node /test/race-test.js   (inside the `test` service)
// Env: BASE_URLS  comma-separated server URLs, default http://app-a:5732,http://app-b:5732
//      PROJECT_DIR  absolute project dir both servers see, default /workspace/race

const assert = require('node:assert/strict');

const BASE_URLS = (process.env.BASE_URLS || 'http://app-a:5732,http://app-b:5732')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PROJECT_DIR = process.env.PROJECT_DIR || '/workspace/race';
const CONCURRENCY = Number(process.env.RACE_CONCURRENCY || 16);
const FILE_SIZE = Number(process.env.RACE_FILE_SIZE || 65536);

// The compression/retry knobs that make a lost update more likely are all
// env-overridable so the case can also be run as a quick smoke check.
const SETTINGS_ROUNDS = Number(process.env.RACE_SETTINGS_ROUNDS || 60);
const MESSAGE_WRITERS = Number(process.env.RACE_MESSAGE_WRITERS || 12);
const MESSAGES_PER_WRITER = Number(process.env.RACE_MESSAGES_PER_WRITER || 12);

const results = [];

async function call(base, path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const type = response.headers.get('content-type') || '';
  let body = null;
  if (type.includes('application/json')) {
    try { body = await response.json(); } catch { body = null; }
  } else {
    body = await response.text();
  }
  return { status: response.status, ok: response.ok, body };
}

// json(base, path, method, payload) -> parsed body, asserting a 2xx.
async function json(base, path, method, payload) {
  const out = await call(base, path, {
    method,
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  assert.ok(out.ok, `${method} ${path} on ${base} returned ${out.status}: ${JSON.stringify(out.body)}`);
  return out.body;
}

async function ensureScratchDir() {
  // POST /api/projects action=create is mkdir(2) without recursive, so the
  // parent must exist. Creating it twice is fine: EEXIST is the answer both
  // the first and any later run gets.
  const out = await call(BASE_URLS[0], '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', parent: PROJECT_DIR, name: 'race' })
  });
  assert.ok(out.ok || out.status === 400 || out.status === 409,
    `could not prepare ${PROJECT_DIR}/race: ${out.status} ${JSON.stringify(out.body)}`);
}

// The app server authorizes browser-origin requests with a session cookie,
// so both instances must have been visited once. The compose stack's
// healthcheck already GETs /api/settings on each; this repeats it per URL so
// the suite is runnable against any pair of servers.
async function ensureSession() {
  const homes = [];
  for (const base of BASE_URLS) {
    const out = await call(base, '/api/settings');
    assert.ok(out.ok, `GET /api/settings on ${base} returned ${out.status}`);
    homes.push({ base, home: out.body.home });
  }
  // Every server must be looking at the same app store, or nothing below is
  // a race at all: it is just two independent processes.
  const distinct = new Set(homes.map((h) => h.home));
  assert.equal(distinct.size, 1,
    `the servers do not share one app store: ${homes.map((h) => `${h.base} -> ${h.home}`).join(', ')}`);
  const root = await call(BASE_URLS[0], '/api/projects?dir=' + encodeURIComponent(PROJECT_DIR));
  assert.ok(root.ok, `the shared project dir ${PROJECT_DIR} is not readable (${root.status}); mount it and create it with a .mouaif.json`);
}

// ---- Cases ---------------------------------------------------------------

// 1. Two servers writing the same project file. The file API stages to a
//    deterministic `<path>.mouaif-tmp` and then renames, so concurrent
//    writers can clobber each other's staging file. Whatever the outcome,
//    the file must be one writer's COMPLETE body — never a tear.
async function caseConcurrentFileWrite() {
  const path = 'contended.txt';
  const target = PROJECT_DIR + '/' + path;
  const bodies = Array.from({ length: CONCURRENCY }, (_, i) => raceTarget.bodyFor(i, FILE_SIZE));
  const outs = await Promise.all(bodies.map((content, i) => call(BASE_URLS[i % BASE_URLS.length], '/api/file', {
    method: 'PUT',
    body: JSON.stringify({ projectDir: PROJECT_DIR, path, content })
  })));
  // The surface stages a write to `<path>.mouaif-tmp` and renames it into
  // place. That name is derived from the target alone, so two processes
  // writing the same file race on the SAME staging path: one rename finds a
  // file another writer already moved, and the write is lost. The failure is
  // named here rather than merely counted, because it is the exact
  // cross-process defect this suite exists to expose.
  const clobbered = outs.filter((o) => o.status >= 400 && /\.mouaif-tmp/.test(JSON.stringify(o.body)));
  assert.deepEqual(clobbered.map((o) => o.status), [],
    `${clobbered.length} of ${CONCURRENCY} writes failed on the shared staging path `
    + `(\`${path}.mouaif-tmp\` is derived from the target alone, so concurrent writers clobber each other): `
    + JSON.stringify(clobbered[0] && clobbered[0].body));
  // A refusal is allowed (the surface is allowed to 4xx under contention);
  // what is not allowed is a 2xx that then reports a size other than the
  // body's own, or a stored file that is not a whole body.
  for (const [i, out] of outs.entries()) {
    if (out.ok) {
      assert.equal(out.body.size, FILE_SIZE,
        `writer ${i} got a 2xx but the response size ${out.body.size} is not the body it sent`);
    }
  }
  const read = await json(BASE_URLS[0], `/api/file?projectDir=${encodeURIComponent(PROJECT_DIR)}&path=${encodeURIComponent(target)}`, 'GET');
  const verdict = raceTarget.judgeBody(read.content, FILE_SIZE, CONCURRENCY);

  const okCount = outs.filter((o) => o.ok).length;
  assert.ok(verdict.ok,
    `concurrent PUT /api/file left a corrupt file: ${verdict.reason} (${okCount}/${CONCURRENCY} writes reported success)`);
  return `${okCount}/${CONCURRENCY} writes 2xx; stored file is whole (${verdict.reason})`;
}

// 2. Project settings written by both servers. setProject() reads the JSON
//    blob, merges, and writes it back, so concurrent writers lose each
//    other's keys unless the surface serializes them.
async function caseConcurrentProjectSettings() {
  const key = (tag, i) => `race_${tag}_${i}`;
  const jobs = [];
  for (let i = 0; i < SETTINGS_ROUNDS; i += 1) {
    jobs.push(json(BASE_URLS[0], '/api/settings/project', 'PUT', { projectDir: PROJECT_DIR, [key('a', i)]: i }));
    jobs.push(json(BASE_URLS[1], '/api/settings/project', 'PUT', { projectDir: PROJECT_DIR, [key('b', i)]: i }));
  }
  await Promise.all(jobs);
  const stored = await json(BASE_URLS[0], `/api/settings/project?projectDir=${encodeURIComponent(PROJECT_DIR)}`, 'GET');
  const a = Object.keys(stored.project).filter((k) => k.startsWith('race_a_')).length;
  const b = Object.keys(stored.project).filter((k) => k.startsWith('race_b_')).length;
  assert.equal(a, SETTINGS_ROUNDS,
    `project settings lost ${SETTINGS_ROUNDS - a} of ${SETTINGS_ROUNDS} writes from server A (read-modify-write against a shared store)`);
  assert.equal(b, SETTINGS_ROUNDS,
    `project settings lost ${SETTINGS_ROUNDS - b} of ${SETTINGS_ROUNDS} writes from server B (read-modify-write against a shared store)`);
  return `${a}+${b} project-settings keys survived ${SETTINGS_ROUNDS * 2} concurrent writes`;
}

// 3. The same app-level store through two routes: registering a project on one
//    server and adding a provider on the other. Both are read-modify-writes of
//    the single app_kv JSON blob.
async function caseConcurrentAppStore() {
  const before = await json(BASE_URLS[0], '/api/settings', 'GET');
  const providerId = 'openai-compatible';
  const dirs = [];
  for (let i = 0; i < 12; i += 1) {
    const dir = `${PROJECT_DIR}/race/reg-${i}`;
    await json(BASE_URLS[0], '/api/projects', 'POST', {
      action: 'create', parent: `${PROJECT_DIR}/race`, name: `reg-${i}`
    });
    dirs.push(dir);
  }
  // Two bursts of app-store writers, each burst mixing a provider write with
  // several project registrations spread over both servers. Every one of them
  // is a read-modify-write of the one `app_kv` row, so a burst is a 6-way
  // contested, no-CAS write.
  for (let burst = 0; burst < 2; burst += 1) {
    const jobs = [
      json(BASE_URLS[burst % 2], '/api/settings/app/providers', 'POST', {
        id: providerId, type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1'
      })
    ];
    const slice = dirs.slice(burst * 6, burst * 6 + 6);
    for (const [i, dir] of slice.entries()) {
      jobs.push(json(BASE_URLS[(burst + i) % BASE_URLS.length], '/api/projects', 'POST', {
        action: 'register', dir, dbBacked: true
      }));
    }
    await Promise.all(jobs);
  }

  const after = await json(BASE_URLS[0], '/api/settings', 'GET');
  const provider = (after.app.providers || []).find((p) => p.id === providerId);
  assert.ok(provider, 'the provider added during the race vanished from the app store (lost app-level update)');

  const registered = await json(BASE_URLS[0], '/api/projects/registered', 'GET');
  const paths = new Set(registered.projects.map((p) => p.path));
  const missing = dirs.filter((d) => !paths.has(d));
  assert.deepEqual(missing, [],
    `${missing.length} of ${dirs.length} projects registered during the race vanished from the app store`);

  // The provider write must not have dropped the settings that were there
  // before it either.
  assert.equal((after.app.projects || []).length >= (before.app.projects || []).length, true,
    'the registered-project list shrank during a concurrent app-store write');
  return `provider survived; all ${dirs.length} concurrent project registrations survived`;
}

// 4. Two servers appending to one chat. appendMessage derives the next `seq`
//    from MAX(seq), so concurrent appends can collide on the primary key
//    (project_dir, chat_id, seq) or silently reuse a seq.
async function caseConcurrentMessageAppend() {
  const created = await json(BASE_URLS[0], '/api/chats', 'POST', { projectDir: PROJECT_DIR, title: 'race append' });
  const chatId = created.chat.id;
  const base = `/api/chats/${encodeURIComponent(chatId)}`;
  const query = `projectDir=${encodeURIComponent(PROJECT_DIR)}`;

  const jobs = [];
  for (let w = 0; w < MESSAGE_WRITERS; w += 1) {
    for (let m = 0; m < MESSAGES_PER_WRITER; m += 1) {
      jobs.push(call(BASE_URLS[(w + m) % BASE_URLS.length], `${base}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          projectDir: PROJECT_DIR,
          role: 'user',
          content: `writer ${w} message ${m}`,
          clientId: messages.newClientId('r')
        })
      }));
    }
  }
  const outs = await Promise.all(jobs);
  const expected = MESSAGE_WRITERS * MESSAGES_PER_WRITER;
  const accepted = outs.filter((o) => o.status === 201).length;
  const conflicts = outs.filter((o) => o.status === 400).length;

  const read = await json(BASE_URLS[0], `${base}/messages?${query}`, 'GET');
  const seqs = read.messages.map((m) => m.seq);
  const unique = new Set(seqs);
  assert.equal(unique.size, seqs.length,
    `concurrent appends produced duplicate seq values: ${seqs.length - unique.size} collision(s) in ${seqs.length} rows`);
  assert.equal(seqs.length, accepted,
    `${accepted} appends were accepted but ${seqs.length} rows are stored (a lost or duplicated append)`);
  // seq is documented as contiguous from 0 per chat, which is the identity the
  // client's merge-by-seq and the window loader's `hasMore` both assume.
  const expectedSeqs = Array.from({ length: seqs.length }, (_, i) => i).join(',');
  assert.equal(seqs.join(','), expectedSeqs,
    `stored seq values are not contiguous from 0: ${seqs.join(',')}`);
  // Report the rejection count separately rather than failing on it: a 400 is
  // a legitimate answer under contention, a silently dropped append is not.
  return `${accepted}/${expected} appends accepted (${conflicts} rejected with 400); ${seqs.length} rows, seq unique and contiguous from 0`;
}

// 5. Chat metadata updated from both servers. chatdb.updateChat() reads the
//    row, merges the patch, and rewrites every column, so a concurrent patch
//    to a different field can be silently reverted.
async function caseConcurrentChatUpdate() {
  const created = await json(BASE_URLS[0], '/api/chats', 'POST', { projectDir: PROJECT_DIR, title: 'race update' });
  const chatId = created.chat.id;
  const path = `/api/chats/${encodeURIComponent(chatId)}`;
  const rounds = SETTINGS_ROUNDS;

  const jobs = [];
  for (let i = 0; i < rounds; i += 1) {
    jobs.push(json(BASE_URLS[0], path, 'PATCH', {
      projectDir: PROJECT_DIR, draft: `draft-a-${i}`, title: `title-a-${i}`
    }));
    jobs.push(json(BASE_URLS[1], path, 'PATCH', {
      projectDir: PROJECT_DIR, promptSize: 'extensive', maxOutputTokens: String(i)
    }));
  }
  await Promise.all(jobs);

  const chat = (await json(BASE_URLS[0], `${path}?projectDir=${encodeURIComponent(PROJECT_DIR)}`, 'GET')).chat;
  // Every field written by the last patch of each family must still be there.
  const lastA = rounds - 1;
  const problems = [];
  if (!/^draft-a-\d+$/.test(String(chat.draft || ''))) problems.push(`draft was reverted to ${JSON.stringify(chat.draft)}`);
  if (!/^title-a-\d+$/.test(String(chat.title || ''))) problems.push(`title was reverted to ${JSON.stringify(chat.title)}`);
  if (chat.promptSize !== 'extensive') problems.push(`promptSize was reverted to ${JSON.stringify(chat.promptSize)}`);
  if (!/^\d+$/.test(String(chat.maxOutputTokens || ''))) problems.push(`maxOutputTokens was reverted to ${JSON.stringify(chat.maxOutputTokens)}`);
  assert.deepEqual(problems, [],
    `concurrent chat PATCH lost a sibling field (last A write was draft-a-${lastA})`);
  return `all four fields survived ${rounds * 2} concurrent PATCHes (draft=${chat.draft}, promptSize=${chat.promptSize})`;
}

// 6. Last-writer-wins pressure on one app-level key. Many concurrent PUTs of
//    a single allowlisted setting must leave ONE of the submitted values — not
//    a merged blob, not a reverted one. `promptSize` is the smallest key in
//    the client allowlist (CLIENT_SETTINGS_KEYS in src/server-shared.js) that
//    a full app-store PATCH accepts, so it round-trips observably.
async function caseConcurrentAppSettingValue() {
  const values = ['very-small', 'average', 'extensive', 'chat'];
  const writes = Array.from({ length: CONCURRENCY }, (_, i) => values[i % values.length]);
  await Promise.all(writes.map((value, i) => json(BASE_URLS[i % BASE_URLS.length], '/api/settings/app', 'PUT', {
    promptSize: value
  })));
  const after = await json(BASE_URLS[0], '/api/settings', 'GET');
  const stored = after.app.promptSize;
  assert.ok(values.includes(stored),
    `a concurrent app-settings write left a value no writer submitted: ${JSON.stringify(stored)}`);
  return `one of ${writes.length} submitted values survived (${stored})`;
}

// ---- Runner --------------------------------------------------------------

const raceTarget = require('./lib/race-target.js');
const messages = require('./lib/race-client-ids.js');

const CASES = [
  ['concurrent file write', caseConcurrentFileWrite],
  ['concurrent project settings', caseConcurrentProjectSettings],
  ['concurrent app store (provider + registrations)', caseConcurrentAppStore],
  ['concurrent message append', caseConcurrentMessageAppend],
  ['concurrent chat update', caseConcurrentChatUpdate],
  ['concurrent app setting value', caseConcurrentAppSettingValue]
];

async function main() {
  console.log(`race probe: ${BASE_URLS.length} servers, project ${PROJECT_DIR}, concurrency ${CONCURRENCY}`);
  await ensureSession();
  await ensureScratchDir();
  for (const [name, run] of CASES) {
    try {
      const detail = await run();
      results.push({ name, ok: true, detail });
      console.log(`PASS  ${name} — ${detail}`);
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
      console.log(`FAIL  ${name} — ${error.message}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} race cases passed.`);
  if (failed) {
    console.log('\nThese failures are the point of the suite: each one is a cross-process race');
    console.log('that a single-server run cannot produce.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('race probe crashed:', error.stack || error);
  process.exitCode = 1;
});