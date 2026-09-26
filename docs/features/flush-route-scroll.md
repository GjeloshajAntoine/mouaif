# Flush-route scrolling — settings sub-pages scroll to the bottom

## Overview

Every settings sub-page on a phone scrolls its whole content, so a long list of
chat defaults, providers, or projects can always be read to the end.

## Usage

Open **Settings** on a phone and drill into any sub-page — the bottom tab bar is
replaced by a back link, and the page content owns the full viewport height and
scrolls:

1. Open **Settings → App defaults**. The page scrolls from *Default prompt
   style* down to *Status line under the composer*, including the trailing
   storage hint.
2. Open **Settings → Projects**. A long list of registered projects scrolls, and
   the **+** action bar stays reachable.
3. Open **Settings → Providers** and **Settings → File tags** — same behaviour.

Every one of these pages keeps its header row (**← App defaults**) fixed at the
top and scrolls the content beneath it.

## Related

- [iOS touch scroll](./ios-touch-scroll.md) — why the scroll container has to be
  a single element rather than nested layers.
- [Settings](./settings-ui.md) — the pages this behaviour applies to.
