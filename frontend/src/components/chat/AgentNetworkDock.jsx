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
// Only what happens while the dock is on screen animates: opening a chat,
// expanding the card or rebuilding from the saved transcript does not.
//
// Data comes from agentNetworkState.js; this file only draws it.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useModal } from '../../hooks/useModal.js';
import { getAgentNetwork, subscribeAgentNetwork } from './agentNetworkState.js';
import { ROOT, NODE_H, layoutNetwork, edgePath, agentCount, activeCount, latestTurnFailed, topLevelAncestor } from './agentNetwork.js';

const PULSE_MS = 950;
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

function baseLabel(node) {
  return node.memberId && node.agent && node.memberId !== node.agent ? node.memberId : (node.label || 'Subagent');
}

// Display names by node id. Agents that share a name are numbered in the
// order they started ("tester 1", "tester 2").
function nodeLabels(net) {
  const byName = new Map();
  const sorted = [...net.nodes.values()].filter((n) => n.id !== ROOT).sort((a, b) => a.order - b.order);
  for (const node of sorted) {
    const name = baseLabel(node);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(node.id);
  }
  const labels = new Map([[ROOT, 'Main agent']]);
  for (const [name, ids] of byName) {
    ids.forEach((id, i) => labels.set(id, ids.length > 1 ? name + ' ' + (i + 1) : name));
  }
  return labels;
}

function clockTime(at) {
  if (!at) return '';
  try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
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
    const ms = PULSE_MS;
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
      h('circle', { class: 'agent-net__pulse-halo', r: 9 }),
      h('circle', { class: 'agent-net__pulse-dot', r: 4.5 })
    )
  );
}

