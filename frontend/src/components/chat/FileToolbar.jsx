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
  const { projectDir, onOpenFileEditor, onOpenPreview } = props;
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
    setMenuOpen(!menuOpen);
    refreshGitStats();
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

  const statsLabel = gitStats
    ? gitStats.additions + ' lines added, ' + gitStats.deletions + ' lines deleted'
    : '';

  return h('div', { class: 'file-toolbar' },
    h('button', {
      class: 'file-toolbar__trigger',
      type: 'button',
      onClick: handleTrigger,
      'aria-label': 'File tools' + (statsLabel ? '. ' + statsLabel : ''),
      'aria-haspopup': 'true',
      'aria-expanded': String(menuOpen),
      title: 'File, git, and CLI tools' + (statsLabel ? ' — ' + statsLabel : '')
    },
      h('span', { class: 'file-toolbar__stack', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 12 6', width: 12, height: 6 },
          h('path', { d: 'M0.5 5.5 6 1 11.5 5.5 10 6 6 2.5 2 6Z', fill: 'currentColor' })
        ),
        h('span', { class: 'file-toolbar__folder' },
          h('svg', { viewBox: '0 0 20 16', width: 24, height: 18 },
            h('path', { d: 'M2 3.5a2 2 0 0 1 2-2h4.2l1.9 1.9H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9Z', fill: 'currentColor' })
          ),
          gitStats ? h('span', { class: 'file-toolbar__git-stats' },
            h('span', { class: 'file-toolbar__git-additions' }, '+' + gitStats.additions),
            h('span', { class: 'file-toolbar__git-deletions' }, '−' + gitStats.deletions)
          ) : null
        ),
        h('svg', { viewBox: '0 0 12 6', width: 12, height: 6 },
          h('path', { d: 'M0.5 0.5 6 5 11.5 0.5 10 0 6 3.5 2 0Z', fill: 'currentColor' })
        )
      )
    ),
    menuOpen && h('div', { ref: menuRef, class: 'file-toolbar__menu', role: 'menu' },
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
