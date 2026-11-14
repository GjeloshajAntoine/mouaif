'use strict';

// JSON file I/O shared by the project-file stores and by src/chats.js /
// src/messages.js (through settings.readProjectJson / writeProjectJson).
//
// Single source of truth for the on-disk project-file contract (see
// docs/features/app-and-project-settings.md): 2-space indented JSON, trailing
// LF, missing file treated as {}, corrupt file surfaced as a
// MOUAIF_PROJECT_PARSE_ERROR, and every write atomic.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJsonFile(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 2-space indent so the file is hand-editable and diff-friendly.
  const body = JSON.stringify(obj, null, 2) + '\n';
  // Stage next to the target, fsync, then rename over it. A bare
  // writeFileSync that dies mid-write (crash, full disk, killed process)
  // leaves a truncated `.mouaif.json` behind, and a truncated project file is
  // not a small failure: readProjectJson() reports
  // MOUAIF_PROJECT_PARSE_ERROR, so settings AND every chat route for that
  // project answer 422 until the user repairs the file by hand. rename(2) is
  // atomic within a directory, so a reader sees either the old file or the
  // complete new one. The staging name is unique per write so two processes
  // cannot clobber each other's, and it is removed on failure.
  const tmpPath = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    throw e;
  }
}

// Read and JSON-parse an arbitrary project-relative JSON file. Missing
// file returns `fallback` (default {}). A corrupt file throws with
// code 'MOUAIF_PROJECT_PARSE_ERROR' so the HTTP layer can map it to 422.
function readProjectJson(filePath, fallback) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('filePath must be a non-empty string');
  }
  if (!fs.existsSync(filePath)) return fallback === undefined ? {} : fallback;
  try { return readJsonFile(filePath); }
  catch (e) {
    const err = new Error('Failed to parse ' + filePath + ': ' + e.message);
    err.code = 'MOUAIF_PROJECT_PARSE_ERROR';
    err.cause = e;
    throw err;
  }
}

// Write an object to a project-relative JSON file in the canonical
// format (2-space indent, trailing LF), creating parent dirs as needed.
function writeProjectJson(filePath, obj) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('filePath must be a non-empty string');
  }
  writeJsonFile(filePath, obj);
}

module.exports = { readJsonFile, writeJsonFile, readProjectJson, writeProjectJson };