export function AgentNetworkDock({ transcriptRef, onJumpToToolCard }) {
  const [, setVersion] = useState(0);
  const [pulses, setPulses] = useState([]);
  const [mode, setMode] = useState(() => (readExpanded() ? 'expanded' : 'collapsed'));
  const [selected, setSelected] = useState(null);
  // Feed rows (by seq) opened to their full text.
  const [open, setOpen] = useState(() => new Set());
  // "Show in chat" while it pages older history in, or when it found nothing.
  const [jump, setJump] = useState(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // The mode fullscreen returns to.
  const inlineModeRef = useRef(mode === 'fullscreen' ? 'collapsed' : mode);
  const netRef = useRef(getAgentNetwork());
  const pulseSeq = useRef(0);
  // Feed entries up to this seq were already there when the dock (or its
  // feed) appeared: they render in place instead of sliding in.
  const arriveRef = useRef(netRef.current.feedSeq);
  // Node ids drawn by the previous render; null until the graph is shown, so
  // the first drawing does not fade every box in.
  const knownRef = useRef(null);
  const detailRef = useRef(null);

  useEffect(() => {
    // The transcript may have synced before this effect subscribed: catch up.
    const current = getAgentNetwork();
    if (current !== netRef.current) {
      netRef.current = current;
      arriveRef.current = current.feedSeq;
    }
    setVersion(current.version);
    return subscribeAgentNetwork(onNetwork);
  }, []);

  function onNetwork(net, incoming) {
    if (net !== netRef.current) {
      // Another chat: keep the mode, forget the previous chat's selection.
      netRef.current = net;
      arriveRef.current = net.feedSeq;
      knownRef.current = null;
      setSelected(null);
      setOpen(new Set());
      setJump(null);
      setPulses([]);
      if (modeRef.current === 'fullscreen') setMode(inlineModeRef.current);
    }
    setVersion(net.version);
    if (!incoming.length || document.hidden) return;
    // Collapsed, the head's latest-message line is the animation.
    if (modeRef.current === 'collapsed') return;
    setPulses((list) => {
      const next = list.slice();
      for (const p of incoming) next.push(Object.assign({ key: ++pulseSeq.current }, p));
      return next.slice(-24);
    });
  }

  // A feed that appears shows what is there without sliding it in.
  const showFeed = () => { arriveRef.current = netRef.current.feedSeq; };
  const setInline = (next) => {
    inlineModeRef.current = next;
    writeExpanded(next === 'expanded');
    if (next === 'collapsed') setPulses([]);
    else showFeed();
    setMode(next);
  };
  const enterFullscreen = () => {
    if (mode !== 'fullscreen') inlineModeRef.current = mode;
    showFeed();
    setMode('fullscreen');
  };
  const exitFullscreen = () => {
    if (inlineModeRef.current === 'collapsed') setPulses([]);
    else showFeed();
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
    // `net` too: two chats can share a version and an agent count.
  }, [net, shown, mode, total, net.version, graphWidth]);

  // Remember which boxes this drawing showed, so only later ones fade in.
  useEffect(() => {
    knownRef.current = layout ? new Set(layout.nodes.map((n) => n.id)) : null;
  }, [layout]);

  // The selected agent's detail is above the feed and below the graph:
  // bring it into view when a box or a name in the feed selects an agent.
  useEffect(() => {
    if (!selected || !detailRef.current) return;
    try {
      detailRef.current.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    } catch { /* old browsers: no options */ }
  }, [selected, mode]);

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
  const labels = nodeLabels(net);
  const nodeLabel = (id) => (id ? labels.get(id) || 'agent' : 'all');
  const sel = selected && net.nodes.get(selected);
  const select = (id) => { setJump(null); setSelected(id); };
  const toggleSelect = (id) => select(selected === id ? null : id);
  const flashCard = (card) => {
    card.classList.remove('is-agent-flash');
    void card.offsetWidth;
    card.classList.add('is-agent-flash');
    setTimeout(() => card.classList.remove('is-agent-flash'), 1600);
  };
  const showInChat = (id) => {
    if (mode === 'fullscreen') exitFullscreen();
    // The transcript's own jump unpins it from the bottom (else the next
    // streamed row snaps back) and pages older history in until the card
    // or its top-level run card appears.
    const top = topLevelAncestor(net, net.nodes.get(id));
    if (!onJumpToToolCard) {
      const card = findAgentCard(transcriptRef && transcriptRef.current, net, id);
      if (card) { setJump(null); card.scrollIntoView({ block: 'center' }); flashCard(card); }
      else setJump({ id, state: 'missing' });
      return;
    }
    if (!top) { setJump({ id, state: 'missing' }); return; }
    setJump({ id, state: 'loading' });
    Promise.resolve(onJumpToToolCard(top.id, flashCard, (root) => findAgentCard(root, net, id))).then((found) => {
      if (netRef.current !== net) return;
      setJump(found ? null : { id, state: 'missing' });
    }, () => setJump({ id, state: 'missing' }));
  };
  // Selected, the feed lists only that agent's messages.
  const entries = sel ? net.feed.filter((f) => f.from === sel.id || f.to === sel.id) : net.feed;
  const feed = entries.slice(-FEED_SHOWN).reverse();
  const latest = net.feed.length ? net.feed[net.feed.length - 1] : null;
  const counts = total + (total === 1 ? ' agent' : ' agents');
  const arrives = (f) => f.live && f.seq > arriveRef.current;
  const toggleOpen = (seq) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(seq)) next.delete(seq); else next.add(seq);
    return next;
  });

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
      // A group, not an image: the agent boxes inside are buttons.
      role: 'group',
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
        return h('path', {
          key: e.id,
          d: edgePath(a, b, e.kind, layout),
          class: 'agent-net__edge agent-net__edge--' + e.kind + (live ? ' is-live' : ''),
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
          + (selected === n.id ? ' is-selected' : '')
          + (knownRef.current && !knownRef.current.has(n.id) ? ' is-new' : ''),
        // A CSS transform, so boxes glide to their new place when an agent
        // joins and the layout shifts.
        style: { transform: 'translate(' + n.x + 'px, ' + n.y + 'px)' },
        tabIndex: n.id === ROOT ? -1 : 0,
        role: n.id === ROOT ? null : 'button',
        'aria-pressed': n.id === ROOT ? null : String(selected === n.id),
        'aria-label': n.id === ROOT ? 'Main agent' : nodeLabel(n.id) + ', ' + (STATUS_TEXT[n.status] || n.status),
        onClick: () => n.id !== ROOT && toggleSelect(n.id),
        onKeyDown: (ev) => {
          if (n.id !== ROOT && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleSelect(n.id); }
        }
      },
        h('title', null, n.task ? short(n.task, 300) : nodeLabel(n.id)),
        h('rect', { class: 'agent-net__ring', x: -3, y: -3, width: nodeW + 6, height: NODE_H + 6, rx: 12 }),
        h('rect', { class: 'agent-net__box', width: nodeW, height: NODE_H, rx: 9 }),
        h('circle', { class: 'agent-net__status', cx: 13, cy: NODE_H / 2, r: 4 }),
        h('text', { class: 'agent-net__label', x: 24, y: 18 }, short(nodeLabel(n.id), labelMax)),
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

  const jumping = jump && jump.id === (sel && sel.id) ? jump.state : null;
  const detail = () => (sel ? h('div', { class: 'agent-net__detail', ref: detailRef },
    h('div', { class: 'agent-net__detail-head' },
      h('strong', null, nodeLabel(sel.id)),
      h('span', { class: 'agent-net__chip agent-net__chip--' + sel.status }, STATUS_TEXT[sel.status] || sel.status),
      sel.agent && sel.agent !== baseLabel(sel) ? h('span', { class: 'agent-net__meta' }, sel.agent) : null,
      sel.model ? h('span', { class: 'agent-net__meta' }, sel.model) : null,
      sel.groupId && net.groups.get(sel.groupId) && net.groups.get(sel.groupId).name
        ? h('span', { class: 'agent-net__meta' }, 'group ' + net.groups.get(sel.groupId).name) : null,
      sel.ghost ? null : h('button', {
        class: 'agent-net__link',
        type: 'button',
        disabled: jumping === 'loading',
        onClick: () => showInChat(sel.id)
      }, jumping === 'loading' ? 'Finding…' : 'Show in chat'),
      h('button', { class: 'agent-net__close', type: 'button', 'aria-label': 'Close agent details', title: 'Close', onClick: () => select(null) }, '×')
    ),
    jumping === 'missing' ? h('p', { class: 'agent-net__note', role: 'status' }, 'Its card is no longer in this chat.') : null,
    sel.task ? h('div', { class: 'agent-net__section' },
      h('div', { class: 'agent-net__section-title' }, 'Task'),
      h('p', { class: 'agent-net__task' }, sel.task)
    ) : null,
    sel.answer ? h('div', { class: 'agent-net__section' },
      h('div', { class: 'agent-net__section-title' }, sel.answerFailed ? 'Error' : 'Answer'),
      h('p', { class: 'agent-net__task agent-net__answer' + (sel.answerFailed ? ' agent-net__answer--error' : '') }, sel.answer)
    ) : null,
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

  // A sub-agent's name selects it; the main agent and a broadcast are text.
  const who = (id) => (id && id !== ROOT && net.nodes.has(id)
    ? h('button', { class: 'agent-net__who', type: 'button', 'aria-pressed': String(selected === id), onClick: () => toggleSelect(id) }, nodeLabel(id))
    : h('span', { class: 'agent-net__who agent-net__who--plain' }, nodeLabel(id)));
  const msgText = (f) => {
    if (!f.text) return null;
    const more = !!f.full && f.full !== f.text;
    if (!more) return h('span', { class: 'agent-net__msg-text' }, f.text);
    const isOpen = open.has(f.seq);
    // The whole row's text is the toggle: a tap reads the full message.
    return h('button', {
      class: 'agent-net__msg-text agent-net__msg-more' + (isOpen ? ' is-open' : ''),
      type: 'button',
      'aria-expanded': String(isOpen),
      onClick: () => toggleOpen(f.seq)
    }, isOpen ? f.full : f.text);
  };
  const feedList = () => (feed.length ? h('div', { class: 'agent-net__feed' },
    h('div', { class: 'agent-net__feed-title' },
      sel ? 'Messages of ' + nodeLabel(sel.id) : 'Messages',
      h('span', { class: 'agent-net__count' }, sel ? entries.length : net.feedSeq),
      sel ? h('button', { class: 'agent-net__all', type: 'button', onClick: () => select(null) }, 'Show all') : null
    ),
    h('ol', { class: 'agent-net__feed-list' },
      feed.map((f) => h('li', { key: f.seq, class: 'agent-net__msg agent-net__msg--' + f.kind + (arrives(f) ? ' is-arriving' : '') },
        h('span', { class: 'agent-net__msg-kind' }, KIND_TEXT[f.kind] || f.kind),
        who(f.from),
        f.to ? h('span', { class: 'agent-net__msg-arrow', 'aria-label': 'to' }, '→') : null,
        f.to ? who(f.to) : null,
        f.at ? h('time', { class: 'agent-net__msg-time', dateTime: new Date(f.at).toISOString() }, clockTime(f.at)) : null,
        msgText(f)
      ))
    )
  ) : (sel ? h('div', { class: 'agent-net__feed' },
    h('div', { class: 'agent-net__feed-title' },
      'Messages of ' + nodeLabel(sel.id),
      h('button', { class: 'agent-net__all', type: 'button', onClick: () => select(null) }, 'Show all')
    ),
    h('p', { class: 'agent-net__note' }, 'No recent messages.')
  ) : null));

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
  // Same status dot as a tool card: running while any agent is, red when an
  // agent of the latest turn that delegated failed, green otherwise. A
  // failure in an older turn no longer colours it.
  const pill = active ? ['tool-card__pill--busy', 'running'] : latestTurnFailed(net) ? ['tool-card__pill--err', 'failed'] : ['tool-card__pill--ok', 'done'];
  // Short enough for one line on a phone.
  const summary = active ? active + '/' + total + ' active' : counts;
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
      // The latest message between agents; re-keyed by its seq so each new
      // one slides in (only those that arrive while the dock is shown).
      h('span', {
        key: 'latest-' + (latest ? latest.seq : 0),
        class: 'tool-card__args agent-net__latest' + (latest ? ' agent-net__latest--' + latest.kind : '') + (latest && arrives(latest) ? ' is-arriving' : '')
      },
        latest ? [nodeLabel(latest.from), latest.to ? ' → ' + nodeLabel(latest.to) : '', latest.text ? ': ' + latest.text : ''].join('') : ''
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
