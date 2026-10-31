// mouaif web — agent network dock
//
// One live picture of the chat's delegations: who started whom, which group
// they belong to, who waits on whom, and what they are saying to each other.
// Every message between two agents travels along the edge that joins them
// (delegation down, answers and reports up, handoffs between members).
//
// The dock is part of the bottom stack, between the transcript and the
// composer, and only appears once the chat has delegated. It is drawn as a
// tool card, so it reads and expands like every other chat element:
//   collapsed   the card head: agent counts, the latest message (which
//               slides in as each new one arrives) and a status dot
//   expanded    the head plus the graph, the selected agent and the feed
//   fullscreen  the same content over the whole view (Escape leaves it)
// Collapsed / expanded is remembered per browser; fullscreen is not.
//
// Data comes from agentNetworkState.js; this file only draws it.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useModal } from '../../hooks/useModal.js';
import { getAgentNetwork, subscribeAgentNetwork } from './agentNetworkState.js';
import { ROOT, NODE_H, layoutNetwork, edgePath, agentCount, activeCount } from './agentNetwork.js';

const PULSE_MS = 950;
const STREAM_PULSE_MS = 700;
const FEED_SHOWN = 40;
const EXPANDED_KEY = 'mouaif.agentNetwork.expanded';

const STATUS_TEXT = {
  idle: '', running: 'running', waiting: 'waiting', done: 'done', failed: 'failed',
  cancelled: 'cancelled', ended: 'ended', planned: 'not started'
};

const KIND_TEXT = {
  delegate: 'assigned', message: 'message', result: 'answered', error: 'failed', report: 'reported',
  handoff: 'handoff', decision: 'decision', conflict: 'conflict', stop: 'stop'
};

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function readExpanded() {
  try { return localStorage.getItem(EXPANDED_KEY) === '1'; } catch { return false; }
}

