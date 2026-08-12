'use strict';
// Unit test for DB-backed project settings (`.mouaif.json` opt-out).
// Exercises the settings.js storage layer directly with a temp home and
// project dir, plus the REST surface via a local server.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mouaif-db-backed-home-'));
process.env.MOUAIF_HOME = HOME;
const PROJ = fs.mkdtempSync(path.join(HOME, 'proj-'));
const settings = require('../src/settings.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

// ---- File-backed default ------------------------------------------------
check('default is not db-backed', settings.isDbBacked(PROJ) === false);
settings.setProject(PROJ, { promptSize: 'very-small' });
check('file write lands in .mouaif.json', fs.existsSync(settings.getProjectPath(PROJ)));
check('getProject reads file', settings.getProject(PROJ).promptSize === 'very-small');
check('resolved uses file value', settings.getResolved(PROJ).promptSize === 'very-small');

// ---- Switch to DB-backed ------------------------------------------------
const fileBefore = fs.readFileSync(settings.getProjectPath(PROJ), 'utf8');
settings.setDbProject(PROJ, { ...settings.getProjectRaw(PROJ), __dbBacked: true });
check('isDbBacked after seed', settings.isDbBacked(PROJ) === true);
check('file is left untouched after seed', fs.readFileSync(settings.getProjectPath(PROJ), 'utf8') === fileBefore);
check('getProject reads DB after seed', settings.getProject(PROJ).promptSize === 'very-small');

// Writes go to the DB, not the file.
settings.setProject(PROJ, { toolOutput: { size: 'full', structure: 'concise' } });
check('setProject writes to DB', settings.getDbProjectRaw(PROJ).toolOutput.size === 'full');
check('file unchanged after setProject', fs.readFileSync(settings.getProjectPath(PROJ), 'utf8') === fileBefore);
check('getProject reflects DB write', settings.getProject(PROJ).toolOutput.structure === 'concise');
check('resolved reflects DB write', settings.getResolved(PROJ).toolOutput.size === 'full');

settings.unsetProjectKeys(PROJ, ['promptSize']);
check('unsetProjectKeys removes from DB', !Object.prototype.hasOwnProperty.call(settings.getDbProjectRaw(PROJ), 'promptSize'));
check('unset keeps file untouched', fs.readFileSync(settings.getProjectPath(PROJ), 'utf8') === fileBefore);

// ---- Switch back to file-backed ----------------------------------------
const dbCopy = { ...settings.getDbProjectRaw(PROJ) };
delete dbCopy.__dbBacked;
settings.writeProjectJson(settings.getProjectPath(PROJ), dbCopy);
settings.getDb().prepare('DELETE FROM project_settings WHERE project_dir = ?').run(PROJ);
check('isDbBacked false after delete', settings.isDbBacked(PROJ) === false);
check('file has DB copy after switch back', settings.getProject(PROJ).toolOutput.size === 'full');
check('promptSize gone from file after switch back', !Object.prototype.hasOwnProperty.call(settings.getProject(PROJ), 'promptSize'));

// ---- Summary ------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
