// Inspector OverviewPanel — page metrics grid
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { fmtBytes } from './format.js';

export function OverviewPanel(props) {
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    let stop = false;
    let timer = null;
    async function tick() {
      if (stop) return;
      try {
        const m = await props.metrics();
        if (stop) return;
        setMetrics(m);
      } catch { /* leave stale */ }
      if (!stop) timer = setTimeout(tick, 2500);
    }
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [props.metrics]);

  const rows = metrics ? [
    ['Documents', metrics.documents], ['Frames', metrics.frames], ['Nodes', metrics.nodes],
    ['Listeners', metrics.listeners], ['JS heap', fmtBytes(metrics.jsHeap)], ['Layout', metrics.layoutCount],
    ['Recalc style', metrics.recalcCount], ['Requests (session)', metrics.netCount]
  ] : [];

  return h('div', { class: 'inspector__metrics', 'aria-label': 'Page metrics' },
    rows.map(([k, v]) =>
      h('div', { class: 'inspector__metric', key: k },
        h('div', { class: 'inspector__metric-value' }, (v === undefined || v === null || v === '') ? '—' : String(v)),
        h('div', { class: 'inspector__metric-key' }, k)
      )
    )
  );
}