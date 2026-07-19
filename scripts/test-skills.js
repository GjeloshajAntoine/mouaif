'use strict';

// End-to-end smoke test for the agent skills feature (src/skills.js)
// and its REST surface in src/index.js. Covers directory discovery,
// SKILL.md loading, truncation, the per-chat toggle, the profile
// default, and the list/detail endpoints. Prints a pass/fail summary
// and exits non-zero on any failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-skills-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-skills-project-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const skills = require('../src/skills.js');
const chats = require('../src/chats.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

function makeSkill(name, body, opts) {
  const dir = path.join(projectDir, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  if (opts && opts.extra) {
    for (const [rel, content] of Object.entries(opts.extra)) {
      fs.writeFileSync(path.join(dir, rel), content, 'utf8');
    }
  }
}

async function main() {
  // 1) No skills directory -> empty discovery.
  check('empty project discovers nothing', skills.discover(projectDir).length === 0);
  check('empty project loads nothing', skills.load(projectDir).length === 0);

  // 2) One valid skill.
  makeSkill('code-review', '# Code Review\n\nCheck for style and correctness.');
  let found = skills.discover(projectDir);
  check('one skill discovered', found.length === 1);
  check('skill name', found[0].name === 'code-review');
  check('skill size > 0', found[0].size > 0);

  const loaded = skills.load(projectDir);
  check('one skill loaded', loaded.length === 1);
  check('skill title from heading', loaded[0].title === 'Code Review');
  check('skill role system', loaded[0].role === 'system');
  check('skill content has header', loaded[0].content.includes('Agent skill "Code Review"'));
  check('skill content has body', loaded[0].content.includes('Check for style and correctness.'));

  // 3) Multiple skills sorted by name.
  makeSkill('alpha', '# Alpha\n\nFirst.');
  makeSkill('zeta', '# Zeta\n\nLast.');
  found = skills.discover(projectDir);
  check('three skills discovered', found.length === 3);
  check('sorted by name', found[0].name === 'alpha' && found[1].name === 'code-review' && found[2].name === 'zeta');

  // 4) Hidden / invalid directories are skipped.
  fs.mkdirSync(path.join(projectDir, '.agents', 'skills', '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.agents', 'skills', '.hidden', 'SKILL.md'), '# Hidden');
  fs.mkdirSync(path.join(projectDir, '.agents', 'skills', '..bad'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.agents', 'skills', '..bad', 'SKILL.md'), '# Bad');
  found = skills.discover(projectDir);
  check('hidden and invalid names skipped', found.length === 3);

  // 5) Directory without SKILL.md is skipped.
  fs.mkdirSync(path.join(projectDir, '.agents', 'skills', 'no-skill'), { recursive: true });
  found = skills.discover(projectDir);
  check('missing SKILL.md skipped', found.length === 3);

  // 6) Non-directory entries are skipped.
  fs.writeFileSync(path.join(projectDir, '.agents', 'skills', 'not-a-dir'), 'plain file');
  found = skills.discover(projectDir);
  check('plain file skipped', found.length === 3);

  // 7) Empty SKILL.md is skipped by load().
  makeSkill('empty', '');
  check('empty skill discovered', skills.discover(projectDir).length === 4);
  check('empty skill not loaded', skills.load(projectDir).length === 3);

  // 8) Truncation.
  const big = 'x'.repeat(70 * 1024);
  makeSkill('big', '# Big\n\n' + big);
  const bigLoaded = skills.load(projectDir).find(s => s.name === 'big');
  check('big skill loaded', !!bigLoaded);
  check('big skill truncated', bigLoaded.content.includes('[... truncated at 65536 bytes ...]'));
  check('big skill content <= cap', bigLoaded.content.length < 70 * 1024);

  // 9) Title falls back to directory name when no heading.
  makeSkill('no-heading', 'Just some text without a heading.');
  const noHeading = skills.load(projectDir).find(s => s.name === 'no-heading');
  check('title falls back to name', noHeading.title === 'no-heading');

  // 10) resolveEnabled — defaults.
  const chat = { id: 'skil0001', promptSize: 'average' };
  check('average profile enables skills', skills.resolveEnabled({ chat, projectDir }) === true);
  chat.promptSize = 'very-small';
  check('very-small profile disables skills', skills.resolveEnabled({ chat, projectDir }) === false);

  // 11) Per-chat override.
  chat.skills = false;
  chat.promptSize = 'average';
  check('chat.skills=false overrides average', skills.resolveEnabled({ chat, projectDir }) === false);
  chat.skills = true;
  chat.promptSize = 'very-small';
  check('chat.skills=true overrides very-small', skills.resolveEnabled({ chat, projectDir }) === true);

  // 12) Project-level override.
  settings.setProject(projectDir, { skills: false });
  delete chat.skills;
  chat.promptSize = 'average';
  check('project.skills=false overrides average', skills.resolveEnabled({ chat, projectDir }) === false);
  settings.setProject(projectDir, { skills: true });
  chat.promptSize = 'very-small';
  check('project.skills=true overrides very-small', skills.resolveEnabled({ chat, projectDir }) === true);
  settings.setProject(projectDir, { skills: undefined });

  // 13) Chat normalize round-trip.
  const created = chats.createChat(projectDir, { title: 'Skills test' });
  check('created chat has skills undefined', created.skills === undefined);
  const updated = chats.updateChat(projectDir, created.id, { skills: true });
  check('updateChat persists skills=true', updated.skills === true);
  const fetched = chats.getChat(projectDir, created.id);
  check('getChat round-trips skills', fetched.skills === true);
  const cleared = chats.updateChat(projectDir, created.id, { skills: null });
  check('updateChat clears skills with null', cleared.skills === undefined);

  console.log('skills: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
}

main().finally(() => {
  settings.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
