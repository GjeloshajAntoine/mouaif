#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { program } = require('commander');
const { createServer, destroyOpenSockets, DEFAULT_PORT } = require('../src/index.js');

const { name, version, description } = require('../package.json');

const WATCH_CHILD_ENV = 'MOUAIF_WATCH_CHILD';
const WATCH_EXTS = new Set(['.js', '.jsx', '.json', '.css', '.html']);

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    // Force-close keep-alive / SSE sockets so server.close() can resolve
    // promptly instead of hanging on connections that never end.
    server.close(() => {
      destroyOpenSockets();
      resolve();
    });
    // Destroy immediately for sockets that are idle but still counted;
    // server.close() only fires once all connections are gone.
    destroyOpenSockets();
  });
}

function collectWatchFiles(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectWatchFiles(full, out);
    else if (WATCH_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function runWatchSupervisor(options) {
  const port = String(parseInt(options.port, 10));
  const host = String(options.host || '127.0.0.1');
  const binPath = path.join(__dirname, 'mouaif.js');
  const watchRoots = [path.join(__dirname), path.join(__dirname, '..', 'src')];
  const watched = new Set();
  let child = null;
  let stopping = false;
  let pendingRestart = false;
  let debounce = null;

  function startChild() {
    child = spawn(process.execPath, [binPath, 'serve', '--port', port, '--host', host], {
      stdio: 'inherit',
      env: { ...process.env, [WATCH_CHILD_ENV]: '1' }
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      if (pendingRestart || code === 0) {
        pendingRestart = false;
        startChild();
        return;
      }
      console.error(`[mouaif] server stopped (${signal || code}); waiting for changes...`);
    });
  }

  function restartChild(file) {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log(`[mouaif] change detected: ${path.relative(process.cwd(), file)}; restarting...`);
      pendingRestart = true;
      if (child) child.kill('SIGTERM');
      else startChild();
    }, 100);
  }

  function refreshWatchFiles() {
    for (const root of watchRoots) {
      for (const file of collectWatchFiles(root)) {
        if (watched.has(file)) continue;
        watched.add(file);
        fs.watchFile(file, { interval: 500 }, (cur, prev) => {
          if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) restartChild(file);
        });
      }
    }
  }

  function stop() {
    stopping = true;
    for (const file of watched) fs.unwatchFile(file);
    if (child) child.kill('SIGTERM');
  }

  console.log('[mouaif] watch mode enabled');
  refreshWatchFiles();
  setInterval(refreshWatchFiles, 2000);
  startChild();
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
}

program
  .name(name)
  .version(version)
  .description(description);

program
  .command('serve')
  .description('Start the HTTP server')
  .option('-p, --port <port>', 'Port to listen on', DEFAULT_PORT)
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('-w, --watch', 'Restart the server when local source files change')
  .action((options) => {
    if (options.watch && process.env[WATCH_CHILD_ENV] !== '1') {
      return runWatchSupervisor(options);
    }

    const port = parseInt(options.port, 10);
    let server;
    const lifecycle = {
      restarting: false,
      restart: async () => {
        await closeServer(server);
        start();
      }
    };

    function start() {
      server = createServer(port, { lifecycle });
      server.listen(port, options.host, () => {
        console.log(`🚀 mouaif server running at http://${options.host}:${port}`);
        console.log(`   Web:    /             — mobile UI`);
        console.log(`   Web:    /web/         — mobile UI`);
        console.log(`   REST:   GET  /data    — get data`);
        console.log(`   REST:   POST /data    — update data`);
        console.log(`   SSE:    GET  /events  — subscribe to events`);
        console.log(`   CDP:    /api/inspector/  + WS /api/inspector/proxy`);
        console.log('   Press Ctrl+C to stop');
      });
    }

    start();

    // Graceful shutdown
    function shutdown() {
      console.log('\n⏹  Shutting down...');
      closeServer(server).then(() => process.exit(0));
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('info')
  .description('Show server info')
  .action(() => {
    console.log(`📦 mouaif v${version}`);
    console.log(`   ${description}`);
    console.log(`   Default port: ${DEFAULT_PORT}`);
  });

program
  .command('import-chats')
  .description('Import chat transcripts from JSON files into the SQLite store')
  .argument('<projectDir>', 'Absolute path to the project directory')
  .option('--skip-existing', 'Skip chats already imported (only import missing messages)')
  .action((projectDir, options) => {
    const abs = path.resolve(projectDir);
    if (!fs.existsSync(abs)) {
      console.error('❌ Project directory does not exist:', abs);
      process.exit(1);
    }
    const chatdb = require('../src/chatdb.js');
    console.log(`📦 Importing chats from ${abs}...`);
    const result = chatdb.importFromJson(abs, { skipExisting: !!options.skipExisting });
    console.log(`   ✅ ${result.chats} chats, ${result.messages} messages imported`);
    if (result.errors.length) {
      for (const e of result.errors) console.error('   ⚠️  ' + e);
    }
    if (result.chats === 0 && result.messages === 0) {
      console.log('   Nothing to import.');
    }
  });

program.parse(process.argv);