'use strict';

// Server entry point — thin facade.
//
// The HTTP server implementation lives in src/http-server.js; this
// module exists so the public `require('../src/index.js')` surface
// (used by bin/mouaif.js and the test scripts) stays stable:
//
//   const { createServer, destroyOpenSockets, DEFAULT_PORT } = require('../src/index.js');
//
// The original single-file src/index.js was split into focused
// sub-modules (see src/http-server.js header comment) so no file in
// the repo stays above ~1 000 lines.

module.exports = require('./http-server.js');
