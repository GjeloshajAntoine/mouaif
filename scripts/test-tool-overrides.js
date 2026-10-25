'use strict';

// Tool wording overrides (docs/features/tool-overrides.md): normalization,
// applying them to advertised specs without mutating the shared SPEC
// constants, and mapping a call's arguments back to the original field names.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-tool-overrides-'));
process.env.MOUAIF_HOME = home;
const settings = require('../src/settings.js');
const overrides = require('../src/toolOverrides.js');

const spec = () => ({
  type: 'function',
  function: {
    name: 'shell',
    description: 'Run a command.',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string' }, timeoutMs: { type: 'number' }, cwd: { type: 'string' } },
      required: ['cmd']
    }
  }
});

// ---- normalize -----------------------------------------------------------
assert.deepEqual(overrides.normalize(null), {});
assert.deepEqual(overrides.normalize([]), {});
assert.deepEqual(overrides.normalize({ shell: 'nope', other: { description: '   ' } }), {}, 'unusable entries are dropped');
assert.deepEqual(
  overrides.normalize({ shell: { description: '  Run it  ', fields: { cmd: 'command', cwd: 'bad name', timeoutMs: 'timeoutMs' } } }),
  { shell: { description: 'Run it', fields: { cmd: 'command' } } },
  'invalid and identity renames are dropped'
);
assert.deepEqual(
  overrides.normalize({ shell: { fields: { cmd: 'x', cwd: 'x' } } }),
  { shell: { fields: { cmd: 'x' } } },
  'two fields cannot share a new name'
);
assert.deepEqual(
  overrides.normalize({ shell: { fields: { cmd: 'cwd', cwd: 'dir' } } }),
  { shell: { fields: { cwd: 'dir' } } },
  'a rename onto another renamed field is dropped'
);
assert.equal(overrides.normalize({ t: { description: 'x'.repeat(5000) } }).t.description.length, overrides.MAX_DESCRIPTION_CHARS);

// ---- prune ---------------------------------------------------------------
{
  const specs = [spec()];
  const pruned = overrides.prune(specs, {
    shell: { description: 'D', fields: { cmd: 'command', ghost: 'g', cwd: 'timeoutMs' } },
    missing: { description: 'never advertised' }
  });
  assert.deepEqual(pruned, { shell: { description: 'D', fields: { cmd: 'command' } } },
    'a tool that is not advertised, an unknown field and a rename onto an existing field are dropped');
}

// ---- apply (copy, never mutate) ------------------------------------------
{
  const original = spec();
  const [out] = overrides.applyToSpecs([original], { shell: { description: 'Execute', fields: { cmd: 'command' } } });
  assert.equal(out.function.description, 'Execute');
  assert.deepEqual(Object.keys(out.function.parameters.properties), ['command', 'timeoutMs', 'cwd'], 'schema order is kept');
  assert.deepEqual(out.function.parameters.required, ['command']);
  assert.equal(original.function.description, 'Run a command.', 'the shared spec is not mutated');
  assert.ok('cmd' in original.function.parameters.properties);
  assert.deepEqual(original.function.parameters.required, ['cmd']);
  const untouched = spec();
  assert.equal(overrides.applyToSpecs([untouched], {})[0], untouched);
  assert.equal(overrides.applyToSpecs([untouched], { other: { description: 'x' } })[0], untouched, 'unrelated tools pass by reference');
}

// ---- restore -------------------------------------------------------------
{
  const set = { shell: { fields: { cmd: 'command', cwd: 'dir' } } };
  assert.deepEqual(overrides.restoreArgs('shell', { command: 'ls', dir: '/x', extra: 1 }, set), { cmd: 'ls', cwd: '/x', extra: 1 });
  const same = { cmd: 'ls' };
  assert.equal(overrides.restoreArgs('other', same, set), same);
  assert.equal(overrides.restoreArgs('shell', same, {}), same);
  assert.deepEqual(overrides.restoreArgs('shell', { __raw: '{bad' }, set), { __raw: '{bad' });
}

