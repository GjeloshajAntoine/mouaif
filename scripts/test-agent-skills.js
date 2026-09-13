'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The chat-record half of this test writes through chats.js, which stores
// chats in the app SQLite file under MOUAIF_HOME. Point that at a temp dir
// before settings.js is loaded so the developer's real store is untouched.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-skills-home-'));
process.env.MOUAIF_HOME = HOME;

const skills = require('../src/agentSkills.js');
const chats = require('../src/chats.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-skills-'));
try {
  const dir = path.join(root, '.agents', 'skills', 'pdf-processing');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: pdf-processing\ndescription: Process PDFs when users mention forms.\ncompatibility: Requires PDF tools\nmetadata:\n  author: test\n---\n# PDF instructions\nRead references/guide.md as needed.\n');
  fs.writeFileSync(path.join(dir, 'references', 'guide.md'), '# Guide\n');
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'invalid'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'invalid', 'SKILL.md'), '# no frontmatter\n');
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'testing'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'testing', 'SKILL.md'), '---\nname: testing\ndescription: Run and diagnose project tests.\n---\n# Testing instructions\n');
  const found = skills.discover(root);
  assert.strictEqual(found.length, 2);
  assert.strictEqual(found[0].name, 'pdf-processing');
  assert.match(found[0].description, /PDFs/);
  assert.match(skills.catalogMessage(root, {}), /metadata only/);
  assert.doesNotMatch(skills.catalogMessage(root, {}), /PDF instructions/);
  const spec = skills.buildSpec(root, {});
  assert.deepStrictEqual(spec.function.parameters.properties.name.enum, ['pdf-processing', 'testing']);
  const active = skills.activate(root, {}, 'pdf-processing');
  assert.match(active.content, /PDF instructions/);
  assert.deepStrictEqual(active.result.resources, ['references/guide.md']);
  assert.throws(() => skills.activate(root, {}, 'missing'), /unavailable/);

  // ---- Per-chat per-skill opt-outs -------------------------------------
  // One skill switched off in a chat must leave its siblings alone, so the
  // catalog keeps the other skills and only filters the opted-out one.
  const chatOff = { skills: true, disabledSkills: ['pdf-processing'] };
  const chatOffCatalog = skills.catalogMessage(root, chatOff);
  assert.match(chatOffCatalog, /- testing: Run and diagnose project tests\./);
  assert.doesNotMatch(chatOffCatalog, /pdf-processing/);
  assert.deepStrictEqual(skills.buildSpec(root, chatOff).function.parameters.properties.name.enum, ['testing']);
  assert.throws(() => skills.activate(root, chatOff, 'pdf-processing'), /unavailable/);
  const oneOff = skills.resolve({ chat: chatOff, projectDir: root });
  assert.strictEqual(oneOff.enabled, true);
  assert.strictEqual(oneOff.chatDisabled.has('pdf-processing'), true);
  assert.strictEqual(oneOff.projectDisabled.has('pdf-processing'), false);
  assert.strictEqual(oneOff.disabled.has('pdf-processing'), true);

  // Every skill opted out is the same catalog as the family toggle being
  // off — the state the row switches land on when the last one goes off.
  const allOff = { skills: true, disabledSkills: ['pdf-processing', 'testing'] };
  assert.strictEqual(skills.catalogMessage(root, allOff), '');
  assert.strictEqual(skills.buildSpec(root, allOff), null);

  // The family toggle still wins over the per-skill list.
  assert.deepStrictEqual(skills.available(root, { skills: false, disabledSkills: ['testing'] }), []);

  // A garbage `disabledSkills` (hand-edited .mouaif.json) is ignored, not fatal.
  assert.strictEqual(skills.resolve({ chat: { disabledSkills: 'testing' }, projectDir: root }).disabled.size, 0);

  // ---- Persistence on the chat record ---------------------------------
  const chat = chats.createChat(root, { disabledSkills: ['testing'] });
  assert.deepStrictEqual(chat.disabledSkills, ['testing']);
  assert.deepStrictEqual(skills.resolve({ chat, projectDir: root }).chatDisabled, new Set(['testing']));
  assert.deepStrictEqual(skills.buildSpec(root, chat).function.parameters.properties.name.enum, ['pdf-processing']);

  // Turning the last one back on clears the list (NULL, read back as absent).
  const cleared = chats.updateChat(root, chat.id, { disabledSkills: [] });
  assert.strictEqual(cleared.disabledSkills, undefined);
  assert.strictEqual(chats.getChat(root, chat.id).disabledSkills, undefined);

  // An unrelated PATCH keeps the opt-out list intact.
  chats.updateChat(root, chat.id, { disabledSkills: ['pdf-processing'] });
  chats.updateChat(root, chat.id, { title: 'renamed' });
  assert.deepStrictEqual(chats.getChat(root, chat.id).disabledSkills, ['pdf-processing']);

  // Duplicates collapse and unknown ids are harmless (they simply match
  // nothing in the discovered catalog).
  assert.deepStrictEqual(chats.updateChat(root, chat.id, { disabledSkills: ['testing', 'testing', 'ghost'] }).disabledSkills, ['testing', 'ghost']);

  console.log('agent skills: 28 assertions passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
}
