'use strict';

// Project-scope document store kept in the project's working tree:
// `<projectDir>/.mouaif.json`, or `<projectDir>/.mouaif/.mouaif.json` for
// projects using the folder layout.
//
// Two on-disk layouts for the same file name:
//   - root:   <projectDir>/.mouaif.json          (the default, simple projects)
//   - folder: <projectDir>/.mouaif/.mouaif.json  (complex projects that keep
//             every mouaif file — config, traces — under one `.mouaif/` dir)
// The layout is discovered, not stored: when the folder file exists it is the
// project's settings file, otherwise the root file is. So a project switches
// layout by moving the file, and nothing else has to know which one it uses.

const fs = require('fs');
const path = require('path');
const { parseProjectJson, writeProjectJson } = require('./json-file.js');
const cache = require('./cache.js');

const PROJECT_FILE = '.mouaif.json';
// Optional per-project folder holding the config file for complex projects:
// <projectDir>/.mouaif/.mouaif.json. See getProjectPath().
const PROJECT_DIR = '.mouaif';

function getProjectRootPath(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  return path.join(projectDir, PROJECT_FILE);
}

function getProjectFolderPath(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new TypeError('projectDir must be a non-empty string');
  }
  return path.join(projectDir, PROJECT_DIR, PROJECT_FILE);
}

// 'folder' when <projectDir>/.mouaif/.mouaif.json is a file, else 'root'.
// Called on every project read: `throwIfNoEntry: false` avoids building an
// exception for the usual case, a project with no folder file.
function getProjectLayout(projectDir) {
  const st = fs.statSync(getProjectFolderPath(projectDir), { throwIfNoEntry: false });
  return st && st.isFile() ? 'folder' : 'root';
}

function getProjectPath(projectDir) {
  return getProjectLayout(projectDir) === 'folder'
    ? getProjectFolderPath(projectDir)
    : getProjectRootPath(projectDir);
}

// A JSON document at a fixed path. `locate()` is called on every operation so
// a layout change on disk (the file moved into `.mouaif/`) is followed. Reads
// are cached on the file's stamp (see cache.js), so a hand edit is seen on the
// next read.
function createJsonFileStore(kind, locate) {
  return {
    kind,
    scope: 'project',
    get location() { return locate(); },
    // A corrupt file is a user error: it surfaces as
    // MOUAIF_PROJECT_PARSE_ERROR; a missing file resolves to {}.
    read: () => {
      const filePath = locate();
      return cache.readFile(filePath, (text) => parseProjectJson(filePath, text), () => ({}));
    },
    write: (next) => {
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        throw new TypeError('a project document must be an object');
      }
      const filePath = locate();
      const text = writeProjectJson(filePath, next);
      cache.wroteFile(filePath, next, text);
      return next;
    },
    version: () => cache.fileStamp(locate()) || 'missing'
  };
}

function createProjectFileStore(projectDir) {
  return createJsonFileStore('project-file', () => getProjectPath(projectDir));
}

module.exports = {
  PROJECT_FILE,
  PROJECT_DIR,
  getProjectRootPath,
  getProjectFolderPath,
  getProjectLayout,
  getProjectPath,
  createJsonFileStore,
  createProjectFileStore
};
