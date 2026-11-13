// mouaif web — pure helpers for the projects page and shared projects
// (docs/features/share-project.md). No DOM, no signals, so they can be
// unit-tested in node (scripts/test-share-project-count.js).

// sharedProjectCards(share) — one card per active project added from another
// mouaif, shaped like this mouaif's own project rows plus `shared`.
export function sharedProjectCards(share) {
  return ((share && share.incoming) || []).filter((s) => s && s.status === 'active').map((s) => ({
    id: 'share-' + s.id,
    name: s.projectName || String(s.projectDir || '').split(/[\\/]/).filter(Boolean).pop() || s.projectDir,
    path: s.projectDir,
    shared: s
  }));
}

// projectCards(projects, share) — every card the projects page lists: this
// mouaif's projects first (in their stored order), then the shared ones.
export function projectCards(projects, share) {
  return (Array.isArray(projects) ? projects : []).concat(sharedProjectCards(share));
}

// projectCountText(cards) — the page bar's count, taken from the same list
// the page renders so the number always agrees with the cards on screen.
export function projectCountText(cards) {
  const n = Array.isArray(cards) ? cards.length : 0;
  return n + (n === 1 ? ' project' : ' projects');
}
