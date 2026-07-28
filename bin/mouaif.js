#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { program } = require('commander');
const { createServer, destroyOpenSockets, DEFAULT_PORT } = require('../src/index.js');
const accessAuth = require('../src/access-auth.js');
const qr = require('../src/qr.js');

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

function displayOrigin(options, port) {
  if (options.publicOrigin) return options.publicOrigin;
  const host = String(options.host || '127.0.0.1');
  if (host !== '0.0.0.0' && host !== '::') return `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry && entry.family === 'IPv4' && !entry.internal) return `http://${entry.address}:${port}`;
    }
  }
  return `http://127.0.0.1:${port}`;
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
  const publicOrigin = String(options.publicOrigin || process.env.MOUAIF_PUBLIC_ORIGIN || '');
  const binPath = path.join(__dirname, 'mouaif.js');
  const watchRoots = [path.join(__dirname), path.join(__dirname, '..', 'src')];
  const watched = new Set();
  let child = null;
  let stopping = false;
  let pendingRestart = false;
  let debounce = null;

  function startChild() {
    const args = [binPath, 'serve', '--port', port, '--host', host];
    if (publicOrigin) args.push('--public-origin', publicOrigin);
    if (options.user) args.push('--user', options.user);
    if (options.authSetup) args.push('--auth-setup');
    child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, [WATCH_CHILD_ENV]: '1', ...(options.password ? { MOUAIF_PASSWORD: options.password } : {}) }
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
  .option('--public-origin <origin>', 'Public HTTP(S) origin when served through a proxy', process.env.MOUAIF_PUBLIC_ORIGIN)
  .option('--user <user>', 'Set the app access user before serving')
  .option('--password <password>', 'Set the app access password before serving (prefer MOUAIF_PASSWORD to avoid shell history)')
  .option('--auth-setup', 'Print a one-time setup link, QR code, and short code')
  .option('-w, --watch', 'Restart the server when local source files change')
  .action((options) => {
    if (options.watch && process.env[WATCH_CHILD_ENV] !== '1') {
      return runWatchSupervisor(options);
    }

    const port = parseInt(options.port, 10);
    const suppliedPassword = options.password || process.env.MOUAIF_PASSWORD || '';
    if ((options.user && !suppliedPassword) || (!options.user && suppliedPassword)) {
      console.error('❌ --user and --password (or MOUAIF_PASSWORD) must be supplied together');
      process.exitCode = 1;
      return;
    }
    if (options.user) {
      try {
        accessAuth.setPassword(options.user, suppliedPassword);
        console.log(`🔐 App access user set to ${accessAuth.user().username}`);
      } catch (error) {
        console.error('❌ Could not set app access:', error.message);
        process.exitCode = 1;
        return;
      }
    }
    let server;
    const lifecycle = {
      restarting: false,
      restart: async () => {
        await closeServer(server);
        start();
      }
    };

    function start() {
      server = createServer(port, { lifecycle, publicOrigin: options.publicOrigin });
      server.listen(port, options.host, () => {
        const servedOrigin = displayOrigin(options, port);
        console.log(`🚀 mouaif server running at ${servedOrigin}`);
        console.log(`   Web:    /             — mobile UI`);
        console.log(`   Web:    /web/         — mobile UI`);
        console.log(`   REST:   GET  /data    — get data`);
        console.log(`   REST:   POST /data    — update data`);
        console.log(`   SSE:    GET  /events  — subscribe to events`);
        console.log(`   CDP:    /api/inspector/  + WS /api/inspector/proxy`);
        if (options.authSetup || !accessAuth.configured()) {
          const setup = accessAuth.createSetupCode();
          const setupUrl = servedOrigin + '/web/#/setup?code=' + encodeURIComponent(setup.code);
          console.log('');
          console.log('🔐 Set up app access (expires in 15 minutes)');
          console.log(`   Link:   ${setupUrl}`);
          console.log(`   Code:   ${setup.code}`);
          try { console.log('\n' + qr.terminal(setupUrl)); } catch (_) { /* narrow terminals can use the link */ }
          console.log('   The setup page can create a password and register a passkey.');
        }
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