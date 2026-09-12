// mouaif web — File/git toolbar button (inline inside composer pill)
//
// Sits as the first element inside .chat-view__composer: a round button
// with a stacked ▲▼ icon. Opens a dropdown menu with three actions:
// the file editor, the git changes modal, and the CLI command prompt.
// The menu is positioned above the composer; the git and CLI modals are
// full-screen overlays.
//
// The icon is built from inline SVGs, not text glyphs: ▲ (U+25B2) and
// ▼ (U+25BC) render as color emoji on some mobile fonts, and a single
// 14px two-triangle SVG is too small to read as two icons. An up-chevron
// above the folder and a down-chevron below it, each a separate SVG with
// a 2px gap, shows all icons clearly on every device.

import { h } from 'preact';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { formatCount } from './gitCount.js';
import { orbCountFont } from './fileOrb.js';
// The folder silhouette, as one path. Orb mode draws it twice — the same
// shape offset down as the extruded side, then the light top face — so both
// copies come from this constant rather than two hand-kept strings.
const FOLDER_PATH = 'M2 3.5a2 2 0 0 1 2-2h4.2l1.9 1.9H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9Z';
// Pictogram geometry, in CSS px. These are the numbers the reference is
// proportioned to, and `frontend/src/chat-composer.css` repeats them —
// changing one without the other detaches the paint from the boxes it
// paints, so `scripts/test-file-orb.mjs` asserts the two agree.
//
// The sizes are *ratios of the painted sphere*, which is 40px (a 44px tap
// target with the flat trigger's 2px inset):
//
//   chevron  11 x 6   = 28% of the diameter   (reference: ~21%)
//   folder   20 x 17  = 50% of the diameter   (reference: ~36%)
//   stack    31 tall  = 78% of the diameter   (reference: ~71%)
//
// The first pass drew 14x7 chevrons over a 28x22 folder — a 38px stack in a
// 40px circle. The pictogram then ran to the sphere's rim on every side and
// the ball stopped reading as a ball: there was no glass left around the
// artwork, which is what the reference is mostly made of.
const ORB_CHEVRON_W = 11;
const ORB_CHEVRON_H = 6;
const ORB_FOLDER_W = 20;
const ORB_FOLDER_H = 17;

function parseNumstat(stdout) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(stdout || '').split('\n')) {
    const fields = line.split('\t');
    if (/^\d+$/.test(fields[0])) additions += Number(fields[0]);
    if (/^\d+$/.test(fields[1])) deletions += Number(fields[1]);
  }
  return { additions, deletions };
}

async function fetchGitStats(projectDir) {
  if (!projectDir) return null;
  const request = (args) => fetchJson('/api/git', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, action: 'diff', args })
  });
  const [staged, unstaged] = await Promise.all([
    request('--numstat --cached'),
    request('--numstat')
  ]);
  const responses = [staged, unstaged].filter((result) => result.status === 200 && result.body && result.body.ok);
  if (!responses.length) return null;
  return responses.reduce((total, result) => {
    const parsed = parseNumstat(result.body.stdout);
    return {
      additions: total.additions + parsed.additions,
      deletions: total.deletions + parsed.deletions
    };
  }, { additions: 0, deletions: 0 });
}

