# Measuring frontend JavaScript size

## Overview

Measure the raw, minified production JavaScript before and after a frontend change. Compare startup JavaScript as well as the entry file: moving code into a statically imported chunk does not reduce the startup total.

## Usage

From the repository root, run this command on both revisions with the same toolchain:

```sh
nice -n 19 node scripts/measure-web-js.mjs
```

## Startup chunk layout

`frontend/vite.config.js` splits two vendor areas out of the entry with named
`manualChunks`: `mcp-sdk` (the official MCP app bridge and its client/core
dependencies) and `zod` (the schemas that bridge validates with). Both stay
static imports, so Vite preloads them from `index.html` with
`<link rel="modulepreload">` and startup behaviour is unchanged — this is not
lazy loading, and the startup total is the same. What changes is the file the
browser re-downloads after a UI edit:

```text
before: assets/index-*.js 833 487 B
after:  assets/index-*.js 620 991 B + mcp-sdk 133 804 B + zod 77 791 B
```

Those two vendor chunks only change when the pinned SDK does, so they stay
cached across UI builds.

## What the numbers include

The script uses the normal Vite production config without writing `frontend/dist`. It counts UTF-8 bytes and follows static imports transitively, counting shared chunks once. The all-chunks total also includes dynamically imported chunks. The figures do not include HTML, CSS, compression, or HTTP overhead.
