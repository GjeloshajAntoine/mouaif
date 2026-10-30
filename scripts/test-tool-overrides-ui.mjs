// Tool wording page (docs/features/tool-overrides.md): the pure helpers the
// page edits and imports through, and the wiring that makes it reachable from
// Settings → Project below the tool tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(read('frontend/src/components/settings/toolOverrides.js').replace(/^export /gm, '')
  + '\n;globalThis.__m = { normalizeOverrides, parseImport, mergeOverrides, exportText, fieldList, fieldProblem, isCustomized, searchTools, overridesFromResolved, diffWords, diffStats, changedTools, renameProblems, normalizeWording, wordingFromResolved, newSetId, uniqueSetName, snapshotBuiltIn, effectiveEntry, differsFromBuiltIn, wordingChanges, initialSelection, selectionAfterDelete, newSetTools };',
context);
// Values built inside the vm come from another realm; compare through JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));
const m = context.__m;

// ---- helpers --------------------------------------------------------------
assert.deepEqual(plain(m.normalizeOverrides({ t: { description: ' d ', fields: { a: 'b', c: 'bad name' } } })), { t: { description: 'd', fields: { a: 'b' } } });
assert.deepEqual(plain(m.overridesFromResolved(null)), {});
assert.deepEqual(plain(m.overridesFromResolved({ toolOverrides: { t: { description: 'x' } } })), { t: { description: 'x' } });

const props = { cmd: {}, cwd: {} };
assert.equal(m.fieldProblem('cmd', '', props, {}), '', 'empty means keep');
assert.equal(m.fieldProblem('cmd', 'cmd', props, {}), '', 'same name means keep');
assert.match(m.fieldProblem('cmd', 'bad name', props, {}), /letters/);
assert.match(m.fieldProblem('cmd', 'cwd', props, {}), /already has a field/);
assert.match(m.fieldProblem('cmd', 'dir', props, { cmd: 'dir', cwd: 'dir' }), /Another field/);
assert.equal(m.fieldProblem('cmd', 'command', props, { cmd: 'command' }), '');

{
  const direct = m.parseImport('{"shell":{"description":"Run","fields":{"cmd":"command"}},"empty":{}}');
  assert.equal(direct.error, '');
  assert.equal(direct.tools, 1);
  assert.equal(direct.skipped, 1);
  assert.deepEqual(plain(direct.overrides), { shell: { description: 'Run', fields: { cmd: 'command' } } });
  const wrapped = m.parseImport('{"toolOverrides":{"shell":{"description":"Run"}}}');
  assert.deepEqual(plain(wrapped.overrides), { shell: { description: 'Run' } }, 'a pasted project file imports');
  const list = m.parseImport('[{"name":"shell","description":"Run"}]');
  assert.deepEqual(plain(list.overrides), { shell: { description: 'Run' } }, 'a list of named entries imports');
  assert.match(m.parseImport('').error, /Paste/);
  assert.match(m.parseImport('{oops').error, /Not valid JSON/);
  assert.match(m.parseImport('{"a":{}}').error, /No usable/);
  assert.match(m.parseImport('42').error, /Expected an object/);
}
assert.deepEqual(plain(m.mergeOverrides({ a: { description: '1' }, b: { description: '2' } }, { a: { description: 'new' } })),
  { a: { description: 'new' }, b: { description: '2' } });
assert.deepEqual(plain(m.parseImport(m.exportText({ name: 'x', tools: { a: { description: '1' } } })).overrides), { a: { description: '1' } }, 'export re-imports to the same document');

const list = m.fieldList({ parameters: { properties: { cmd: { type: 'string', description: 'The command' }, n: { type: ['number', 'null'] } }, required: ['cmd'] } });
assert.deepEqual(plain(list), [
  { name: 'cmd', type: 'string', required: true, description: 'The command' },
  { name: 'n', type: 'number | null', required: false, description: '' }
]);
assert.deepEqual(plain(m.fieldList({ name: 'x' })), []);
assert.equal(m.isCustomized({ description: 'x' }), true);
assert.equal(!!m.isCustomized({ fields: {} }), false);
assert.deepEqual(plain(m.searchTools([{ name: 'read_file', description: 'Read a file' }, { name: 'shell', description: 'Run' }], 'file read')).map((t) => t.name), ['read_file']);