// ---- round trip on the real specs ------------------------------------------
{
  const files = require('../src/tools/files.js');
  const specs = files.FILE_TOOL_NAMES.map((name) => files.SPECS[name]);
  const target = specs.find((s) => s.function.parameters && Object.keys(s.function.parameters.properties || {}).length);
  const [field] = Object.keys(target.function.parameters.properties);
  const set = overrides.prune(specs, overrides.normalize({ [target.function.name]: { description: 'Custom', fields: { [field]: 'renamed_field' } } }));
  const advertised = overrides.applyToSpecs(specs, set);
  const seen = advertised.find((s) => s.function.name === target.function.name);
  assert.ok('renamed_field' in seen.function.parameters.properties);
  assert.deepEqual(overrides.restoreArgs(target.function.name, { renamed_field: 'v' }, set), { [field]: 'v' });
}

// ---- stored in the project settings ---------------------------------------
{
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(projectDir);
  assert.deepEqual(overrides.overridesFor(projectDir), {}, 'no override by default');
  assert.deepEqual(overrides.overridesFor(''), {});
  settings.setProject(projectDir, { toolOverrides: { shell: { description: 'Execute', fields: { cmd: 'command', bad: 1 } }, junk: 4 } });
  assert.deepEqual(overrides.overridesFor(projectDir), { shell: { description: 'Execute', fields: { cmd: 'command' } } },
    'legacy flat wording applies while there are no sets');
  const sets = {
    terse: { name: 'Terse', tools: { shell: { description: 'Run.' } } },
    verbose: { name: 'Verbose', tools: { shell: { description: 'Run a command in the project.', fields: { cmd: 'command_line' } } } }
  };
  settings.setProject(projectDir, { toolWording: { active: 'terse', sets } });
  assert.deepEqual(overrides.overridesFor(projectDir), { shell: { description: 'Run.' } }, 'the active set wins over legacy wording');
  settings.setProject(projectDir, { toolWording: { active: 'verbose', sets } });
  assert.deepEqual(overrides.overridesFor(projectDir), { shell: { description: 'Run a command in the project.', fields: { cmd: 'command_line' } } });
  settings.setProject(projectDir, { toolWording: { active: '', sets } });
  assert.deepEqual(overrides.overridesFor(projectDir), {}, 'Built-in active: nothing is re-worded, legacy included');
  settings.setProject(projectDir, { toolWording: { active: 'gone', sets } });
  assert.deepEqual(overrides.overridesFor(projectDir), {}, 'an active id with no set falls back to Built-in');
  settings.setProject(projectDir, { toolWording: { active: 'terse', sets: { terse: { name: 'Terse', tools: 'junk' } } } });
  assert.deepEqual(overrides.overridesFor(projectDir), {});
  assert.deepEqual(overrides.activeOverrides({ toolWording: { active: '', sets: {} }, toolOverrides: { a: { description: 'x' } } }), { a: { description: 'x' } },
    'empty sets still read the legacy map');
}

// ---- wiring ---------------------------------------------------------------
{
  const stream = fs.readFileSync(require.resolve('../src/ai-stream.js'), 'utf8');
  assert.match(stream, /toolOverridesMod\.prune\(toolSpecs, toolOverridesMod\.overridesFor\(opts\.projectDir\)\)/);
  assert.match(stream, /restoreArgs\(c\.name, args, cx\.toolOverrides\)/);
  assert.match(stream, /!opts\.singleToolCall/, 'a direct composer call already speaks original names');
  assert.match(fs.readFileSync(require.resolve('../src/settings.js'), 'utf8'), /toolOverrides: \{\}/);
  assert.match(fs.readFileSync(require.resolve('../src/settings.js'), 'utf8'), /toolWording: \{ active: '', sets: \{\} \}/);
}

fs.rmSync(home, { recursive: true, force: true });
console.log('tool overrides: ok');
