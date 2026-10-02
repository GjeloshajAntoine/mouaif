#!/usr/bin/env node
'use strict';

// Generate frontend/build/toolGroups.json from frontend/src/toolGroups.js —
// the one file that decides which tool belongs to which group.
//
// Why a generated mirror: the server groups tools for the agent feature
// summary and needs the same names the UI shows, but the model lives in
// frontend/src as an ES module (the UI's own source of truth). A tiny JSON
// mirror keeps ONE definition without duplicating it, and
// scripts/test-tool-groups.js fails if the mirror drifts.
//
// Run: node scripts/build-tool-groups.js [--check]

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'frontend', 'src', 'toolGroups.js');
const OUT = path.join(__dirname, '..', 'frontend', 'build', 'toolGroups.json');

// The module is a frozen literal list, so it can be read without a bundler:
// evaluate it with the `export` keywords stripped and the module's own
// imports removed (it has none).
function loadGroups() {
  const source = fs.readFileSync(SRC, 'utf8')
    .replace(/^export /gm, '')
    .replace(/^import .*;$/gm, '');
  const run = new Function(source + '\nreturn TOOL_GROUPS;');
  return run();
}

function serialize(groups) {
  // Keep the mirror readable and reviewable: one group per line.
  return JSON.stringify(groups, null, 2) + '\n';
}

function main() {
  const groups = loadGroups();
  const body = serialize(groups);
  const check = process.argv.includes('--check');
  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== body) {
      console.error('toolGroups.json is stale — run: node scripts/build-tool-groups.js');
      process.exit(1);
    }
    console.log('tool groups mirror is current (' + groups.length + ' groups)');
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
  console.log('wrote ' + path.relative(path.join(__dirname, '..'), OUT) + ' (' + groups.length + ' groups)');
}

main();