{
  const parts = plain(m.diffWords('Run a shell command now', 'Run one shell command'));
  assert.deepEqual(parts, [
    { op: 'same', text: 'Run ' }, { op: 'del', text: 'a' }, { op: 'ins', text: 'one' },
    { op: 'same', text: ' shell command' }, { op: 'del', text: ' now' }
  ]);
  assert.equal(parts.filter((p) => p.op !== 'ins').map((p) => p.text).join(''), 'Run a shell command now', 'same + del rebuilds the built-in');
  assert.equal(parts.filter((p) => p.op !== 'del').map((p) => p.text).join(''), 'Run one shell command', 'same + ins rebuilds the custom text');
  assert.deepEqual(plain(m.diffStats(parts)), { added: 1, removed: 2 });
  assert.deepEqual(plain(m.diffWords('same', 'same')), [{ op: 'same', text: 'same' }]);
  assert.deepEqual(plain(m.diffWords('', 'new text')), [{ op: 'ins', text: 'new text' }]);
}

{
  const tools = [{ name: 'shell', description: 'Run a command', parameters: { properties: { cmd: {}, cwd: {} } } }, { name: 'read', description: 'Read' }, { name: 'bare' }];
  assert.deepEqual(plain(m.changedTools({ shell: { description: 'a' } }, { shell: { description: 'a' } })), []);
  assert.deepEqual(plain(m.changedTools({ shell: { fields: { a: 'x', b: 'y' } } }, { shell: { fields: { b: 'y', a: 'x' } } })), [], 'field order does not count as a change');
  assert.deepEqual(plain(m.changedTools({ shell: { description: 'b' }, read: { description: 'r' } }, { shell: { description: 'a' }, gone: { description: 'g' } })), ['gone', 'read', 'shell']);
  assert.deepEqual(plain(m.renameProblems({ shell: { fields: { cmd: 'cwd' } } }, tools)), ['shell'], 'a clash blocks Save');
  assert.deepEqual(plain(m.renameProblems({ shell: { fields: { cmd: 'command' } } }, tools)), []);

  // sets
  assert.deepEqual(plain(m.normalizeWording({ active: 'gone', sets: { a: { name: ' A ', tools: { shell: { description: ' x ' } } }, b: 'junk', c: { tools: {} } } })),
    { active: '', sets: { a: { name: 'A', tools: { shell: { description: 'x' } } }, c: { name: 'c', tools: {} } } },
    'names are trimmed, a nameless set is named by its id, junk is dropped, an unknown active is Built-in');
  assert.deepEqual(plain(m.wordingFromResolved({ toolWording: { active: '', sets: {} }, toolOverrides: { shell: { description: 'Old' } } })),
    { wording: { active: 'custom', sets: { custom: { name: 'Custom', tools: { shell: { description: 'Old' } } } } }, legacy: true },
    'legacy flat wording becomes the active set "Custom"');
  assert.equal(m.wordingFromResolved({ toolWording: { active: 'a', sets: { a: { name: 'A', tools: {} } } }, toolOverrides: { shell: { description: 'Old' } } }).legacy, false,
    'once sets exist the flat map is ignored');
  assert.equal(m.newSetId('Terse & Short!', {}), 'terse-short');
  assert.equal(m.newSetId('Terse', { terse: {}, 'terse-2': {} }), 'terse-3');
  assert.equal(m.newSetId('***', {}), 'set');
  assert.equal(m.uniqueSetName('Terse', { a: { name: 'terse' } }), 'Terse (2)', 'names are unique, ignoring case');
  assert.equal(m.uniqueSetName('Terse', { a: { name: 'Terse' } }, 'a'), 'Terse', 'a set keeps its own name');
  assert.equal(m.uniqueSetName('  ', {}), 'Untitled');
  assert.deepEqual(plain(m.snapshotBuiltIn(tools)), { shell: { description: 'Run a command' }, read: { description: 'Read' } },
    'a copy of Built-in freezes every description');
  assert.deepEqual(plain(m.effectiveEntry(tools[0], undefined)), { description: 'Run a command', fields: {} });
  assert.deepEqual(plain(m.effectiveEntry(tools[0], { description: 'Go', fields: { cmd: 'c' } })), { description: 'Go', fields: { cmd: 'c' } });
  assert.equal(m.differsFromBuiltIn(tools[0], { description: 'Run a command ' }), false, 'a frozen copy that still matches does not differ');
  assert.equal(m.differsFromBuiltIn(tools[0], { description: 'Run a command' , fields: { cmd: 'command' } }), true);
  assert.equal(m.differsFromBuiltIn(tools[0], { description: 'Go' }), true);
  const saved = { active: 'a', sets: { a: { name: 'A', tools: { shell: { description: 'x' } } }, b: { name: 'B', tools: {} } } };
  assert.deepEqual(plain(m.wordingChanges(saved, saved)), { count: 0, active: false, sets: [] });
  const draft = { active: 'c', sets: { a: { name: 'A2', tools: { shell: { description: 'y' } } }, c: { name: 'C', tools: { read: { description: 'r' } } } } };
  assert.deepEqual(plain(m.wordingChanges(draft, saved)), {
    count: 4,
    active: true,
    sets: [
      { id: 'a', name: 'A2', kind: 'edited', tools: ['shell'], renamed: true },
      { id: 'b', name: 'B', kind: 'deleted', tools: [], renamed: false },
      { id: 'c', name: 'C', kind: 'new', tools: ['read'], renamed: false }
    ]
  });
}
{
  const set = m.parseImport(m.exportText({ name: 'Terse', tools: { shell: { description: 'Run' } } }));
  assert.equal(set.name, 'Terse', 'an exported set re-imports with its name');
  assert.deepEqual(plain(set.overrides), { shell: { description: 'Run' } });
  assert.equal(m.parseImport('{"shell":{"description":"Run"}}').name, '', 'a bare map has no name');
}

