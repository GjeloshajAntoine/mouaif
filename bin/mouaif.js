#!/usr/bin/env node

const { program } = require('commander');
const { createServer, DEFAULT_PORT } = require('../src/index.js');

const { name, version, description } = require('../package.json');

program
  .name(name)
  .version(version)
  .description(description);

program
  .command('serve')
  .description('Start the HTTP server')
  .option('-p, --port <port>', 'Port to listen on', DEFAULT_PORT)
  .option('-h, --host <host>', 'Host to bind to', '127.0.0.1')
  .action((options) => {
    const port = parseInt(options.port, 10);
    const server = createServer(port);

    server.listen(port, options.host, () => {
      console.log(`🚀 mouaif server running at http://${options.host}:${port}`);
      console.log(`   REST:   GET  /         — info`);
      console.log(`   REST:   GET  /data     — get data`);
      console.log(`   REST:   POST /data     — update data`);
      console.log(`   SSE:    GET  /events   — subscribe to events`);
      console.log(`   Web:    /web/          — mobile UI`);
      console.log(`   CDP:    /api/inspector/  + WS /api/inspector/proxy`);
      console.log('   Press Ctrl+C to stop');
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n⏹  Shutting down...');
      server.close(() => process.exit(0));
    });
  });

program
  .command('info')
  .description('Show server info')
  .action(() => {
    console.log(`📦 mouaif v${version}`);
    console.log(`   ${description}`);
    console.log(`   Default port: ${DEFAULT_PORT}`);
  });

program.parse(process.argv);