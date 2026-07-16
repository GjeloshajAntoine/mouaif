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

const pp = require('../src/promptProfiles.js');
const settings = require('../src/settings.js');

// Use a temp MOUAIF_HOME so the test never touches a real project file.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-pp-test-'));
process.env.MOUAIF_HOME = TMP;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 5732, path: urlPath }, (res) => {
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
  check('PROFILES has 3 entries', Object.keys(pp.PROFILES).length === 3,
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
  check('listProfiles length 3', list.length === 3);
  check('listProfiles has all ids',
    list.some(p => p.id === 'very-small') &&
    list.some(p => p.id === 'average') &&
    list.some(p => p.id === 'extensive'));
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
  check('reduceToolSpecs very-small drops parameter schema',
    tiny[0].function.parameters && Object.keys(tiny[0].function.parameters.properties).length === 0,
    'got: ' + JSON.stringify(tiny[0].function.parameters));
  check('reduceToolSpecs very-small keeps the tool name',
    tiny[0].function.name === 'shell',
    'got: ' + tiny[0].function.name);
  check('reduceToolSpecs very-small clamps description to first line',
    tiny[0].function.description === 'Run a shell command in the project directory.',
    'got: ' + tiny[0].function.description);
  check('reduceToolSpecs invalid profile falls through to full',
    pp.reduceToolSpecs(sampleSpecs, 'huge')[0].function.parameters.properties.cmd,
    'unknown profile did not keep full specs');
  check('reduceToolSpecs empty input returns empty array',
    Array.isArray(pp.reduceToolSpecs([], 'average')) && pp.reduceToolSpecs([], 'average').length === 0,
    'did not return empty array');

  // 15) /api/prompt-profiles endpoint.
  //     Spin up the server, hit the endpoint, tear it down.
  const { startServer } = (() => {
    // Require the server module lazily so the test's own process
    // doesn't bind port 5732 in CI; we just need a callback that
    // accepts a port.
    return { startServer: null };
  })();

  // Easier path: start the real `node bin/mouaif.js serve` in a
  // child process bound to 5732, hit the endpoint, kill the child.
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mouaif.js'), 'serve'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { MOUAIF_HOME: TMP }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });

  // Wait for the server to be ready (poll /api/prompt-profiles).
  let ready = false;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const r = await get('/api/prompt-profiles');
      if (r.status === 200) { ready = true; break; }
    } catch { /* not up yet */ }
  }
  check('server started on 5732', ready, 'stdout: ' + stdout + ' stderr: ' + stderr);

  if (ready) {
    const r = await get('/api/prompt-profiles');
    check('GET /api/prompt-profiles 200', r.status === 200, 'got: ' + r.status);
    check('GET /api/prompt-profiles has default', r.body && r.body.default === 'average');
    check('GET /api/prompt-profiles has 3 entries',
      r.body && Array.isArray(r.body.profiles) && r.body.profiles.length === 3,
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
        typeof p.systemMessage === 'string' && p.systemMessage.length > 0 &&
        p.systemMessage === pp.PROFILES[p.id].systemMessage));
  }

  // Teardown.
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 200));
  try { child.kill('SIGKILL'); } catch { /* ignore */ }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  // Cleanup
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
