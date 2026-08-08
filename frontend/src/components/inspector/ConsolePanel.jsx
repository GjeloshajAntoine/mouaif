// Inspector ConsolePanel — virtual-list based console log viewer
import { h } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { createVirtualList } from '../../virtual-list.js';
import { fmtTime, appendRemoteObject } from './format.js';

export function ConsolePanel(props) {
  const scroller = useRef(null);
  useEffect(() => {
    if (!scroller.current) return;
    const vl = createVirtualList({
      scroller: scroller.current,
      itemHeight: 52,
      overscan: 6,
      key: (item) => item.id,
      render: (item, node) => {
        const sig = item.id + '|' + (item.rev || 0);
        if (node.__sig === sig) return;
        node.__sig = sig;
        node.className = 'inspector__row inspector__row--console inspector__row--' + (item.level || 'log');
        const time = document.createElement('span');
        time.className = 'inspector__row-time';
        time.textContent = fmtTime(item.ts);
        const level = document.createElement('span');
        level.className = 'inspector__row-level';
        level.textContent = (item.level || 'log').toUpperCase();
        const body = document.createElement('span');
        body.className = 'inspector__row-body';
        const text = document.createElement('span');
        text.className = 'inspector__row-text';
        if (Array.isArray(item.args) && item.args.length) {
          for (let i = 0; i < item.args.length; i++) {
            if (i) text.appendChild(document.createTextNode(' '));
            appendRemoteObject(text, item.args[i]);
          }
        } else {
          text.textContent = item.text || '';
        }
        body.appendChild(text);
        const meta = document.createElement('span');
        meta.className = 'inspector__row-meta';
        const bits = [];
        if (item.url) {
          bits.push(item.url.replace(/^.*\//, '') + (item.line ? ':' + item.line : ''));
        }
        if (item.stack) bits.push('stack');
        meta.textContent = bits.join(' · ');
        if (meta.textContent) body.appendChild(meta);
        if (item.stack) {
          node.classList.add('inspector__row--expandable');
          node.title = 'tap for stack trace';
        }
        node.replaceChildren(time, level, body);
      },
      data: []
    });
    props.onReady && props.onReady(vl);
    return () => { try { vl.destroy(); } catch { /* ignore */ } };
  }, []);
  return h('div', { ref: scroller, class: 'inspector__scroller inspector__scroller--console', 'aria-label': 'Console output', onClick: props.onRowTap });
}