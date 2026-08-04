// Inspector NetworkPanel — virtual-list based network request log
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { createVirtualList } from '../../virtual-list.js';
import { statusLabel, statusClass, fmtBytes, fmtDur } from './format.js';

export function NetworkPanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 52,
      overscan: 6,
      key: (item) => item.id,
      render: (item, node) => {
        const sig = item.id + '|' + (item.rev || 0) + '|' + String(item.status) + '|' + String(item.size) + '|' + String(item.duration);
        if (node.__sig === sig) return;
        node.__sig = sig;
        node.className = 'inspector__row inspector__row--network inspector__row--expandable' + (item.backfilled ? ' inspector__row--backfilled' : '');
        const top = document.createElement('div');
        top.className = 'inspector__net-top';
        const method = document.createElement('span');
        method.className = 'inspector__row-method';
        method.textContent = item.method || '';
        const status = document.createElement('span');
        status.className = 'inspector__row-status inspector__row-status--' + statusClass(item.status);
        status.textContent = statusLabel(item.status);
        const url = document.createElement('span');
        url.className = 'inspector__row-text';
        url.textContent = item.url || '';
        top.appendChild(method); top.appendChild(status); top.appendChild(url);
        const meta = document.createElement('div');
        meta.className = 'inspector__net-meta';
        const bits = [];
        if (item.type) bits.push(item.type);
        if (item.mimeType) bits.push(item.mimeType.split(';')[0]);
        if (item.size != null) bits.push(fmtBytes(item.size));
        if (item.duration != null) bits.push(fmtDur(item.duration));
        if (item.ip) bits.push(item.ip);
        if (item.backfilled) bits.push('pre-attach');
        meta.textContent = bits.join(' · ');
        node.replaceChildren(top, meta);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller inspector__scroller--network', 'aria-label': 'Network log', onClick: props.onRowTap });
}