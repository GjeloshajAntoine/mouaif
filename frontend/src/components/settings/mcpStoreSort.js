// mouaif web — MCP store search and sort rules (pure, no DOM).
//
// The official MCP Registry API (v0.1, the current version) has no sort
// parameter: it always pages servers alphabetically by id, and it rejects a
// search shorter than 3 characters with HTTP 422. So the store sorts in the
// browser, over what it has loaded, and never sends a short search.
// Kept free of Preact so scripts/test-mcp-store-sort.mjs runs it in Node.
// See docs/features/mcp-registry-browser.md.
import { friendlyName, registryMeta, weeklyDownloads } from './mcpRegistryInstall.js';

export const MIN_SEARCH = 3;

// searchTerm(raw) -> the search to send, or '' for "no search". The Registry
// counts characters after trimming, so 1–2 typed characters mean no search
// yet rather than an error.
export function searchTerm(raw) {
  const t = String(raw || '').trim();
  return Array.from(t).length >= MIN_SEARCH ? t : '';
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// sortKeys(entry, info) -> the values every comparison reads, computed once
// per entry instead of once per comparison (summary() parses every install
// option, and a sort runs it n·log n times otherwise).
export function sortKeys(entry, info) {
  const d = weeklyDownloads(entry);
  return {
    name: friendlyName(entry),
    updated: Date.parse(registryMeta(entry).updatedAt) || 0,
    weekly: d ? d.weekly : -1,
    supported: info && info.supported ? 1 : 0
  };
}

// compareKeys(sort) -> comparator over sortKeys objects.
//   popularity: most weekly downloads first; servers without a count (hosted
//               ones publish none) after, installable first, then newest.
//   updatedAt:  most recently updated first.
//   name:       display name, A–Z.
export function compareKeys(sort) {
  if (sort === 'name') return (a, b) => collator.compare(a.name, b.name);
  if (sort === 'updatedAt') return (a, b) => b.updated - a.updated;
  return (a, b) => (b.weekly - a.weekly) || (b.supported - a.supported) || (b.updated - a.updated);
}

// blockOf(index, blockStarts) -> which loaded block an entry belongs to.
// blockStarts lists the index where each "Load more" page began; [0] means
// everything loaded is ranked as one list.
export function blockOf(index, blockStarts) {
  let b = 0;
  for (let i = 1; i < blockStarts.length; i++) if (index >= blockStarts[i]) b = i;
  return b;
}

// orderRows(rows, sort, blockStarts) -> rows sorted within their block,
// blocks kept in load order. Each row needs { index, keys }. A page loaded
// with "Load more" therefore lands below what is on screen instead of being
// shuffled in above the reader's scroll position.
export function orderRows(rows, sort, blockStarts) {
  const starts = Array.isArray(blockStarts) && blockStarts.length ? blockStarts : [0];
  const cmp = compareKeys(sort);
  return rows
    .map((row) => ({ row, block: blockOf(row.index, starts) }))
    .sort((a, b) => (a.block - b.block) || cmp(a.row.keys, b.row.keys) || (a.row.index - b.row.index))
    .map((x) => x.row);
}
