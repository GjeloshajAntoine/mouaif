// mouaif web — "this project defines hooks" banner (docs/features/hooks.md)
//
// A bar in the bottom stack, above the composer, shown in a project's chats
// while the project defines hooks the user has not trusted (or that changed
// since): they are off until reviewed. "Review" opens the same review as
// Settings → Hooks, with "Trust and turn on". "Not now" hides the bar for
// this hash until the page reloads. Polled slowly: the hooks rarely change.
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ProjectHooksReview, useProjectHooks } from '../settings/ProjectHooksReview.jsx';
import { HOOK_ICON_PATH } from './hookEvents.js';
import '../settings/hooks.css';

const POLL_MS = 30000;
const dismissed = new Set();

export function ProjectHooksBar({ projectDir }) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useProjectHooks(projectDir, tick);
  const [open, setOpen] = useState(false);
  const [, setHidden] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') setTick((n) => n + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { setOpen(false); }, [projectDir]);

  if (!state || !state.hash || (state.trusted && !open)) return null;
  const key = projectDir + '\n' + state.hash;
  if (dismissed.has(key) && !open) return null;
  const count = state.hooks.length;

  const panel = open ? h('div', { class: 'webhook-panel hooks-panel', role: 'group', 'aria-label': 'Project hooks' },
    h('div', { class: 'webhook-panel__section' },
      h('div', { class: 'webhook-panel__label' }, 'Hooks this project defines'),
      h(ProjectHooksReview, { projectDir, state, onState: (next) => { setState(next); if (next && next.trusted) setOpen(false); } }))) : null;

  return h(Fragment, null, panel,
    h('div', { class: 'run-dock webhook-dock webhook-dock--paused project-hooks-bar', role: 'group', 'aria-label': 'Project hooks' },
      h('span', { class: 'webhook-dock__icon' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
          h('path', { d: HOOK_ICON_PATH }))),
      h('div', { class: 'run-dock__text' },
        h('div', { class: 'run-dock__goal' }, h('strong', null, 'Project hooks off'), ' · ', count + (count === 1 ? ' hook' : ' hooks')),
        h('div', { class: 'run-dock__meta' }, state.changed ? 'They changed since you trusted them. Review before they run.' : 'This project defines hooks. They run only after you review them.')),
      h('button', { class: 'run-dock__btn run-dock__btn--primary', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        onClick: () => setOpen((v) => !v) }, open ? 'Close' : 'Review'),
      !open ? h('button', { class: 'run-dock__btn', type: 'button',
        onClick: () => { dismissed.add(key); setHidden((n) => n + 1); } }, 'Not now') : null));
}