// ---- one selection, copies ------------------------------------------------
{
  const sets = { a: { name: 'A', tools: { shell: { description: 'a' } } }, b: { name: 'B', tools: {} }, c: { name: 'C', tools: {} } };
  assert.equal(m.initialSelection({ active: 'b', sets }), 'b', 'opens on the default set');
  assert.equal(m.initialSelection({ active: '', sets }), 'a', 'else the first set');
  assert.equal(m.initialSelection({ active: 'gone', sets: {} }), '', 'else Built-in');
  assert.equal(m.selectionAfterDelete(sets, 'a', 'c'), 'c', 'the default set survives a delete and is picked');
  assert.equal(m.selectionAfterDelete(sets, 'b', ''), 'c', 'else the next set');
  assert.equal(m.selectionAfterDelete(sets, 'c', ''), 'b', 'else the previous set');
  assert.equal(m.selectionAfterDelete({ a: sets.a }, 'a', ''), '', 'else Built-in');
  const builtIn = [{ name: 'shell', description: 'Run a command' }, { name: 'read', description: '' }];
  assert.deepEqual(plain(m.newSetTools('', builtIn, sets)), { shell: { description: 'Run a command' } }, 'a copy of Built-in freezes every description');
  assert.deepEqual(plain(m.newSetTools('empty', builtIn, sets)), {}, 'an empty set holds nothing');
  const copy = m.newSetTools('a', builtIn, sets);
  assert.deepEqual(plain(copy), { shell: { description: 'a' } }, 'a copy of a set holds its tools');
  copy.shell.description = 'changed';
  assert.equal(sets.a.tools.shell.description, 'a', 'and is independent of it');
}

// ---- wiring ---------------------------------------------------------------
assert.match(read('frontend/src/routes.js'), /exactOrQuery\('settings\/project\/tool-overrides'[\s\S]*?name: 'settingsProjectToolOverrides'/);
const app = read('frontend/src/components/App.jsx');
assert.match(app, /settingsProjectToolOverrides: \[ToolOverridesPageView/);
assert.match(app, /LAZY_ROUTE_NAMES[\s\S]*'settingsProjectToolOverrides'/);
const project = read('frontend/src/components/SettingsProject.jsx');
const tree = project.indexOf('h(ToolTree');
const link = project.indexOf("settingsLink('settings/project/tool-overrides'");
const fileOptions = project.indexOf("'aria-label': 'File tool options'");
assert.ok(tree > 0 && link > tree && link < fileOptions, 'the link sits below the tool tree, ahead of File tool options');
const page = read('frontend/src/components/ToolOverridesPage.jsx');
assert.match(page, /\/api\/tools\/list\?projectDir=/);
assert.match(page, /toolWording: payload/, 'Save writes the wording sets');
assert.match(page, /body\.unset = \['toolOverrides'\]/, 'a legacy project drops its flat map on save');
assert.doesNotMatch(page, /SAVE_DELAY_MS|scheduleSave/, 'no autosave: edits stay a draft until Save');
assert.match(page, /'Discard'[\s\S]*'Save'/, 'one Save bar for the whole draft');
assert.match(page, /'unsaved'/, 'changed rows are marked unsaved');
assert.match(page, /'\+ New set'/);
assert.match(page, /newSetTools\(newFrom, tools, sets\)/, 'Create set copies through newSetTools');
assert.match(page, /'Import as new set'/);
assert.match(page, /'Make default'/);
assert.match(page, /selectionAfterDelete\(/, 'deleting a set moves the selection by the shared rule');
assert.match(page, /initialSelection\(/, 'the page opens on the shared initial selection');
assert.match(page, /\[BUILTIN, 'builtin', 'Built-in'\], \[pickedSet, 'set', [\s\S]{0,80}\['', 'compare', 'Compare'\]/, 'three tabs: Built-in, the picked set, Compare');
assert.match(page, /openNew\(selected\) \}, set \? 'Duplicate' : 'Copy to new set'\)/, 'every card, Built-in included, can start a new set from it');

console.log('tool overrides ui: ok');
