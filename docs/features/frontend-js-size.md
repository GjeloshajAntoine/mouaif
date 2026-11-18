# Measuring frontend JavaScript size

## Overview

Measure the raw, minified production JavaScript before and after a frontend change. Compare startup JavaScript as well as the entry file: moving code into a statically imported chunk does not reduce the startup total.

## Usage

From the repository root, run this command on both revisions with the same toolchain:

```sh
nice -n 19 node scripts/measure-web-js.mjs
```

## What the numbers include

The script uses the normal Vite production config without writing `frontend/dist`. It counts UTF-8 bytes and follows static imports transitively, counting shared chunks once. The all-chunks total also includes dynamically imported chunks. The figures do not include HTML, CSS, compression, or HTTP overhead.
