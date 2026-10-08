'use strict';

// Client row ids for the race probe's message appends.
//
// Mirrors src/messages.js newClientId() — an opaque, URL/selector-safe id
// with a role prefix. The test container has no mouaif install, so the shape
// is duplicated here rather than imported; keep it in sync with
// CLIENT_ID_RE in src/messages.js (`[A-Za-z0-9_-]+`, bounded length).

const crypto = require('node:crypto');

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newClientId(prefix) {
  return (prefix || 's') + '_' + crypto.randomBytes(9).toString('base64url');
}

module.exports = { newClientId, CLIENT_ID_RE };