// Inspector OverviewPanel — page metrics grid
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { fmtBytes } from './format.js';

export function OverviewPanel(props) {
  const [metrics, setMetrics] = useState(null);

  // The parent builds a fresh `() => handlers.fetchMetrics()` arrow on
  // every render, so depending on props.metrics would tear down and
  // restart this 2.5 s poll on each parent render — including the render
  // triggered by every console/network row — and call
  // Performance.getMetrics far more often than the cadence asks for. Read
  // the latest callback through a ref and start the loop once.
  const metricsFn = useRef(props.metrics);
  metricsFn.current = props.metrics;

  useEffect(() => {
    let stop = false;
    let timer = null;
    async function tick() {
      if (stop) return;
      try {
        const fn = metricsFn.current;
        const m = fn ? await fn() : null;
        if (stop) return;
        setMetrics(m);
      } catch { /* leave stale */ }
      if (!stop) timer = setTimeout(tick, 2500);
    }
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, []);

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