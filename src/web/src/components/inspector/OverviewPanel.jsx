// Inspector OverviewPanel — page metrics grid
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fmtBytes } from './format.js';

export function OverviewPanel(props) {
  const gridRef = useRef(null);
  useEffect(() => {
    let stop = false;
    let timer = null;
    async function tick() {
      if (stop) return;
      try {
        const m = await props.metrics();
        if (stop || !gridRef.current) return;
        gridRef.current.innerHTML = '';
        const rows = [
          ['Documents', m.documents], ['Frames', m.frames], ['Nodes', m.nodes],
          ['Listeners', m.listeners], ['JS heap', fmtBytes(m.jsHeap)], ['Layout', m.layoutCount],
          ['Recalc style', m.recalcCount], ['Requests (session)', m.netCount]
        ];
        for (const [k, v] of rows) {
          const cell = document.createElement('div');
          cell.className = 'inspector__metric';
          const val = document.createElement('div');
          val.className = 'inspector__metric-value';
          val.textContent = (v === undefined || v === null || v === '') ? '—' : String(v);
          const key = document.createElement('div');
          key.className = 'inspector__metric-key';
          key.textContent = k;
          cell.appendChild(val); cell.appendChild(key);
          gridRef.current.appendChild(cell);
        }
      } catch { /* leave stale */ }
      if (!stop) timer = setTimeout(tick, 2500);
    }
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, []);
  return h('div', { ref: gridRef, class: 'inspector__metrics', 'aria-label': 'Page metrics' });
}