function writeExpanded(on) {
  try { localStorage.setItem(EXPANDED_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

function short(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function nodeLabel(net, id) {
  if (!id) return 'all';
  if (id === ROOT) return 'Main agent';
  const node = net.nodes.get(id);
  if (!node) return 'agent';
  return node.memberId && node.agent && node.memberId !== node.agent ? node.memberId : (node.label || 'Subagent');
}

// The card that shows this agent's run: its own top-level card, a nested
// row when the parent card is open, otherwise the nearest ancestor's card.
function findAgentCard(root, net, id) {
  if (!root) return null;
  let cur = net.nodes.get(id);
  for (let guard = 0; cur && cur.id !== ROOT && guard < 64; guard++) {
    const esc = (window.CSS && CSS.escape) ? CSS.escape(cur.id) : cur.id.replace(/"/g, '\\"');
    const top = root.querySelector('.tool-card[data-tool-id="' + esc + '"]');
    if (top) return top;
    const nested = root.querySelector('[data-nested-tool-id="' + esc + '"]');
    if (nested && nested.offsetParent) return nested;
    cur = net.nodes.get(cur.parentId);
  }
  return null;
}

// Width the graph has to draw in, tracked as the card or the screen resizes.
// Before the first measurement, guess from the window.
function useGraphWidth() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth - 48 : 0));
  const obsRef = useRef(null);
  const elRef = useRef(null);
  // One ref function for the hook's lifetime, so a re-render does not
  // detach and re-attach the observer.
  const ref = useRef((el) => {
    if (el === elRef.current) return;
    elRef.current = el;
    if (obsRef.current) { obsRef.current.disconnect(); obsRef.current = null; }
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      obsRef.current = new ResizeObserver(measure);
      obsRef.current.observe(el);
    }
  }).current;
  useEffect(() => () => obsRef.current && obsRef.current.disconnect(), []);
  return [width, ref];
}

function PulseDot({ pulse, d, reverse, onDone }) {
  const pathRef = useRef(null);
  const dotRef = useRef(null);
  useEffect(() => {
    const path = pathRef.current;
    const dot = dotRef.current;
    if (!path || !dot) return undefined;
    const ms = pulse.kind === 'stream' ? STREAM_PULSE_MS : PULSE_MS;
    let total = 0;
    try { total = path.getTotalLength(); } catch { total = 0; }
    if (!total || reducedMotion()) {
      const t = setTimeout(onDone, ms);
      return () => clearTimeout(t);
    }
    let raf = 0;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      // ease-in-out so the dot leaves and lands gently
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const p = path.getPointAtLength(total * (reverse ? 1 - e : e));
      dot.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');
      if (t < 1) raf = requestAnimationFrame(step);
      else onDone();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return h('g', { class: 'agent-net__pulse agent-net__pulse--' + pulse.kind },
    h('path', { ref: pathRef, d, class: 'agent-net__pulse-track' }),
    h('g', { ref: dotRef, transform: 'translate(-99 -99)' },
      h('circle', { class: 'agent-net__pulse-halo', r: pulse.kind === 'stream' ? 6 : 9 }),
      h('circle', { class: 'agent-net__pulse-dot', r: pulse.kind === 'stream' ? 3 : 4.5 })
    )
  );
}

export function AgentNetworkDock({ transcriptRef }) {
  const [, setVersion] = useState(0);
  const [pulses, setPulses] = useState([]);
  const [mode, setMode] = useState(() => (readExpanded() ? 'expanded' : 'collapsed'));
  const [selected, setSelected] = useState(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // The mode fullscreen returns to.
  const inlineModeRef = useRef(mode === 'fullscreen' ? 'collapsed' : mode);
  const netRef = useRef(getAgentNetwork());
  const pulseSeq = useRef(0);

  useEffect(() => {
    // The transcript may have synced before this effect subscribed: catch up.
    const current = getAgentNetwork();
    if (current !== netRef.current) netRef.current = current;
    setVersion(current.version);
    return subscribeAgentNetwork(onNetwork);
  }, []);

  function onNetwork(net, incoming) {
    if (net !== netRef.current) {
      // Another chat: keep the mode, forget the previous chat's selection.
      netRef.current = net;
      setSelected(null);
      setPulses([]);
      if (modeRef.current === 'fullscreen') setMode(inlineModeRef.current);
    }
    setVersion(net.version);
    if (!incoming.length || document.hidden) return;
    // Collapsed, the head's latest-message line is the animation.
    if (modeRef.current === 'collapsed') return;
    setPulses((list) => {
      // Keep at most one in-flight "writing" pulse per sender.
      const next = list.filter((p) => !(p.kind === 'stream' && incoming.some((q) => q.kind === 'stream' && q.from === p.from)));
      for (const p of incoming) next.push(Object.assign({ key: ++pulseSeq.current }, p));
      return next.slice(-24);
    });
  }

  const setInline = (next) => {
    inlineModeRef.current = next;
    writeExpanded(next === 'expanded');
    if (next === 'collapsed') setPulses([]);
    setMode(next);
  };
  const enterFullscreen = () => {
    if (mode !== 'fullscreen') inlineModeRef.current = mode;
    setMode('fullscreen');
  };
  const exitFullscreen = () => {
    if (inlineModeRef.current === 'collapsed') setPulses([]);
    setMode(inlineModeRef.current);
  };
  const fullRef = useModal({ onClose: exitFullscreen, active: mode === 'fullscreen' });
  const [graphWidth, graphRef] = useGraphWidth();

  const net = netRef.current;
  const total = agentCount(net);
  const active = activeCount(net);
  const shown = mode !== 'collapsed';
  // The top-down tree while it fits (full screen may shrink it to 80%);
  // past that, the indented outline that only grows downwards.
  const layout = useMemo(() => {
    if (!shown || !total) return null;
    const wide = layoutNetwork(net);
    const fits = wide.width * (mode === 'fullscreen' ? 0.8 : 1) <= graphWidth;
    return fits ? wide : layoutNetwork(net, { vertical: true, width: graphWidth });
  }, [shown, mode, total, net.version, graphWidth]);
  if (!total) return null;

  const byId = layout ? new Map(layout.nodes.map((n) => [n.id, n])) : new Map();
  const busyEdges = new Set();
  const sending = new Set();
  const receiving = new Set();
  for (const p of pulses) {
    busyEdges.add(p.from + '>' + p.to);
    busyEdges.add(p.to + '>' + p.from);
    sending.add(p.from);
    receiving.add(p.to);
  }
  const dropPulse = (key) => setPulses((list) => list.filter((p) => p.key !== key));
  const sel = selected && net.nodes.get(selected);
  const toggleSelect = (id) => setSelected(selected === id ? null : id);
  const showInChat = (id) => {
    const card = findAgentCard(transcriptRef && transcriptRef.current, net, id);
    if (!card) return;
    if (mode === 'fullscreen') exitFullscreen();
    card.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    card.classList.remove('is-agent-flash');
    void card.offsetWidth;
    card.classList.add('is-agent-flash');
    setTimeout(() => card.classList.remove('is-agent-flash'), 1600);
  };
  const feed = net.feed.slice(-FEED_SHOWN).reverse();
  const latest = net.feed.length ? net.feed[net.feed.length - 1] : null;
  const counts = total + (total === 1 ? ' agent' : ' agents');

  const nodeW = layout ? layout.nodeW : 0;
  const vertical = !!(layout && layout.vertical);
  // Characters that fit a box's label and status line.
  const labelMax = Math.max(15, Math.floor((nodeW - 32) / 7));
  const subMax = Math.max(19, Math.floor((nodeW - 30) / 5.6));
  const treeParent = (n) => (n.id === ROOT ? null : (net.nodes.has(n.parentId) ? n.parentId : ROOT));

  const graph = (full) => h('div', { class: 'agent-net__graph' + (vertical ? ' agent-net__graph--vertical' : ''), ref: graphRef },
    h('svg', {
      class: 'agent-net__svg',
      width: full && !vertical ? null : layout.width,
      height: full && !vertical ? null : layout.height,
      // Full screen scales a small tree up (to 1.6x) and a large one down,
      // but never below 80% of its natural size: past that it turns into
      // the vertical outline, which keeps its natural size.
      style: full && !vertical ? { width: 'min(100%, ' + Math.round(layout.width * 1.6) + 'px)', minWidth: Math.round(layout.width * 0.8) + 'px', height: 'auto' } : null,
      viewBox: '0 0 ' + layout.width + ' ' + layout.height,
      role: 'img',
      'aria-label': 'Delegation graph: ' + counts + ', ' + active + ' active'
    },
      h('defs', null,
        h('marker', { id: 'agent-net-arrow-' + (full ? 'f' : 'i'), viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
          h('path', { d: 'M0 0 L8 4 L0 8 z', class: 'agent-net__arrow' })
        )
      ),
      layout.edges.map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const live = busyEdges.has(e.from + '>' + e.to);
        const running = e.kind === 'tree' && (b.status === 'running' || b.status === 'waiting');
        return h('path', {
          key: e.id,
          d: edgePath(a, b, e.kind, layout),
          class: 'agent-net__edge agent-net__edge--' + e.kind + (live ? ' is-live' : '') + (running ? ' is-running' : ''),
          'marker-end': e.kind === 'dep' ? 'url(#agent-net-arrow-' + (full ? 'f' : 'i') + ')' : null
        });
      }),
      layout.nodes.map((n) => h('g', {
        key: n.id,
        class: 'agent-net__node agent-net__node--' + n.status
          + (n.id === ROOT ? ' agent-net__node--root' : '')
          + (n.ghost ? ' agent-net__node--ghost' : '')
          + (sending.has(n.id) ? ' is-sending' : '')
          + (receiving.has(n.id) ? ' is-receiving' : '')
          + (selected === n.id ? ' is-selected' : ''),
        transform: 'translate(' + n.x + ' ' + n.y + ')',
        tabIndex: n.id === ROOT ? -1 : 0,
        role: n.id === ROOT ? null : 'button',
        'aria-label': n.id === ROOT ? null : nodeLabel(net, n.id) + ', ' + (STATUS_TEXT[n.status] || n.status),
        onClick: () => n.id !== ROOT && toggleSelect(n.id),
        onKeyDown: (ev) => {
          if (n.id !== ROOT && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleSelect(n.id); }
        }
      },
        h('title', null, n.task ? short(n.task, 300) : nodeLabel(net, n.id)),
        h('rect', { class: 'agent-net__ring', x: -3, y: -3, width: nodeW + 6, height: NODE_H + 6, rx: 12 }),
        h('rect', { class: 'agent-net__box', width: nodeW, height: NODE_H, rx: 9 }),
        h('circle', { class: 'agent-net__status', cx: 13, cy: NODE_H / 2, r: 4 }),
        h('text', { class: 'agent-net__label', x: 24, y: 18 }, short(nodeLabel(net, n.id), labelMax)),
        h('text', { class: 'agent-net__sub', x: 24, y: 33 },
          n.id === ROOT ? 'this chat' : short([STATUS_TEXT[n.status] || n.status, n.memberId && n.agent ? n.agent : (n.background ? 'background' : '')].filter(Boolean).join(' · '), subMax))
      )),
      pulses.map((p) => {
        const a = byId.get(p.from);
        const b = byId.get(p.to);
        if (!a || !b) return null;
        // Parent and child share a tree edge; anyone else (group members
        // handing off) travels a dependency-style arc between them.
        const kind = treeParent(b) === a.id || treeParent(a) === b.id ? 'tree'
          : vertical ? 'dep' : (a.y === b.y ? 'dep' : 'tree');
        const reverse = a.y > b.y || (a.y === b.y && a.x > b.x);
        const top = reverse ? b : a;
        const bottom = reverse ? a : b;
        return h(PulseDot, { key: p.key, pulse: p, d: edgePath(top, bottom, kind, layout), reverse, onDone: () => dropPulse(p.key) });
      })
    )
  );

  const detail = () => (sel ? h('div', { class: 'agent-net__detail' },
    h('div', { class: 'agent-net__detail-head' },
      h('strong', null, nodeLabel(net, sel.id)),
      h('span', { class: 'agent-net__chip agent-net__chip--' + sel.status }, STATUS_TEXT[sel.status] || sel.status),
      sel.agent && sel.agent !== nodeLabel(net, sel.id) ? h('span', { class: 'agent-net__meta' }, sel.agent) : null,
      sel.model ? h('span', { class: 'agent-net__meta' }, sel.model) : null,
      sel.groupId && net.groups.get(sel.groupId) && net.groups.get(sel.groupId).name
        ? h('span', { class: 'agent-net__meta' }, 'group ' + net.groups.get(sel.groupId).name) : null,
      sel.ghost ? null : h('button', { class: 'agent-net__link', type: 'button', onClick: () => showInChat(sel.id) }, 'Show in chat')
    ),
    sel.task ? h('p', { class: 'agent-net__task' }, sel.task) : null,
    (() => {
      const g = sel.groupId && net.groups.get(sel.groupId);
      const m = g && g.members.get(sel.memberId);
      if (!m) return null;
      return h('p', { class: 'agent-net__meta-line' },
        m.role ? 'Role: ' + m.role : null,
        m.role && m.dependsOn.length ? ' · ' : null,
        m.dependsOn.length ? 'Waits for: ' + m.dependsOn.join(', ') : null);
    })()
  ) : null);

  const feedList = () => (feed.length ? h('div', { class: 'agent-net__feed' },
    h('div', { class: 'agent-net__feed-title' }, 'Messages', h('span', { class: 'agent-net__count' }, net.feed.length)),
    h('ol', { class: 'agent-net__feed-list' },
      feed.map((f, i) => h('li', { key: net.feed.length - i, class: 'agent-net__msg agent-net__msg--' + f.kind },
        h('span', { class: 'agent-net__msg-kind' }, KIND_TEXT[f.kind] || f.kind),
        h('button', { class: 'agent-net__who', type: 'button', onClick: () => f.from && f.from !== ROOT && setSelected(f.from) }, nodeLabel(net, f.from)),
        h('span', { class: 'agent-net__msg-arrow', 'aria-label': 'to' }, '→'),
        h('button', { class: 'agent-net__who', type: 'button', onClick: () => f.to && f.to !== ROOT && setSelected(f.to) }, nodeLabel(net, f.to)),
        f.text ? h('span', { class: 'agent-net__msg-text' }, f.text) : null
      ))
    )
  ) : null);

  const fullscreenBtn = (isFull) => h('button', {
    type: 'button',
    class: 'agent-net__mode' + (isFull ? ' is-active' : ''),
    onClick: (ev) => { ev.stopPropagation(); if (isFull) exitFullscreen(); else enterFullscreen(); },
    onKeyDown: (ev) => ev.stopPropagation(),
    'aria-pressed': String(isFull),
    'aria-label': isFull ? 'Exit fullscreen' : 'Fullscreen agent network',
    title: isFull ? 'Exit fullscreen (Esc)' : 'Fullscreen'
  },
    h('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': 'true' },
      h('path', {
        d: isFull ? 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5' : 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      })
    )
  );
  // Same status dot as a tool card: running while any agent is, red when one
  // failed, green once every agent settled.
  const failedAny = [...net.nodes.values()].some((n) => n.status === 'failed');
  const pill = active ? ['tool-card__pill--busy', 'running'] : failedAny ? ['tool-card__pill--err', 'failed'] : ['tool-card__pill--ok', 'done'];
  const summary = counts + (active ? ' · ' + active + ' active' : '');
  const expanded = mode === 'expanded';
  const toggle = () => setInline(expanded ? 'collapsed' : 'expanded');

  return h('section', {
    // A tool card like every other chat element: chevron, name, one-line
    // detail, summary and status dot in the head; the graph is its body.
    class: 'tool-card agent-net' + (expanded ? ' is-expanded' : ''),
    'aria-label': 'Agent network'
  },
    h('div', {
      class: 'tool-card__head',
      role: 'button',
      tabIndex: 0,
      'aria-expanded': String(expanded),
      onClick: toggle,
      onKeyDown: (ev) => {
        if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        toggle();
      }
    },
      h('span', { class: 'tool-card__chev', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 24 24', width: 12, height: 12, fill: 'currentColor' },
          h('path', { d: 'M9 5.5 15.5 12 9 18.5l1.4 1.4L18.3 12l-7.9-7.9L9 5.5Z' })
        )
      ),
      h('span', { class: 'tool-card__name' }, 'Agents'),
      // The latest message between agents; re-keyed so each new one slides in.
      h('span', { key: 'latest-' + net.feed.length, class: 'tool-card__args agent-net__latest' + (latest ? ' agent-net__latest--' + latest.kind : '') },
        latest ? [nodeLabel(net, latest.from), ' → ', nodeLabel(net, latest.to), latest.text ? ': ' + latest.text : ''].join('') : ''
      ),
      h('span', { class: 'tool-card__result-summary' }, summary),
      fullscreenBtn(false),
      h('span', { class: 'tool-card__pill ' + pill[0] }, pill[1])
    ),
    expanded && layout ? h('div', { class: 'tool-card__body agent-net__body' }, graph(false), detail(), feedList()) : null,
    // Portaled to <body> so no transformed ancestor can trap the fixed overlay.
    mode === 'fullscreen' && layout ? createPortal(h('div', { class: 'agent-net-full', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Agent network', ref: fullRef },
      h('header', { class: 'agent-net-full__head' },
        h('span', { class: 'tool-card__pill ' + pill[0] }, pill[1]),
        h('strong', { class: 'agent-net-full__title' }, 'Agents'),
        h('span', { class: 'agent-net-full__summary' }, summary),
        fullscreenBtn(true)
      ),
      h('div', { class: 'agent-net-full__body' },
        h('div', { class: 'agent-net-full__stage' }, graph(true)),
        h('aside', { class: 'agent-net-full__side' }, detail(), feedList())
      )
    ), document.body) : null
  );
}