export function FileToolbar(props) {
const { projectDir, onOpenFileEditor, onOpenPreview, customActions, onRunCustomAction, onRefreshCustomActions, orb } = props;
const [menuOpen, setMenuOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [cliOpen, setCliOpen] = useState(false);
  const [gitStats, setGitStats] = useState(null);
  const menuRef = useRef(null);

  // Lazy-load the git and CLI modals on first open, mirroring how the
  // chat view lazy-loads the file editor: the modal chunks are fetched
  // only when the user actually opens them, keeping them out of the
  // main entry bundle.
  const [GitModal, setGitModal] = useState(null);
  const [CliModal, setCliModal] = useState(null);

  useEffect(() => {
    if (!gitOpen || GitModal) return;
    let cancelled = false;
    import('./GitModal.jsx').then((mod) => {
      if (!cancelled) setGitModal(() => mod.GitModal);
    }).catch(() => {
      if (!cancelled) setGitModal(null);
    });
    return () => { cancelled = true; };
  }, [gitOpen, GitModal]);

  useEffect(() => {
    if (!cliOpen || CliModal) return;
    let cancelled = false;
    import('./CliModal.jsx').then((mod) => {
      if (!cancelled) setCliModal(() => mod.CliModal);
    }).catch(() => {
      if (!cancelled) setCliModal(null);
    });
    return () => { cancelled = true; };
  }, [cliOpen, CliModal]);

      const refreshGitStats = useCallback(async () => {
    try {
      setGitStats(await fetchGitStats(projectDir));
    } catch (_) {
      setGitStats(null);
    }
  }, [projectDir]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStats(projectDir).then((stats) => {
      if (!cancelled) setGitStats(stats);
    }).catch(() => {
      if (!cancelled) setGitStats(null);
    });
    return () => { cancelled = true; };
  }, [projectDir]);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  function handleTrigger() {
const nextOpen = !menuOpen;
setMenuOpen(nextOpen);
refreshGitStats();
if (nextOpen && onRefreshCustomActions) onRefreshCustomActions();
}

  function handleFileEditor() {
    setMenuOpen(false);
    if (onOpenFileEditor) onOpenFileEditor();
  }

  function handleGit() {
    setMenuOpen(false);
    setGitOpen(true);
  }

  function handleGitClose() {
    setGitOpen(false);
    refreshGitStats();
  }

  function handleCli() {
    setMenuOpen(false);
    setCliOpen(true);
  }
  function handlePreview() {
setMenuOpen(false);
if (onOpenPreview) onOpenPreview();
}
function handleCustomAction(action) {
setMenuOpen(false);
if (onRunCustomAction) onRunCustomAction(action);
}
// Each count is drawn unless it is a zero sitting next to a non-zero sibling —
// the "+0" beside a "−25" is noise. When both sides are zero the pair IS drawn
// ("+0" / "−0"), because hiding everything makes the button look like the
// counts failed to load rather than like the tree is clean. The aria-label
// always announces both exact figures (never the abbreviated form).
const added = gitStats ? gitStats.additions : 0;
const deleted = gitStats ? gitStats.deletions : 0;
const hasStats = gitStats != null;
const showAdditions = hasStats && (added > 0 || deleted === 0);
const showDeletions = hasStats && (deleted > 0 || added === 0);
const statsLabel = hasStats
? added + (added === 1 ? ' line added, ' : ' lines added, ') + deleted + (deleted === 1 ? ' line deleted' : ' lines deleted')
: '';
// The folder glyph + its counts, in two shapes:
//
//   flat (default) — one silhouette filled with --fg, counts on top.
//   orb            — a 3D "glass plate" pictogram:
//                    · `__plate`  the extruded slab the whole glyph sits on
//                      (a rim layer plus a bright top face, offset in Z),
//                    · `__folder` the folder silhouette extruded 1.5px with
//                      a lit top face and a shaded under-edge,
//                    · `__sheen`  a specular streak across the top face,
//                    · `__shine`  an additive rim light along the pocket fold,
//                    · `__stats`  the counts, each duplicated as a dark
//                      under-copy (`__echo`) offset down-right for an emboss.
//
// The counts are *siblings* of the SVG in both shapes, never children: they
// are HTML text (so the browser can color and letter-space them) and the
// stats box is positioned over the folder box by CSS.
function counts(glow, fontSize) {
if (!hasStats) return null;
const suffix = glow ? ' file-toolbar__count--3d' : '';
const addText = '+' + formatCount(added);
const delText = '−' + formatCount(deleted);
// The orb's emboss steps are set in `em`, so they scale with the font the
// sizer picked: a 1px extrusion on 7.5px digits is a smear, and a 0.4px one on
// 14px digits is invisible. `--orb-count` is read by every emboss rule.
const style = glow ? { '--orb-count': fontSize || orbCountFont(2) } : null;
return h('span', { class: 'file-toolbar__git-stats', style },
showAdditions ? h('span', { class: 'file-toolbar__git-additions' + suffix },
glow ? h('span', { class: 'file-toolbar__count-echo', 'aria-hidden': 'true' }, addText) : null,
h('span', { class: 'file-toolbar__count-face' }, addText)
) : null,
showDeletions ? h('span', { class: 'file-toolbar__git-deletions' + suffix },
glow ? h('span', { class: 'file-toolbar__count-echo', 'aria-hidden': 'true' }, delText) : null,
h('span', { class: 'file-toolbar__count-face' }, delText)
) : null
);
}

// The orb sets the count font from the longest count actually drawn, so the
// digits stay as large as the folder allows (see orbCountFont); the flat
// variant keeps its fixed `0.46rem` from CSS.
const orbMaxLen = orb && hasStats
? Math.max(showAdditions ? ('+' + formatCount(added)).length : 0, showDeletions ? ('−' + formatCount(deleted)).length : 0)
: 0;
const orbFont = orbMaxLen ? orbCountFont(orbMaxLen) : null;
// The extruded folder: six stacked copies of one silhouette, in a fixed
// z-order (side, body, shade, face, sheen, shine — see the CSS for what each
// layer is). They share one viewBox and are scaled together, so the stack
// stays registered at any size; the bevel steps live in CSS, in px, because
// a 2px extrusion is a 2px extrusion whatever the glyph is scaled to.
const orbFolderLayers = [
['side', h('path', { d: FOLDER_PATH })],
['body', h('path', { d: FOLDER_PATH })],
['shade', h('path', { d: FOLDER_PATH })],
['face', h('path', { d: FOLDER_PATH })],
['sheen', h('path', { d: FOLDER_PATH })],
['shine', h('path', {
d: 'M2.6 4.2a1.6 1.6 0 0 1 1.6-1.6h3.5l1.7 1.7h6.4a1.6 1.6 0 0 1 1.6 1.6'
}), h('path', { d: 'M2.8 12.6h14.4' })]
];
const folderGlyph = orb
? h('span', { class: 'file-toolbar__plate' },
h('span', { class: 'file-toolbar__plate-face' },
h('span', { class: 'file-toolbar__cast', 'aria-hidden': 'true' }),
h('span', { class: 'file-toolbar__folder file-toolbar__folder--3d' },
h('span', { class: 'file-toolbar__folder-ground', 'aria-hidden': 'true' }),
...orbFolderLayers.map(([name, ...kids]) => h('svg', {
class: 'file-toolbar__folder-' + name,
viewBox: '0 0 20 16',
width: ORB_FOLDER_W,
height: ORB_FOLDER_H,
'aria-hidden': 'true'
}, kids)),
counts(true, orbFont)
),
h('svg', { class: 'file-toolbar__defs', viewBox: '0 0 0 0', 'aria-hidden': 'true' },
h('linearGradient', { id: 'fileToolbarFolderSide', x1: '0', y1: '0', x2: '0.3', y2: '1' },
h('stop', { offset: '0', 'stop-color': '#8d93ab' }),
h('stop', { offset: '0.35', 'stop-color': '#3b4258' }),
h('stop', { offset: '1', 'stop-color': '#141a29' })
),
h('linearGradient', { id: 'fileToolbarFolderBody', x1: '0.12', y1: '0', x2: '0.7', y2: '1' },
h('stop', { offset: '0', 'stop-color': '#eef0fb' }),
h('stop', { offset: '0.4', 'stop-color': '#c9ccdd' }),
h('stop', { offset: '1', 'stop-color': '#8d92ab' })
),
h('linearGradient', { id: 'fileToolbarFolderFace', x1: '0.1', y1: '0', x2: '0.62', y2: '1' },
/* A glossy solid does not ramp evenly: it holds near-white across the
   crown of the dome, then falls off quickly past the terminator. The
   near-flat 0 -> 0.62 zone is that crown; the last two stops are the
   fast fall-off. */
h('stop', { offset: '0', 'stop-color': '#ffffff' }),
h('stop', { offset: '0.44', 'stop-color': '#fdfdff' }),
h('stop', { offset: '0.62', 'stop-color': '#ebeCF6' }),
h('stop', { offset: '0.82', 'stop-color': '#c6c9dc' }),
h('stop', { offset: '1', 'stop-color': '#9ba1ba' })
),
h('radialGradient', { id: 'fileToolbarFolderShade', cx: '0.7', cy: '0.86', r: '0.82' },
h('stop', { offset: '0', 'stop-color': '#464d6b', 'stop-opacity': '0.72' }),
h('stop', { offset: '0.42', 'stop-color': '#4d5474', 'stop-opacity': '0.34' }),
h('stop', { offset: '0.78', 'stop-color': '#5b6280', 'stop-opacity': '0.08' }),
h('stop', { offset: '1', 'stop-color': '#5b6280', 'stop-opacity': '0' })
),
h('linearGradient', { id: 'fileToolbarFolderSheen', x1: '0', y1: '0', x2: '0.35', y2: '0.85' },
h('stop', { offset: '0', 'stop-color': '#ffffff', 'stop-opacity': '0.95' }),
h('stop', { offset: '0.28', 'stop-color': '#ffffff', 'stop-opacity': '0.20' }),
h('stop', { offset: '0.55', 'stop-color': '#ffffff', 'stop-opacity': '0' })
)
)
)
)
: h('span', { class: 'file-toolbar__folder' },
h('svg', { viewBox: '0 0 20 16', width: 28, height: 22 },
h('path', { d: FOLDER_PATH, fill: 'currentColor' })
),
counts(false)
);
return h('div', { class: 'file-toolbar' + (orb ? ' file-toolbar--orb' : '') },
h('button', {
class: 'file-toolbar__trigger',
type: 'button',
onClick: handleTrigger,
'aria-label': 'File tools' + (statsLabel ? '. ' + statsLabel : ''),
'aria-haspopup': 'true',
'aria-expanded': String(menuOpen),
title: 'File, git, and CLI tools' + (statsLabel ? ' — ' + statsLabel : '')
},
orb ? h('span', { class: 'file-toolbar__sheen', 'aria-hidden': 'true' }) : null,
h('span', { class: 'file-toolbar__stack', 'aria-hidden': 'true' },
h('svg', { viewBox: '0 0 12 6', width: orb ? ORB_CHEVRON_W : 14, height: orb ? ORB_CHEVRON_H : 7 },
h('path', { d: 'M0.5 5.5 6 1 11.5 5.5 10 6 6 2.5 2 6Z', fill: 'currentColor' })
),
folderGlyph,
h('svg', { viewBox: '0 0 12 6', width: orb ? ORB_CHEVRON_W : 14, height: orb ? ORB_CHEVRON_H : 7 },
h('path', { d: 'M0.5 0.5 6 5 11.5 0.5 10 0 6 3.5 2 0Z', fill: 'currentColor' })
)
)
),
    menuOpen && h('div', { ref: menuRef, class: 'file-toolbar__menu', role: 'menu' },
customActions && customActions.length ? [
...customActions.map((action) =>
h('button', {
key: action.id,
class: 'file-toolbar__menu-item file-toolbar__menu-item--action',
role: 'menuitem',
type: 'button',
onClick: () => handleCustomAction(action)
}, action.label || action.id)
),
h('div', { class: 'file-toolbar__menu-sep', role: 'separator' })
] : null,
h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: handleFileEditor },
h('span', { class: 'file-toolbar__menu-icon' }, '\u{1F4DD}'),
h('span', null, 'Files')
),
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: handlePreview },
        h('span', { class: 'file-toolbar__menu-icon' }, '\u{1F4F1}'),
        h('span', null, 'Preview')
      ),
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: handleGit },
        h('span', { class: 'file-toolbar__menu-icon' }, '\u{1F4C1}'),
        h('span', null, 'Git')
      ),
      h('button', { class: 'file-toolbar__menu-item', role: 'menuitem', type: 'button', onClick: handleCli },
h('span', { class: 'file-toolbar__menu-icon' }, '\u{1F5A5}'),
h('span', null, 'Cli')
)
),
gitOpen && GitModal ? h(GitModal, { projectDir, onClose: handleGitClose }) : null,
    cliOpen && CliModal ? h(CliModal, { projectDir, onClose: () => setCliOpen(false) }) : null
  );
}
