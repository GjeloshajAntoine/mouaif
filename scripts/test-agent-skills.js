'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const skills = require('../src/agentSkills.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-skills-'));
try {
  const dir = path.join(root, '.agents', 'skills', 'pdf-processing');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: pdf-processing\ndescription: Process PDFs when users mention forms.\ncompatibility: Requires PDF tools\nmetadata:\n  author: test\n---\n# PDF instructions\nRead references/guide.md as needed.\n');
  fs.writeFileSync(path.join(dir, 'references', 'guide.md'), '# Guide\n');
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'invalid'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'invalid', 'SKILL.md'), '# no frontmatter\n');
  const found = skills.discover(root);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'pdf-processing');
  assert.match(found[0].description, /PDFs/);
  assert.match(skills.catalogMessage(root, {}), /metadata only/);
  assert.doesNotMatch(skills.catalogMessage(root, {}), /PDF instructions/);
  const spec = skills.buildSpec(root, {});
  assert.deepStrictEqual(spec.function.parameters.properties.name.enum, ['pdf-processing']);
  const active = skills.activate(root, {}, 'pdf-processing');
  assert.match(active.content, /PDF instructions/);
  assert.deepStrictEqual(active.result.resources, ['references/guide.md']);
  assert.throws(() => skills.activate(root, {}, 'missing'), /unavailable/);
  console.log('agent skills: 10 assertions passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
