'use strict';

// End-to-end smoke test for src/promptProfiles.js. Exercises the public
// surface (PROFILES, isValidProfile, profileSystemMessage, describeProfile,
// listProfiles, resolveProfile) and the new /api/prompt-profiles
// endpoint that ships in src/index.js. Prints a pass/fail summary and
// exits non-zero on any failure.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// Use a temp MOUAIF_HOME so the test never touches a real project file.
// Must be set BEFORE requiring any src module: settings.js captures the
// home at require time, so setting it below the requires would route the
// test's setProject/setApp writes through the real ~/.mouaif store.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-pp-test-'));
process.env.MOUAIF_HOME = TMP;

const pp = require('../src/promptProfiles.js');
const settings = require('../src/settings.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf, parseError: e.message }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // 1) Module shape.
  check('exports PROFILES', pp.PROFILES && typeof pp.PROFILES === 'object');
  check('exports DEFAULT_PROFILE', pp.DEFAULT_PROFILE === 'average');
  check('PROFILES has 4 entries', Object.keys(pp.PROFILES).length === 4,
    'got: ' + Object.keys(pp.PROFILES).length);

  // 2) Each profile carries the documented fields.
  for (const id of ['very-small', 'average', 'extensive']) {
    const p = pp.PROFILES[id];
    check('PROFILES[' + id + '] has id', p && p.id === id);
    check('PROFILES[' + id + '] has label', typeof (p && p.label) === 'string' && p.label.length > 0);
    check('PROFILES[' + id + '] has description', typeof (p && p.description) === 'string' && p.description.length > 0);
    check('PROFILES[' + id + '] has summary', typeof (p && p.summary) === 'string' && p.summary.length > 0);
    check('PROFILES[' + id + '] has non-empty systemMessage',
      typeof (p && p.systemMessage) === 'string' && p.systemMessage.length > 0);
  }

  // 2b) The `chat` profile: empty system prompt, but otherwise a normal
  //     prompt-style value — it does not touch the chat's tool list.
  const chatP = pp.PROFILES['chat'];
  check('PROFILES[chat] exists with a label', chatP && chatP.id === 'chat' && chatP.label === 'Chat');
  check('PROFILES[chat] has an empty systemMessage', chatP && chatP.systemMessage === '');
  check('profileSystemMessage(chat) stays empty', pp.profileSystemMessage('chat') === '');

  // 3) The three profiles carry distinct messages (the "very-small" one
  //    is intentionally the shortest).
  const sizes = {
    'very-small': pp.PROFILES['very-small'].systemMessage.length,
    'average':    pp.PROFILES['average'].systemMessage.length,
    'extensive':  pp.PROFILES['extensive'].systemMessage.length
  };
  check('very-small < average',  sizes['very-small'] < sizes['average'],
    'very-small=' + sizes['very-small'] + ' average=' + sizes['average']);
  check('average < extensive',   sizes['average'] < sizes['extensive'],
    'average=' + sizes['average'] + ' extensive=' + sizes['extensive']);

  // Larger profiles extend the same rules instead of replacing them.
  const core = pp.profileSystemMessage('very-small');
  const average = pp.profileSystemMessage('average');
  const extensive = pp.profileSystemMessage('extensive');
  check('very-small stays compact', core.length < 1800, 'chars=' + core.length);
  check('average extends the complete compact core', average.startsWith(core + '\n\n'));
  check('extensive extends the complete average workflow', extensive.startsWith(average + '\n\n'));
  const sharedRules = [
    ['mobile-friendly answers', /short Markdown.*language-tagged code fences.*project-relative paths/],
    ['instruction priority', /project and custom instructions.*higher-priority instructions/],
    ['safe autonomy', /reversible decisions.*Ask when ambiguity affects scope, safety, or correctness/],
    ['explicit authorization for risky actions', /Ask before destructive actions.*unless explicitly authorized/],
    ['preserves user work', /Preserve unrelated user work/],
    ['enabled tools and schema discovery', /only enabled tools.*authorization gates.*discover_tool/],
    ['inspect-edit-verify loop', /Inspect before editing.*run relevant checks.*fix introduced failures/],
    ['non-interactive shell', /Shell has no stdin.*non-interactive commands.*never a REPL/],
    ['conditional progress on every task', /If report_progress is enabled.*start of every task.*status: "running"/],
    ['honest progress completion', /status: "completed" and current equal to total.*status: "failed" if blocked/],
    ['evidence and privacy', /Never invent project facts or test results.*checks run.*limitations.*Do not expose secrets/]
  ];
  // `chat` is intentionally empty, so it carries none of the shared rules.
  for (const profile of pp.listProfiles().filter((p) => p.id !== 'chat')) {
    for (const [rule, pattern] of sharedRules) {
      check(profile.id + ' includes ' + rule, pattern.test(profile.systemMessage));
    }
  }
  for (const id of ['average', 'extensive']) {
    const message = pp.profileSystemMessage(id);
    check(id + ' explains exact edits', message.includes('exact, unique oldText/newText'));
    check(id + ' distinguishes implementation from review', message.includes('answer without changing files unless asked'));
    check(id + ' reports unrun checks', message.includes('State clearly when checks could not run'));
    check(id + ' supports progress-disabled projects', message.includes('If the tool is unavailable'));
  }
  check('extensive includes concrete workflow examples', extensive.includes('Workflow examples:') && extensive.includes('Bug fix:') && extensive.includes('Blocked check:'));
  // 4) isValidProfile.
  check('isValidProfile("average")',     pp.isValidProfile('average') === true);
  check('isValidProfile("very-small")',  pp.isValidProfile('very-small') === true);
  check('isValidProfile("extensive")',   pp.isValidProfile('extensive') === true);
  check('isValidProfile("huge") is false', pp.isValidProfile('huge') === false);
  check('isValidProfile(null) is false',   pp.isValidProfile(null) === false);
  check('isValidProfile(undefined) is false', pp.isValidProfile(undefined) === false);
  check('isValidProfile(42) is false',    pp.isValidProfile(42) === false);

  // 5) profileSystemMessage falls back to default on bad input.
  check('profileSystemMessage("average") matches PROFILES', pp.profileSystemMessage('average') === pp.PROFILES['average'].systemMessage);
  check('profileSystemMessage("garbage") returns default', pp.profileSystemMessage('garbage') === pp.PROFILES['average'].systemMessage);
  check('profileSystemMessage(null) returns default',      pp.profileSystemMessage(null) === pp.PROFILES['average'].systemMessage);

  // 6) describeProfile returns a copy and null on bad input.
  const d = pp.describeProfile('very-small');
  check('describeProfile("very-small") is a copy', d && d.id === 'very-small' && d !== pp.PROFILES['very-small']);
  check('describeProfile("nope") is null', pp.describeProfile('nope') === null);
  // Mutating the copy must not leak into the module.
  d.id = 'MUTATED';
  check('describeProfile copy is detached', pp.PROFILES['very-small'].id === 'very-small');

  // 7) listProfiles returns 3 entries with the expected ids.
  const list = pp.listProfiles();
  check('listProfiles length 4', list.length === 4);
  check('listProfiles has all ids',
    list.some(p => p.id === 'very-small') &&
    list.some(p => p.id === 'average') &&
    list.some(p => p.id === 'extensive') &&
    list.some(p => p.id === 'chat'));
  // Copies, not references.
  check('listProfiles entries are copies', list.every(p => p !== pp.PROFILES[p.id]));

  // 8) resolveProfile — chat.promptSize wins.
  const a = pp.resolveProfile({ chat: { promptSize: 'very-small' } });
  check('resolveProfile uses chat.promptSize',
    a && a.id === 'very-small',
    'got: ' + (a && a.id));
  check('resolveProfile returns systemMessage',
    typeof (a && a.systemMessage) === 'string' && a.systemMessage === pp.PROFILES['very-small'].systemMessage);

  // 9) resolveProfile — falls through to project when chat has no value.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-pp-proj-'));
  // No project file, no app override -> 'average'.
  const b = pp.resolveProfile({ chat: {}, projectDir });
  check('resolveProfile falls through to default (no project, no app)',
    b && b.id === 'average',
    'got: ' + (b && b.id));

  // 10) resolveProfile — project.promptSize wins when chat has no value.
  settings.setProject(projectDir, { promptSize: 'extensive' });
  const c = pp.resolveProfile({ chat: {}, projectDir });
  check('resolveProfile uses project.promptSize',
    c && c.id === 'extensive',
    'got: ' + (c && c.id));

  // 11) resolveProfile — chat.promptSize overrides project.
  const d2 = pp.resolveProfile({ chat: { promptSize: 'very-small' }, projectDir });
  check('resolveProfile chat wins over project',
    d2 && d2.id === 'very-small',
    'got: ' + (d2 && d2.id));

  // 12) resolveProfile — invalid chat value falls through to project.
  const e = pp.resolveProfile({ chat: { promptSize: 'huge' }, projectDir });
  check('resolveProfile invalid chat value falls through to project',
    e && e.id === 'extensive',
    'got: ' + (e && e.id));

  // 13) resolveProfile — invalid chat and project falls through to default.
  settings.setProject(projectDir, { promptSize: 'garbage' });
  const f = pp.resolveProfile({ chat: { promptSize: 'huge' }, projectDir });
  check('resolveProfile invalid chat and project -> default',
    f && f.id === 'average',
    'got: ' + (f && f.id));

  // 14) resolveProfile — never throws, returns default on total garbage.
  let threw = null;
  try { pp.resolveProfile({ chat: 'not an object', projectDir: 42 }); }
  catch (err) { threw = err; }
  check('resolveProfile never throws on garbage input', threw === null,
    'threw: ' + (threw && threw.message));

  // 14b) reduceToolSpecs — the core §4 behavior: prompt size trims the
  // tool declaration sent upstream.
  const sampleSpecs = [{
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command in the project directory.\nSecond line with more detail.',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
    }
  }];
  const full = pp.reduceToolSpecs(sampleSpecs, 'average');
  check('reduceToolSpecs average keeps full parameters',
    full[0].function.parameters && full[0].function.parameters.properties.cmd,
    'got: ' + JSON.stringify(full[0].function.parameters));
  check('reduceToolSpecs does not mutate the input',
    sampleSpecs[0].function.parameters.properties.cmd,
    'input was mutated');
  const ext = pp.reduceToolSpecs(sampleSpecs, 'extensive');
  check('reduceToolSpecs extensive keeps full parameters',
    ext[0].function.parameters && ext[0].function.parameters.properties.cmd,
    'got: ' + JSON.stringify(ext[0].function.parameters));
  const tiny = pp.reduceToolSpecs(sampleSpecs, 'very-small');
  check('reduceToolSpecs very-small exposes discover_tool plus one compact entry per tool',
    tiny.length === 1 + sampleSpecs.length &&
    tiny[0].function.name === 'discover_tool' &&
    tiny.slice(1).every(s => s.function.name === 'shell' || s.function.name === 'list_files'),
    'got: ' + JSON.stringify(tiny.map(s => s.function.name)));
  check('reduceToolSpecs very-small discover_tool lists tool names',
    tiny[0].function.description.indexOf('shell') !== -1 &&
    tiny[0].function.parameters.properties.toolName.enum.indexOf('shell') !== -1,
    'got: ' + JSON.stringify(tiny[0].function));
  check('reduceToolSpecs very-small compact entries are schema-less',
    tiny.slice(1).every(s => !s.function.parameters),
    'got: ' + JSON.stringify(tiny.slice(1)));
  // The very-small tool list must be byte-stable across discovery: a
  // growing list would change the Anthropic cached prefix (system + tools)
  // between tool-loop requests and invalidate the warm cache every round.
  const tinyDiscovered = pp.reduceToolSpecs(sampleSpecs, 'very-small', { discoveredToolNames: new Set(['shell']) });
  check('reduceToolSpecs very-small list is byte-identical after discovery',
    JSON.stringify(tiny) === JSON.stringify(tinyDiscovered),
    'got before: ' + JSON.stringify(tiny.map(s => s.function.name)) +
    ' after: ' + JSON.stringify(tinyDiscovered.map(s => s.function.name)));
  check('reduceToolSpecs invalid profile falls through to full',
    pp.reduceToolSpecs(sampleSpecs, 'huge')[0].function.parameters.properties.cmd,
    'unknown profile did not keep full specs');
  check('reduceToolSpecs empty input returns empty array',
    Array.isArray(pp.reduceToolSpecs([], 'average')) && pp.reduceToolSpecs([], 'average').length === 0,
    'did not return empty array');

  // 15) Exercise the real HTTP server on an ephemeral loopback port.
  // Never launch the CLI or connect to the host app's running server.
  const { createServer, destroyOpenSockets, DEFAULT_PORT } = require('../src/index.js');
  check('serve default port remains 5732', DEFAULT_PORT === 5732);
  const server = createServer(0);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const root = await get(port, '/');
    check('GET / serves the app shell', root.status === 200 && typeof root.body === 'string' && /<html/i.test(root.body));
    const r = await get(port, '/api/prompt-profiles');
    check('GET /api/prompt-profiles 200', r.status === 200, 'got: ' + r.status);
    check('GET /api/prompt-profiles has default', r.body && r.body.default === 'average');
    check('GET /api/prompt-profiles has 3 entries',
      r.body && Array.isArray(r.body.profiles) && r.body.profiles.length === 4,
      'got: ' + (r.body && r.body.profiles && r.body.profiles.length));
    check('GET /api/prompt-profiles entries carry id+label',
      r.body && r.body.profiles.every(p => p.id && p.label && p.description && p.summary));
    // The system message is exposed to the UI so a future preview pane
    // can show "this is what the model is being told". It is not a
    // secret — every other API client ships its system prompt in
    // plain text — but we do verify it is the same string the
    // server-side resolver returns.
    check('GET /api/prompt-profiles exposes systemMessage',
      r.body && r.body.profiles.every(p =>
        typeof p.systemMessage === 'string' && (p.systemMessage.length > 0 || p.id === 'chat') &&
        p.systemMessage === pp.PROFILES[p.id].systemMessage));
    // The `chat` profile is a plain prompt-style value: it must NOT change
    // a chat's tool list (that was the old behaviour being removed).
    const chats = require('../src/chats.js');
    const c1 = chats.createChat(projectDir, { promptSize: 'chat' });
    check('createChat(chat) keeps all tools', c1.promptSize === 'chat' && c1.tools == null,
    'tools=' + JSON.stringify(c1.tools));
    const c2 = chats.updateChat(projectDir, c1.id, { promptSize: 'average' });
    check('switching chat -> average keeps all tools', c2 && c2.promptSize === 'average' && c2.tools == null);
    const c3 = chats.updateChat(projectDir, c2.id, { promptSize: 'chat' });
    check('switching to chat keeps all tools', c3 && c3.promptSize === 'chat' && c3.tools == null,
    'tools=' + JSON.stringify(c3 && c3.tools));
    const c4 = chats.createChat(projectDir, { promptSize: 'average' });
    check('other profiles keep all tools', c4.tools == null);
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      destroyOpenSockets();
    });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  // Cleanup
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
