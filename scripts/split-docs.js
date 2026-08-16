#!/usr/bin/env node
// scripts/split-docs.js
// One-shot migration helper: split each docs/features/<slug>.md into
//
//   docs/features/<slug>.md        human-facing surface only
//   docs/agent/features/<slug>.md  agent-facing implementation notes
//
// It is intentionally conservative and idempotent. It only *adds* the
// docs/agent/ tree and trims sections out of the human copy; it never
// rewrites prose. Run it once, review the diff, then it can be deleted.
//
// Splitting policy (heading-text based, subtree-scoped):
//   * A section whose heading matches MOVE_SECTIONS moves to the agent copy,
//     together with any deeper-level subsections under it. The move ends at
//     the next heading of equal or shallower level.
//   * Everything else stays in the human copy. The H1 and any prologue above
//     the first `##` always stay human.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FEATURES = path.join(ROOT, 'docs', 'features');
const AGENT = path.join(ROOT, 'docs', 'agent', 'features');

const MOVE_SECTIONS = [
  /^implementation(?: notes)?$/i,
  /^rest(?: surface)?$/i,
  /^http(?: surface)?$/i,
  /^rest api$/i,
  /^api$/i,
  /^backend(?: api)?$/i,
  /^server(?: endpoints)?$/i,
  /^endpoints?$/i,
  /^storage$/i,
  /^test fixture$/i,
  /^programmatic(?: \(node\))?$/i,
  /^model record$/i,
  /^live model list$/i,
  /^model awareness$/i,
  /^model guidance$/i,
  /^rendering pipeline$/i,
  /^auto-link safety$/i,
];

function isMoveHeading(headingText) {
  return MOVE_SECTIONS.some((re) => re.test(headingText));
}

// Split the source into top-level sections keyed by heading. The H1 is
// returned separately as `h1` and is NOT included in `sections`, so the
// prologue (H1 + anything before the first `##`) stays human-owned.
function parseSections(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  let h1 = '';
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      if (m[1].length === 1) {
        if (!h1) h1 = m[2].trim();
        continue;
      }
      if (cur) sections.push(cur);
      cur = { level: m[1].length, heading: m[2].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) sections.push(cur);
  return { h1, sections };
}

function toMd(sections) {
  return sections
    .map((s) => '#'.repeat(s.level) + ' ' + s.heading + '\n' + s.body.join('\n'))
    .join('\n')
    .trim() + '\n';
}

function splitFile(file) {
  const rel = path.relative(FEATURES, file).split(path.sep).join('/');
  const md = fs.readFileSync(file, 'utf8');
  const { h1, sections } = parseSections(md);

  const humanSections = [];
  const agentSections = [];
  let trimmed = false;

  // When set, deeper-level sections move to agent until a heading of equal
  // or shallower level is reached.
  let moveUntilLevel = null;

  for (const sec of sections) {
    if (moveUntilLevel != null) {
      if (sec.level <= moveUntilLevel) moveUntilLevel = null;
      else {
        agentSections.push(sec);
        continue;
      }
    }
    if (isMoveHeading(sec.heading)) {
      moveUntilLevel = sec.level;
      trimmed = true;
      agentSections.push(sec);
      continue;
    }
    humanSections.push(sec);
  }

  const humanHead = (h1 ? '# ' + h1 + '\n' : '');
  let human = humanHead;
  if (humanSections.length) human += '\n' + toMd(humanSections);

  let agent = '';
  if (agentSections.length) {
    agent = '# ' + (h1 || rel.replace(/\.md$/, '')) + ' — implementation notes\n\n' +
      '> Agent-facing reference for [`docs/features/' + rel + '`](../../features/' + rel + '). ' +
      'The human-facing surface lives in that file; the implementation details, wire shapes, ' +
      'and source paths live here.\n\n' +
      toMd(agentSections);
  }

  return {
    human: trimmed ? human : md,
    agent,
    trimmed,
  };
}

function main() {
  const only = [];
  for (const a of process.argv.slice(2)) {
    if (a === '--only' ) continue;
    if (a.startsWith('--only=')) only.push(...a.slice(7).split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: node scripts/split-docs.js [--only=<slug>[,<slug>...]]\n');
      process.exit(0);
    }
  }
  if (!fs.existsSync(FEATURES)) {
    process.stderr.write('error: docs/features not found\n');
    process.exit(2);
  }
  const files = fs.readdirSync(FEATURES)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .filter((f) => only.length === 0 || only.includes(f.replace(/\.md$/, '')))
    .map((f) => path.join(FEATURES, f));

  let humanChanged = 0;
  let agentWritten = 0;
  for (const file of files) {
    const rel = path.relative(FEATURES, file).split(path.sep).join('/');
    const { human, agent, trimmed } = splitFile(file);
    if (trimmed) {
      fs.writeFileSync(file, human);
      humanChanged++;
    }
    if (agent.trim()) {
      const out = path.join(AGENT, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, agent);
      agentWritten++;
    }
  }
  process.stdout.write(`[split-docs] trimmed ${humanChanged} human page(s), wrote ${agentWritten} agent page(s)\n`);
}

main();
