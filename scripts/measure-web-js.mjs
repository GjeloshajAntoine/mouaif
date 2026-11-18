// Measure raw emitted JS without writing to the shipped frontend/dist.
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

await build({
  configFile: fileURLToPath(new URL('../frontend/vite.config.js', import.meta.url)),
  logLevel: 'error',
  build: { write: false, reportCompressedSize: false },
  plugins: [{
    name: 'measure-web-js',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
      const startup = new Set();
      function visit(name) {
        const chunk = bundle[name];
        if (chunk?.type !== 'chunk' || startup.has(chunk)) return;
        startup.add(chunk);
        chunk.imports.forEach(visit);
      }
      const entries = chunks.filter((chunk) => chunk.isEntry);
      entries.forEach((entry) => visit(entry.fileName));
      const totalBytes = (items) => [...items].reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0);
      for (const entry of entries) console.log(`${entry.fileName}: ${totalBytes([entry])} bytes`);
      console.log(`Startup JS (entries + static imports): ${totalBytes(startup)} bytes`);
      console.log(`All JS chunks: ${totalBytes(chunks)} bytes`);
    } },
  }],
});
