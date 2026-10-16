// Zero-dependency Mermaid diagram → SVG renderer for markdown blocks.
//
// Converts common LLM Mermaid schemas (flowchart/graph, sequenceDiagram,
// stateDiagram, classDiagram, erDiagram) into self-contained, escaped SVG
// strings that render cleanly on mobile and can be encoded as an inert
// `data:image/svg+xml;utf8,...` `<img class="md-diagram__img">` for one-tap
// full-screen zoom in the chat image lightbox.
//
// Safety contract:
//   - Every user/model text label is XML-escaped (`&`, `<`, `>`, `"`, `'`)
//     before being placed inside `<text>` or `<tspan>`.
//   - No raw HTML, `<foreignObject>`, `<script>`, external `href`/`xlink:href`,
//     or `on*` event attributes are ever emitted.
//   - If a diagram syntax is unrecognised or empty, `renderMermaidSvg` returns
//     `null` so the caller falls back to a standard `<pre><code>` block.

function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Palette tuned to match mouaif's dark theme tokens so the rendered SVG works
// both inline and inside the dark full-screen image lightbox (where CSS custom
// properties from the page are not inherited by an `<img>` data URI).
const PALETTE = {
  bg: '#131824',
  surface: '#1c2333',
  surfaceHi: '#273046',
  border: '#3b4866',
  accent: '#6ea8fe',
  accentSoft: '#1e2d4a',
  fg: '#eceaf1',
  fgSoft: '#b6bac9',
  muted: '#8b8a98',
  success: '#6fd49a',
  warning: '#f0c46a',
  fontSans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontMono: 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace'
};

function cleanLabel(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  // Convert literal `<br>` / `<br/>` / `\n` often emitted by LLMs in Mermaid labels into newlines
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n');
  return s.trim();
}

function wrapLines(text, maxChars = 26) {
  const rawLines = cleanLabel(text).split('\n');
  const out = [];
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      out.push(trimmed);
      continue;
    }
    const words = trimmed.split(/\s+/);
    let cur = '';
    for (const w of words) {
      if (!cur) {
        cur = w;
      } else if (cur.length + 1 + w.length <= maxChars) {
        cur += ' ' + w;
      } else {
        out.push(cur);
        cur = w;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

function measureBox(lines, minW = 92, minH = 40, padX = 24, padY = 16, charW = 7.4, lineH = 16) {
  const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const w = Math.max(minW, Math.ceil(maxLen * charW + padX));
  const h = Math.max(minH, Math.ceil(lines.length * lineH + padY));
  return { w, h };
}

function renderMultilineText(cx, cy, lines, opts = {}) {
  const fontSize = opts.fontSize || 12;
  const lineH = opts.lineH || 15;
  const fill = opts.fill || PALETTE.fg;
  const weight = opts.fontWeight || 500;
  const anchor = opts.anchor || 'middle';
  const fontFamily = opts.mono ? PALETTE.fontMono : PALETTE.fontSans;
  const startY = cy - ((lines.length - 1) * lineH) / 2 + fontSize * 0.35;
  if (lines.length === 1) {
    return `<text x="${cx}" y="${ startY.toFixed(1) }" text-anchor="${anchor}" fill="${fill}" font-family='${fontFamily}' font-size="${fontSize}" font-weight="${weight}">${escapeXml(lines[0])}</text>`;
  }
  const tspans = lines.map((line, idx) =>
    `<tspan x="${cx}" y="${(startY + idx * lineH).toFixed(1)}">${escapeXml(line)}</tspan>`
  ).join('');
  return `<text text-anchor="${anchor}" fill="${fill}" font-family='${fontFamily}' font-size="${fontSize}" font-weight="${weight}">${tspans}</text>`;
}

function svgDefs() {
  return (
    `<defs>` +
      `<marker id="md-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">` +
        `<path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="${PALETTE.accent}"/>` +
      `</marker>` +
      `<marker id="md-arrow-muted" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">` +
        `<path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="${PALETTE.fgSoft}"/>` +
      `</marker>` +
      `<marker id="md-arrow-open" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
        `<path d="M 1 1.5 L 8.5 5 L 1 8.5" fill="none" stroke="${PALETTE.accent}" stroke-width="1.6"/>` +
      `</marker>` +
    `</defs>`
  );
}

function wrapSvg(width, height, inner, ariaLabel) {
  const w = Math.max(160, Math.ceil(width));
  const h = Math.max(80, Math.ceil(height));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeXml(ariaLabel || 'Mermaid diagram')}">` +
      svgDefs() +
      `<rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="${PALETTE.bg}"/>` +
      inner +
    `</svg>`
  );
}

// ---- Preprocess lines -------------------------------------------------

function stripCommentsAndFrontmatter(source) {
  let text = String(source == null ? '' : source).replace(/\r\n?/g, '\n').trim();
  // Strip optional YAML frontmatter (`---\n...\n---`) or Mermaid directive (`%%{...}%%`)
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) text = text.slice(end + 4).trim();
  }
  text = text.replace(/%%\{[\s\S]*?\}%%/g, '');
  const lines = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('%%')) continue;
    lines.push(t);
  }
  return lines;
}

// ---- 1. Flowchart / Graph / StateDiagram ------------------------------

// Parse a node token like:
//   A["User Service"]
//   B(Round box)
//   C{Decision?}
//   D((Circle))
//   E([Stadium])
//   F[(Database)]
//   G
function parseNodeEndpoint(token) {
  const s = String(token || '').trim();
  if (!s) return null;

  // Match ID followed by shape delimiters
  const shapes = [
    { re: /^([A-Za-z0-9_.-]+)\s*\[\(([\s\S]+)\)\]$/, shape: 'cylinder' },
    { re: /^([A-Za-z0-9_.-]+)\s*\(\[([\s\S]+)\]\)$/, shape: 'stadium' },
    { re: /^([A-Za-z0-9_.-]+)\s*\(\(([\s\S]+)\)\)$/, shape: 'circle' },
    { re: /^([A-Za-z0-9_.-]+)\s*\{\{([\s\S]+)\}\}$/, shape: 'hexagon' },
    { re: /^([A-Za-z0-9_.-]+)\s*\[\[([\s\S]+)\]\]$/, shape: 'subroutine' },
    { re: /^([A-Za-z0-9_.-]+)\s*\{([\s\S]+)\}$/, shape: 'diamond' },
    { re: /^([A-Za-z0-9_.-]+)\s*\(([\s\S]+)\)$/, shape: 'round' },
    { re: /^([A-Za-z0-9_.-]+)\s*>([\s\S]+)\]$/, shape: 'asym' },
    { re: /^([A-Za-z0-9_.-]+)\s*\[([\s\S]+)\]$/, shape: 'rect' }
  ];
  for (const { re, shape } of shapes) {
    const m = re.exec(s);
    if (m) {
      return { id: m[1], label: cleanLabel(m[2]), shape };
    }
  }
  // State diagram start/end token `[*]`
  if (s === '[*]') {
    return { id: '[*]', label: '●', shape: 'circle-sm' };
  }
  // Bare identifier or quoted string
  const bare = /^([A-Za-z0-9_.-]+)$/.exec(s);
  if (bare) {
    return { id: bare[1], label: null, shape: null };
  }
  return { id: s, label: cleanLabel(s), shape: 'rect' };
}

// Split a flowchart statement into a chain of nodes and edges.
// Supports:
//   A --> B
//   A -->|label| B
//   A -- label --> B
//   A -.-> B
//   A -. label .-> B
//   A ==> B
//   A --- B
//   A --> B --> C
function parseFlowEdgesInLine(line, ensureNode, addEdge, currentGroup) {
  // Handle stateDiagram `StateId : description`
  const stateDesc = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line);
  if (stateDesc && !/-->|---|-\.->|==>/.test(line)) {
    const id = stateDesc[1];
    if (id.toLowerCase() === 'note') return false;
    ensureNode({ id, label: id + '\n' + cleanLabel(stateDesc[2]), shape: 'round' }, currentGroup);
    return true;
  }

  // Normalize `-- text -->`, `-. text .->`, `== text ==>` into `-->|text|`, `-.->|text|`, `==>|text|`
  let norm = line
    .replace(/--\s+([^->|][^->]*?)\s+-->/g, '-->|$1|')
    .replace(/--\s+([^->|][^->]*?)\s+---/g, '---|$1|')
    .replace(/-\.\s*([^.>|][^.>]*?)\s*\.->/g, '-.->|$1|')
    .replace(/==\s+([^=>|][^=>]*?)\s+==>/g, '==>|$1|');

  // State diagram `A --> B : label` syntax
  let trailingLabel = '';
  const colonArrow = /^([\s\S]+?(?:-->|-\.->|==>|---)[\s\S]+?)\s*:\s*([^:\n]+)$/.exec(norm);
  if (colonArrow && !/\|/.test(colonArrow[1])) {
    norm = colonArrow[1].trim();
    trailingLabel = cleanLabel(colonArrow[2]);
  }

  const edgeRe = /(<-->|<-\.->|<==>|-->|-\.->|==>|---|-.-|===|--o|--x)(?:\|([^|]*)\|)?/g;
  const parts = [];
  const connectors = [];
  let lastIdx = 0;
  let m;
  while ((m = edgeRe.exec(norm)) !== null) {
    parts.push(norm.slice(lastIdx, m.index).trim());
    connectors.push({
      op: m[1],
      label: m[2] != null ? cleanLabel(m[2]) : ''
    });
    lastIdx = m.index + m[0].length;
  }
  if (!connectors.length) return false;
  parts.push(norm.slice(lastIdx).trim());
  if (trailingLabel && connectors.length) {
    connectors[connectors.length - 1].label = trailingLabel;
  }

  // Each part may contain `&` parallel targets/sources: `A & B --> C`
  let prevGroup = null;
  for (let i = 0; i < parts.length; i++) {
    const subTokens = parts[i].split(/\s+&\s+/).map((t) => t.trim()).filter(Boolean);
    const resolved = [];
    for (const tok of subTokens) {
      const parsed = parseNodeEndpoint(tok);
      if (!parsed) continue;
      // Give start/end `[*]` distinct IDs depending on side
      if (parsed.id === '[*]') {
        parsed.id = i === 0 ? '__start__' : '__end__';
      }
      const node = ensureNode(parsed, currentGroup);
      resolved.push(node);
    }
    if (prevGroup && resolved.length) {
      const conn = connectors[i - 1];
      const dashed = conn.op.includes('.');
      const thick = conn.op.includes('=');
      const directed = conn.op.includes('>') || conn.op.endsWith('o') || conn.op.endsWith('x');
      for (const fromNode of prevGroup) {
        for (const toNode of resolved) {
          addEdge({
            from: fromNode.id,
            to: toNode.id,
            label: conn.label,
            dashed,
            thick,
            directed
          });
        }
      }
    }
    prevGroup = resolved;
  }
  return true;
}

function renderNodeShape(node) {
  const { x, y, w, h, shape, lines } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const fill = shape === 'diamond' ? PALETTE.accentSoft : PALETTE.surface;
  const stroke = shape === 'diamond' || shape === 'circle-sm' ? PALETTE.accent : PALETTE.border;
  let shapeSvg = '';

  if (shape === 'circle-sm') {
    const r = Math.min(w, h) / 2;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PALETTE.accent}" stroke="${PALETTE.fg}" stroke-width="2"/>`;
  }
  if (shape === 'diamond') {
    const pts = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
    shapeSvg = `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else if (shape === 'circle') {
    const r = Math.max(w, h) / 2;
    shapeSvg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else if (shape === 'stadium') {
    const rx = h / 2;
    shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else if (shape === 'cylinder') {
    const ry = 6;
    shapeSvg =
      `<path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
      `<ellipse cx="${cx}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${PALETTE.surfaceHi}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else if (shape === 'hexagon') {
    const inset = 12;
    const pts = `${x + inset},${y} ${x + w - inset},${y} ${x + w},${cy} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${cy}`;
    shapeSvg = `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  } else if (shape === 'subroutine') {
    shapeSvg =
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
      `<line x1="${x + 6}" y1="${y}" x2="${x + 6}" y2="${y + h}" stroke="${stroke}" stroke-width="1.2"/>` +
      `<line x1="${x + w - 6}" y1="${y}" x2="${x + w - 6}" y2="${y + h}" stroke="${stroke}" stroke-width="1.2"/>`;
  } else {
    const rx = shape === 'round' ? 10 : 6;
    shapeSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  }

  return `<g class="md-diagram-node">${shapeSvg}${renderMultilineText(cx, cy, lines)}</g>`;
}

function renderFlowchart(lines, isStateDiagram = false) {
  const header = lines[0];
  let direction = 'TD';
  const dirMatch = /^(?:flowchart|graph)\s+(TB|TD|BT|RL|LR)\b/i.exec(header);
  if (dirMatch) {
    direction = dirMatch[1].toUpperCase();
    if (direction === 'TB') direction = 'TD';
  }

  const nodes = new Map();
  const edges = [];
  const groups = [];
  const groupStack = [];

  function ensureNode(spec, group) {
    let existing = nodes.get(spec.id);
    if (!existing) {
      const isDot = spec.shape === 'circle-sm';
      const label = spec.label != null ? spec.label : spec.id;
      const wrapped = isDot ? [''] : wrapLines(label, 24);
      const isDiamond = spec.shape === 'diamond';
      const size = isDot
        ? { w: 18, h: 18 }
        : measureBox(
            wrapped,
            isDiamond ? 108 : 88,
            isDiamond ? 52 : 38,
            isDiamond ? 36 : 24,
            isDiamond ? 24 : 16
          );
      existing = {
        id: spec.id,
        label,
        lines: wrapped,
        shape: spec.shape || (isStateDiagram ? 'round' : 'rect'),
        w: size.w,
        h: size.h,
        group: group || null
      };
      nodes.set(spec.id, existing);
    } else {
      if (spec.label && existing.label === existing.id) {
        existing.label = spec.label;
        existing.lines = wrapLines(spec.label, 24);
        const isDiamond = (spec.shape || existing.shape) === 'diamond';
        const size = measureBox(
          existing.lines,
          isDiamond ? 108 : 88,
          isDiamond ? 52 : 38,
          isDiamond ? 36 : 24,
          isDiamond ? 24 : 16
        );
        existing.w = size.w;
        existing.h = size.h;
      }
      if (spec.shape) existing.shape = spec.shape;
      if (group && !existing.group) existing.group = group;
    }
    return existing;
  }

  function addEdge(edge) {
    edges.push(edge);
  }

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    // Split semicolon-separated statements on a single line
    const statements = rawLine.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      if (/^(?:classDef|class|style|linkStyle|click)\b/i.test(stmt)) continue;
      const dirOverride = /^direction\s+(TB|TD|BT|RL|LR)\b/i.exec(stmt);
      if (dirOverride) {
        direction = dirOverride[1].toUpperCase() === 'TB' ? 'TD' : dirOverride[1].toUpperCase();
        continue;
      }
      const subMatch = /^subgraph\s+([^\n]+)$/i.exec(stmt);
      if (subMatch) {
        const rawSub = subMatch[1].trim();
        const bracket = /^([A-Za-z0-9_.-]+)\s*\[([\s\S]+)\]$/.exec(rawSub);
        const g = {
          id: bracket ? bracket[1] : `sg_${groups.length}`,
          title: cleanLabel(bracket ? bracket[2] : rawSub),
          nodeIds: []
        };
        groups.push(g);
        groupStack.push(g);
        continue;
      }
      if (/^end\b/i.test(stmt)) {
        groupStack.pop();
        continue;
      }
      const activeGroup = groupStack.length ? groupStack[groupStack.length - 1] : null;
      if (parseFlowEdgesInLine(stmt, ensureNode, addEdge, activeGroup)) continue;

      // Standalone node declaration
      const single = parseNodeEndpoint(stmt);
      if (single && single.id) {
        ensureNode(single, activeGroup);
      }
    }
  }

  if (nodes.size === 0) return null;

  // Assign ranks (longest-path layering with cycle guard)
  const inDegree = new Map();
  const adj = new Map();
  for (const id of nodes.keys()) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (e.from === e.to) continue;
    adj.get(e.from)?.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
  }

  const rank = new Map();
  const visited = new Set();
  const queue = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      rank.set(id, 0);
      queue.push(id);
    }
  }
  // If all nodes are in a cycle, seed with the first node
  if (queue.length === 0) {
    const firstId = nodes.keys().next().value;
    rank.set(firstId, 0);
    queue.push(firstId);
  }

  while (queue.length) {
    const curr = queue.shift();
    visited.add(curr);
    const r = rank.get(curr) || 0;
    for (const next of adj.get(curr) || []) {
      if (visited.has(next)) continue;
      const nextRank = Math.max(rank.get(next) || 0, r + 1);
      rank.set(next, nextRank);
      inDegree.set(next, (inDegree.get(next) || 1) - 1);
      if (inDegree.get(next) <= 0) {
        queue.push(next);
      }
    }
    if (queue.length === 0 && visited.size < nodes.size) {
      for (const id of nodes.keys()) {
        if (!visited.has(id)) {
          if (!rank.has(id)) rank.set(id, r + 1);
          queue.push(id);
          break;
        }
      }
    }
  }

  // Group nodes by rank
  const layers = new Map();
  let maxRank = 0;
  for (const [id, node] of nodes.entries()) {
    const r = rank.get(id) || 0;
    if (r > maxRank) maxRank = r;
    if (!layers.has(r)) layers.set(r, []);
    layers.get(r).push(node);
  }

  const isHorizontal = direction === 'LR' || direction === 'RL';
  const isReversed = direction === 'BT' || direction === 'RL';
  const padOuter = 24;
  const rankGap = isHorizontal ? 68 : 54;
  const nodeGap = isHorizontal ? 26 : 28;

  // Order layer indices
  const layerOrder = [];
  for (let r = 0; r <= maxRank; r++) {
    if (layers.has(r)) layerOrder.push(r);
  }
  if (isReversed) layerOrder.reverse();

  let totalW = 0;
  let totalH = 0;

  if (!isHorizontal) {
    // Top-Down / Bottom-Up layout
    const layerMetrics = layerOrder.map((r) => {
      const list = layers.get(r);
      const w = list.reduce((sum, n) => sum + n.w, 0) + Math.max(0, list.length - 1) * nodeGap;
      const h = list.reduce((m, n) => Math.max(m, n.h), 0);
      return { r, list, w, h };
    });
    const maxLayerW = layerMetrics.reduce((m, l) => Math.max(m, l.w), 0);
    totalW = Math.max(220, maxLayerW + padOuter * 2);
    let cursorY = padOuter + (groups.length ? 14 : 0);
    for (const lm of layerMetrics) {
      let cursorX = (totalW - lm.w) / 2;
      for (const n of lm.list) {
        n.x = cursorX;
        n.y = cursorY + (lm.h - n.h) / 2;
        cursorX += n.w + nodeGap;
      }
      cursorY += lm.h + rankGap;
    }
    totalH = cursorY - rankGap + padOuter;
  } else {
    // Left-Right / Right-Left layout
    const layerMetrics = layerOrder.map((r) => {
      const list = layers.get(r);
      const w = list.reduce((m, n) => Math.max(m, n.w), 0);
      const h = list.reduce((sum, n) => sum + n.h, 0) + Math.max(0, list.length - 1) * nodeGap;
      return { r, list, w, h };
    });
    const maxLayerH = layerMetrics.reduce((m, l) => Math.max(m, l.h), 0);
    totalH = Math.max(120, maxLayerH + padOuter * 2 + (groups.length ? 16 : 0));
    let cursorX = padOuter;
    for (const lm of layerMetrics) {
      let cursorY = (totalH - lm.h) / 2 + (groups.length ? 8 : 0);
      for (const n of lm.list) {
        n.x = cursorX + (lm.w - n.w) / 2;
        n.y = cursorY;
        cursorY += n.h + nodeGap;
      }
      cursorX += lm.w + rankGap;
    }
    totalW = cursorX - rankGap + padOuter;
  }

  // Render subgraph containers behind nodes
  const groupSvgs = [];
  for (const g of groups) {
    const members = Array.from(nodes.values()).filter((n) => n.group === g);
    if (!members.length) continue;
    const minX = Math.min(...members.map((n) => n.x)) - 12;
    const minY = Math.min(...members.map((n) => n.y)) - 24;
    const maxX = Math.max(...members.map((n) => n.x + n.w)) + 12;
    const maxY = Math.max(...members.map((n) => n.y + n.h)) + 10;
    const gw = maxX - minX;
    const gh = maxY - minY;
    groupSvgs.push(
      `<g class="md-diagram-subgraph">` +
        `<rect x="${minX}" y="${minY}" width="${gw}" height="${gh}" rx="8" fill="${PALETTE.surfaceHi}" fill-opacity="0.38" stroke="${PALETTE.border}" stroke-dasharray="4 3" stroke-width="1.2"/>` +
        `<text x="${minX + 10}" y="${minY + 15}" fill="${PALETTE.fgSoft}" font-family='${PALETTE.fontSans}' font-size="11" font-weight="600">${escapeXml(g.title)}</text>` +
      `</g>`
    );
  }

  // Render edges
  const edgeSvgs = [];
  for (const e of edges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to) continue;

    let x1, y1, x2, y2;
    if (!isHorizontal) {
      const goingDown = from.y <= to.y;
      if (from.id === to.id) {
        x1 = from.x + from.w;
        y1 = from.y + from.h / 2;
        x2 = from.x + from.w / 2;
        y2 = from.y;
      } else if (Math.abs(from.y - to.y) < 10) {
        // Same rank
        const goingRight = from.x <= to.x;
        x1 = goingRight ? from.x + from.w : from.x;
        y1 = from.y + from.h / 2;
        x2 = goingRight ? to.x : to.x + to.w;
        y2 = to.y + to.h / 2;
      } else {
        x1 = from.x + from.w / 2;
        y1 = goingDown ? from.y + from.h : from.y;
        x2 = to.x + to.w / 2;
        y2 = goingDown ? to.y : to.y + to.h;
      }
    } else {
      const goingRight = from.x <= to.x;
      if (Math.abs(from.x - to.x) < 10 && from.id !== to.id) {
        const goingDown = from.y <= to.y;
        x1 = from.x + from.w / 2;
        y1 = goingDown ? from.y + from.h : from.y;
        x2 = to.x + to.w / 2;
        y2 = goingDown ? to.y : to.y + to.h;
      } else {
        x1 = goingRight ? from.x + from.w : from.x;
        y1 = from.y + from.h / 2;
        x2 = goingRight ? to.x : to.x + to.w;
        y2 = to.y + to.h / 2;
      }
    }

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    let d;
    if (!isHorizontal) {
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${midY.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    } else {
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${midX.toFixed(1)} ${y1.toFixed(1)}, ${midX.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }

    const dashAttr = e.dashed ? ` stroke-dasharray="5 4"` : '';
    const strokeW = e.thick ? '2.4' : '1.6';
    const markerAttr = e.directed ? ` marker-end="url(#md-arrow)"` : '';
    edgeSvgs.push(
      `<path d="${d}" fill="none" stroke="${PALETTE.accent}" stroke-width="${strokeW}"${dashAttr}${markerAttr}/>`
    );

    if (e.label) {
      const labelW = Math.max(28, e.label.length * 6.5 + 12);
      const labelH = 18;
      edgeSvgs.push(
        `<g class="md-diagram-edge-label">` +
          `<rect x="${(midX - labelW / 2).toFixed(1)}" y="${(midY - labelH / 2).toFixed(1)}" width="${labelW.toFixed(1)}" height="${labelH}" rx="4" fill="${PALETTE.bg}" stroke="${PALETTE.border}" stroke-width="1"/>` +
          `<text x="${midX.toFixed(1)}" y="${(midY + 3.8).toFixed(1)}" text-anchor="middle" fill="${PALETTE.fgSoft}" font-family='${PALETTE.fontSans}' font-size="10.5">${escapeXml(e.label)}</text>` +
        `</g>`
      );
    }
  }

  const nodeSvgs = Array.from(nodes.values()).map(renderNodeShape);
  return wrapSvg(
    totalW,
    totalH,
    groupSvgs.join('') + edgeSvgs.join('') + nodeSvgs.join(''),
    isStateDiagram ? 'State diagram' : 'Flowchart diagram'
  );
}

// ---- 2. Sequence Diagram ----------------------------------------------

function renderSequenceDiagram(lines) {
  const participants = new Map();
  const events = [];

  function ensureParticipant(id, label) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return null;
    if (!participants.has(cleanId)) {
      participants.set(cleanId, {
        id: cleanId,
        label: cleanLabel(label || cleanId)
      });
    } else if (label) {
      participants.get(cleanId).label = cleanLabel(label);
    }
    return participants.get(cleanId);
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?:autonumber|activate|deactivate|loop|alt|else|opt|par|and|rect|end)\b/i.test(line)) {
      const blockMatch = /^(loop|alt|else|opt|par)\s+(.+)$/i.exec(line);
      if (blockMatch) {
        events.push({ type: 'divider', tag: blockMatch[1].toUpperCase(), text: cleanLabel(blockMatch[2]) });
      }
      continue;
    }

    const partMatch = /^(?:participant|actor)\s+([^\s]+?)(?:\s+as\s+(.+))?$/i.exec(line);
    if (partMatch) {
      ensureParticipant(partMatch[1], partMatch[2] || partMatch[1]);
      continue;
    }

    const noteMatch = /^note\s+(?:left of|right of|over)\s+([^:]+):\s*(.+)$/i.exec(line);
    if (noteMatch) {
      const targets = noteMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const t of targets) ensureParticipant(t);
      events.push({
        type: 'note',
        targets,
        text: cleanLabel(noteMatch[2])
      });
      continue;
    }

    // Message arrow: A ->> B: message, A -->> B: msg, A -> B: msg, etc.
    const msgMatch = /^([A-Za-z0-9_.-]+|"[^"]+")\s*(--?>>|--?>|--?\)|--?x)\+?(-?)\s*([A-Za-z0-9_.-]+|"[^"]+")\s*:\s*(.*)$/.exec(line);
    if (msgMatch) {
      const fromId = cleanLabel(msgMatch[1]);
      const arrow = msgMatch[2];
      const toId = cleanLabel(msgMatch[4]);
      const text = cleanLabel(msgMatch[5]);
      ensureParticipant(fromId);
      ensureParticipant(toId);
      events.push({
        type: 'msg',
        from: fromId,
        to: toId,
        dashed: arrow.startsWith('--'),
        text
      });
    }
  }

  if (participants.size === 0) return null;

  const partList = Array.from(participants.values());
  const boxH = 36;
  const padX = 24;
  const padY = 20;

  // Compute column widths and centers based on participant labels and message widths
  const colWidths = partList.map((p) => Math.max(96, p.label.length * 7.5 + 28));
  let minSpan = 136;
  for (const ev of events) {
    if (ev.type === 'msg' && ev.text) {
      minSpan = Math.max(minSpan, Math.min(240, ev.text.length * 6.4 + 36));
    }
  }

  const centers = [];
  let cursorX = padX;
  for (let i = 0; i < partList.length; i++) {
    const half = colWidths[i] / 2;
    if (i === 0) {
      centers.push(cursorX + half);
    } else {
      const prevCenter = centers[i - 1];
      const step = Math.max(minSpan, (colWidths[i - 1] + colWidths[i]) / 2 + 28);
      centers.push(prevCenter + step);
    }
  }

  const lastIdx = partList.length - 1;
  const totalW = Math.max(220, centers[lastIdx] + colWidths[lastIdx] / 2 + padX);
  const indexOf = new Map(partList.map((p, idx) => [p.id, idx]));

  const headerBottom = padY + boxH;
  let cursorY = headerBottom + 28;
  const eventSvgs = [];

  for (const ev of events) {
    if (ev.type === 'divider') {
      const label = `[${ev.tag}] ${ev.text}`;
      eventSvgs.push(
        `<rect x="${padX}" y="${cursorY - 12}" width="${totalW - padX * 2}" height="22" rx="4" fill="${PALETTE.surfaceHi}" fill-opacity="0.6" stroke="${PALETTE.border}" stroke-dasharray="3 3"/>` +
        `<text x="${padX + 10}" y="${cursorY + 3}" fill="${PALETTE.warning}" font-family='${PALETTE.fontMono}' font-size="10.5" font-weight="600">${escapeXml(label)}</text>`
      );
      cursorY += 32;
      continue;
    }

    if (ev.type === 'note') {
      const idxs = ev.targets.map((t) => indexOf.get(t)).filter((n) => n != null);
      const cx = idxs.length
        ? (centers[Math.min(...idxs)] + centers[Math.max(...idxs)]) / 2
        : totalW / 2;
      const linesWrap = wrapLines(ev.text, 30);
      const { w, h } = measureBox(linesWrap, 110, 28, 20, 12, 6.8, 14);
      eventSvgs.push(
        `<rect x="${(cx - w / 2).toFixed(1)}" y="${cursorY - 8}" width="${w}" height="${h}" rx="4" fill="${PALETTE.accentSoft}" stroke="${PALETTE.accent}" stroke-width="1"/>` +
        renderMultilineText(cx, cursorY - 8 + h / 2, linesWrap, { fontSize: 11, fill: PALETTE.fg })
      );
      cursorY += h + 18;
      continue;
    }

    if (ev.type === 'msg') {
      const fromIdx = indexOf.get(ev.from) ?? 0;
      const toIdx = indexOf.get(ev.to) ?? 0;
      const x1 = centers[fromIdx];
      const x2 = centers[toIdx];
      const dash = ev.dashed ? ` stroke-dasharray="5 4"` : '';

      if (fromIdx === toIdx) {
        // Self-call loop
        const loopW = 36;
        const loopH = 22;
        if (ev.text) {
          eventSvgs.push(
            `<text x="${x1 + 8}" y="${cursorY - 5}" fill="${PALETTE.fg}" font-family='${PALETTE.fontSans}' font-size="11">${escapeXml(ev.text)}</text>`
          );
        }
        eventSvgs.push(
          `<path d="M ${x1} ${cursorY} L ${x1 + loopW} ${cursorY} L ${x1 + loopW} ${cursorY + loopH} L ${x1} ${cursorY + loopH}" fill="none" stroke="${PALETTE.accent}" stroke-width="1.5"${dash} marker-end="url(#md-arrow)"/>`
        );
        cursorY += loopH + 24;
      } else {
        const midX = (x1 + x2) / 2;
        if (ev.text) {
          eventSvgs.push(
            `<text x="${midX.toFixed(1)}" y="${cursorY - 6}" text-anchor="middle" fill="${PALETTE.fg}" font-family='${PALETTE.fontSans}' font-size="11">${escapeXml(ev.text)}</text>`
          );
        }
        eventSvgs.push(
          `<line x1="${x1}" y1="${cursorY}" x2="${x2}" y2="${cursorY}" stroke="${PALETTE.accent}" stroke-width="1.6"${dash} marker-end="url(#md-arrow)"/>`
        );
        cursorY += 34;
      }
    }
  }

  const footerTop = cursorY + 4;
  const totalH = footerTop + boxH + padY;

  const lifelines = partList.map((p, idx) => {
    const cx = centers[idx];
    const w = colWidths[idx];
    const x = cx - w / 2;
    return (
      `<line x1="${cx}" y1="${headerBottom}" x2="${cx}" y2="${footerTop}" stroke="${PALETTE.border}" stroke-width="1.3" stroke-dasharray="4 4"/>` +
      `<rect x="${x.toFixed(1)}" y="${padY}" width="${w.toFixed(1)}" height="${boxH}" rx="6" fill="${PALETTE.surface}" stroke="${PALETTE.border}" stroke-width="1.5"/>` +
      renderMultilineText(cx, padY + boxH / 2, [p.label], { fontWeight: 600 }) +
      `<rect x="${x.toFixed(1)}" y="${footerTop}" width="${w.toFixed(1)}" height="${boxH}" rx="6" fill="${PALETTE.surface}" stroke="${PALETTE.border}" stroke-width="1.5"/>` +
      renderMultilineText(cx, footerTop + boxH / 2, [p.label], { fontWeight: 600 })
    );
  });

  return wrapSvg(totalW, totalH, lifelines.join('') + eventSvgs.join(''), 'Sequence diagram');
}

// ---- 3. Class & ER Diagrams -------------------------------------------

function renderBoxRelationDiagram(lines, kind) {
  const entities = new Map();
  const relations = [];
  let activeEntity = null;

  function ensureEntity(name) {
    const clean = cleanLabel(name);
    if (!clean) return null;
    if (!entities.has(clean)) {
      entities.set(clean, { name: clean, members: [] });
    }
    return entities.get(clean);
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (activeEntity) {
      if (line === '}' || line.endsWith('}')) {
        activeEntity = null;
      } else {
        activeEntity.members.push(line);
      }
      continue;
    }

    const openBlock = /^(?:class\s+)?([A-Za-z0-9_.-]+)\s*\{\s*$/.exec(line);
    if (openBlock) {
      activeEntity = ensureEntity(openBlock[1]);
      continue;
    }

    const classDecl = /^class\s+([A-Za-z0-9_.-]+)$/.exec(line);
    if (classDecl) {
      ensureEntity(classDecl[1]);
      continue;
    }

    const memberColon = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line);
    if (memberColon && !/--|\.\./.test(memberColon[1])) {
      const ent = ensureEntity(memberColon[1]);
      if (ent) ent.members.push(memberColon[2].trim());
      continue;
    }

    // ER relationship: A ||--o{ B : "places"
    const erRel = /^([A-Za-z0-9_.-]+)\s+([|o}{]+(?:--|\.\.)[|o}{]+)\s+([A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/.exec(line);
    if (erRel) {
      ensureEntity(erRel[1]);
      ensureEntity(erRel[3]);
      relations.push({
        from: erRel[1],
        to: erRel[3],
        label: cleanLabel(erRel[4] || erRel[2])
      });
      continue;
    }

    // Class relationship: A <|-- B : label, A --> B, A *-- B
    const clsRel = /^([A-Za-z0-9_.-]+)\s+(<\|--|--\|>|\*--|o--|<--|--\*|--o|-->|\.\.>|<\|..|\.\.\|>|--|\.\.)\s+([A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/.exec(line);
    if (clsRel) {
      ensureEntity(clsRel[1]);
      ensureEntity(clsRel[3]);
      relations.push({
        from: clsRel[1],
        to: clsRel[3],
        label: cleanLabel(clsRel[4] || '')
      });
    }
  }

  if (entities.size === 0) return null;

  const list = Array.from(entities.values());
  const padOuter = 24;
  const colGap = 54;
  const rowGap = 48;
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(list.length))));

  for (const ent of list) {
    const maxChars = Math.max(
      ent.name.length + 4,
      ...ent.members.map((m) => m.length)
    );
    ent.w = Math.max(130, Math.ceil(maxChars * 7.2 + 28));
    ent.h = 34 + (ent.members.length ? ent.members.length * 18 + 12 : 8);
  }

  const rows = [];
  for (let i = 0; i < list.length; i += cols) {
    rows.push(list.slice(i, i + cols));
  }

  let totalW = 240;
  let cursorY = padOuter;
  for (const row of rows) {
    const rowW = row.reduce((s, e) => s + e.w, 0) + (row.length - 1) * colGap;
    totalW = Math.max(totalW, rowW + padOuter * 2);
  }

  for (const row of rows) {
    const rowW = row.reduce((s, e) => s + e.w, 0) + (row.length - 1) * colGap;
    const rowH = row.reduce((m, e) => Math.max(m, e.h), 0);
    let cursorX = (totalW - rowW) / 2;
    for (const ent of row) {
      ent.x = cursorX;
      ent.y = cursorY;
      cursorX += ent.w + colGap;
    }
    cursorY += rowH + rowGap;
  }
  const totalH = cursorY - rowGap + padOuter;

  const relSvgs = [];
  for (const rel of relations) {
    const a = entities.get(rel.from);
    const b = entities.get(rel.to);
    if (!a || !b || a === b) continue;
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h / 2;
    const x2 = b.x + b.w / 2;
    const y2 = b.y + b.h / 2;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    relSvgs.push(
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${PALETTE.accent}" stroke-width="1.6"/>`
    );
    if (rel.label) {
      const lw = Math.max(28, rel.label.length * 6.5 + 12);
      relSvgs.push(
        `<rect x="${(midX - lw / 2).toFixed(1)}" y="${(midY - 9).toFixed(1)}" width="${lw.toFixed(1)}" height="18" rx="4" fill="${PALETTE.bg}" stroke="${PALETTE.border}"/>` +
        `<text x="${midX.toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" text-anchor="middle" fill="${PALETTE.fgSoft}" font-family='${PALETTE.fontMono}' font-size="10">${escapeXml(rel.label)}</text>`
      );
    }
  }

  const boxSvgs = list.map((ent) => {
    const headerH = 30;
    const memberSvg = ent.members.map((m, idx) =>
      `<text x="${ent.x + 12}" y="${ent.y + headerH + 16 + idx * 18}" fill="${PALETTE.fgSoft}" font-family='${PALETTE.fontMono}' font-size="11">${escapeXml(m)}</text>`
    ).join('');
    return (
      `<g class="md-diagram-entity">` +
        `<rect x="${ent.x}" y="${ent.y}" width="${ent.w}" height="${ent.h}" rx="6" fill="${PALETTE.surface}" stroke="${PALETTE.border}" stroke-width="1.5"/>` +
        `<line x1="${ent.x}" y1="${ent.y + headerH}" x2="${ent.x + ent.w}" y2="${ent.y + headerH}" stroke="${PALETTE.border}" stroke-width="1"/>` +
        `<text x="${ent.x + ent.w / 2}" y="${ent.y + 19}" text-anchor="middle" fill="${PALETTE.fg}" font-family='${PALETTE.fontSans}' font-size="12" font-weight="700">${escapeXml(ent.name)}</text>` +
        memberSvg +
      `</g>`
    );
  });

  return wrapSvg(totalW, totalH, relSvgs.join('') + boxSvgs.join(''), kind === 'er' ? 'Entity relationship diagram' : 'Class diagram');
}

// ---- Public entrypoints -----------------------------------------------

export function isMermaidLanguage(lang) {
  const clean = String(lang || '').trim().toLowerCase();
  return clean === 'mermaid' || clean === 'mmd';
}

export function renderMermaidSvg(source) {
  const lines = stripCommentsAndFrontmatter(source);
  if (!lines.length) return null;

  const first = lines[0];
  if (/^(?:flowchart|graph)\b/i.test(first)) {
    return renderFlowchart(lines, false);
  }
  if (/^stateDiagram(?:-v2)?\b/i.test(first)) {
    return renderFlowchart(lines, true);
  }
  if (/^sequenceDiagram\b/i.test(first)) {
    return renderSequenceDiagram(lines);
  }
  if (/^classDiagram\b/i.test(first)) {
    return renderBoxRelationDiagram(lines, 'class');
  }
  if (/^erDiagram\b/i.test(first)) {
    return renderBoxRelationDiagram(lines, 'er');
  }
  return null;
}

export function svgToDataUrl(svgString) {
  if (!svgString) return '';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svgString);
}

// ---- 4. Subagent structure & communication schema generators ----------
//
// Builds Mermaid flowchart / sequenceDiagram schemas from subagent
// orchestration tool payloads (`subagent_group_create`, `subagent_group_status`,
// `subagent_group_update`, `subagent_status`, `subagent_messages`,
// `subagent_send`, `subagent_publish`, `subagent_read`, `subagent_decision`,
// `subagent_conflict`) and from complex nested `subagent` transcripts that
// spawn child subagents or exchange coordination messages.

function sanitizeMermaidId(raw, fallback = 'node') {
  const s = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z_]+/, '');
  return s || fallback;
}

function sanitizeMermaidLabel(raw, maxLen = 46) {
  let s = String(raw == null ? '' : raw)
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/["[\]{}()<>|]/g, '')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

function buildGroupSchema(r, args) {
  const src = (r && typeof r === 'object' && !r.error) ? r : {};
  const argObj = (args && typeof args === 'object') ? args : {};

  // Multi-group overview (`subagent_group_status` with `groups: [...]`)
  if (Array.isArray(src.groups) && src.groups.length) {
    const lines = ['flowchart TD', '  Parent(["Parent Coordinator"])'];
    src.groups.forEach((g, gi) => {
      if (!g || typeof g !== 'object') return;
      const gid = sanitizeMermaidId(g.name || g.groupId || ('group_' + gi), 'group_' + gi);
      const gTitle = sanitizeMermaidLabel((g.name || g.groupId || 'Group') + (g.state ? ' · ' + g.state : ''), 40);
      lines.push(`  subgraph ${gid}[${gTitle}]`);
      const members = Array.isArray(g.members) ? g.members : [];
      if (!members.length) {
        lines.push(`    ${gid}_empty["No members"]`);
      } else {
        for (const m of members) {
          if (!m || !m.memberId) continue;
          const mid = sanitizeMermaidId(gid + '_' + m.memberId);
          const mLabel = sanitizeMermaidLabel(m.memberId + (m.state ? ' [' + m.state + ']' : ''), 34);
          lines.push(`    ${mid}["${mLabel}"]`);
        }
      }
      lines.push('  end');
      if (members.length && members[0]?.memberId) {
        lines.push(`  Parent --> ${sanitizeMermaidId(gid + '_' + members[0].memberId)}`);
      }
    });
    return lines.join('\n');
  }

  const members = Array.isArray(src.members)
    ? src.members
    : (Array.isArray(argObj.members) ? argObj.members : []);
  const decisions = Array.isArray(src.decisions) ? src.decisions : [];
  const conflicts = Array.isArray(src.conflicts)
    ? src.conflicts
    : (src.conflict && typeof src.conflict === 'object' ? [src.conflict] : []);
  const artifacts = Array.isArray(src.artifacts) ? src.artifacts : [];

  if (!members.length && !decisions.length && !conflicts.length && !artifacts.length) {
    if (argObj.action && (argObj.name || argObj.groupId)) {
      const act = sanitizeMermaidLabel(argObj.action.toUpperCase(), 20);
      const target = sanitizeMermaidLabel(argObj.name || argObj.groupId || 'group', 32);
      const contract = sanitizeMermaidLabel(argObj.contract || src.state || '', 38);
      return [
        'sequenceDiagram',
        '  participant Parent as Parent',
        '  participant Group as Group (' + sanitizeMermaidLabel(argObj.groupId || 'group', 22) + ')',
        '  Parent ->> Group: ' + act + ' ' + target,
        ...(contract ? ['  Note over Parent,Group: ' + contract] : [])
      ].join('\n');
    }
    return null;
  }

  const groupTitle = sanitizeMermaidLabel(
    (src.name || argObj.name || src.groupId || argObj.groupId || 'Group') +
    (src.state ? ' · ' + src.state : ''),
    42
  );
  const lines = ['flowchart TD'];
  const sgId = sanitizeMermaidId(src.name || argObj.name || 'group', 'group');

  if (members.length) {
    lines.push(`  subgraph ${sgId}[${groupTitle}]`);
    const memberIds = new Set();
    for (const m of members) {
      if (!m || !m.memberId) continue;
      memberIds.add(m.memberId);
      const mid = 'm_' + sanitizeMermaidId(m.memberId);
      const stateTag = m.state ? ` [${m.state}]` : '';
      const roleLine = m.role ? `\\n${sanitizeMermaidLabel(m.role, 28)}` : '';
      lines.push(`    ${mid}["${sanitizeMermaidLabel(m.memberId + stateTag, 32)}${roleLine}"]`);
    }
    lines.push('  end');

    let hasDeps = false;
    for (const m of members) {
      if (!m || !m.memberId) continue;
      const toId = 'm_' + sanitizeMermaidId(m.memberId);
      const deps = Array.isArray(m.dependsOn) ? m.dependsOn : [];
      for (const dep of deps) {
        if (!memberIds.has(dep)) continue;
        hasDeps = true;
        const fromId = 'm_' + sanitizeMermaidId(dep);
        lines.push(`  ${fromId} -->|depends| ${toId}`);
      }
    }
    if (!hasDeps && members.length > 1) {
      lines.unshift('  Parent(["Parent Coordinator"])');
      lines[0] = 'flowchart TD';
      for (const m of members) {
        if (!m || !m.memberId) continue;
        lines.push(`  Parent --> m_${sanitizeMermaidId(m.memberId)}`);
      }
    }
  } else {
    lines.push(`  GroupNode(["${groupTitle}"])`);
  }

  decisions.slice(0, 6).forEach((d, idx) => {
    if (!d || typeof d !== 'object') return;
    const did = `dec_${idx}`;
    const dLabel = sanitizeMermaidLabel(`Decision: ${d.name || idx} [${d.state || 'proposed'}]`, 34);
    lines.push(`  ${did}{"${dLabel}"}`);
    const authorId = d.author && d.author !== 'parent' && members.some((m) => m && m.memberId === d.author)
      ? 'm_' + sanitizeMermaidId(d.author)
      : (members[0]?.memberId ? 'm_' + sanitizeMermaidId(members[0].memberId) : 'GroupNode');
    lines.push(`  ${authorId} -.->|${sanitizeMermaidLabel(d.state || 'propose', 16)}| ${did}`);
  });

  conflicts.slice(0, 6).forEach((c, idx) => {
    if (!c || typeof c !== 'object') return;
    const cid = `conf_${idx}`;
    const cLabel = sanitizeMermaidLabel(`Conflict: ${c.name || idx} [${c.state || 'open'}]`, 34);
    lines.push(`  ${cid}(("${cLabel}"))`);
    const involved = Array.isArray(c.members) ? c.members : [];
    let linked = false;
    for (const mem of involved) {
      if (members.some((m) => m && m.memberId === mem)) {
        lines.push(`  m_${sanitizeMermaidId(mem)} -.->|conflict| ${cid}`);
        linked = true;
      }
    }
    if (!linked) {
      const fallbackNode = members[0]?.memberId ? 'm_' + sanitizeMermaidId(members[0].memberId) : 'GroupNode';
      lines.push(`  ${fallbackNode} -.->|conflict| ${cid}`);
    }
  });

  artifacts.slice(0, 6).forEach((art, idx) => {
    const aName = typeof art === 'string' ? art : (art && art.name);
    if (!aName) return;
    const aid = `art_${idx}`;
    lines.push(`  ${aid}[("Handoff: ${sanitizeMermaidLabel(aName, 26)}")]`);
    const lastMember = members.length ? 'm_' + sanitizeMermaidId(members[members.length - 1].memberId) : 'GroupNode';
    lines.push(`  ${lastMember} -.->|publish| ${aid}`);
  });

  return lines.join('\n');
}

function buildStatusSchema(r, args) {
  const src = (r && typeof r === 'object' && !r.error) ? r : null;
  if (!src) return null;
  const runs = Array.isArray(src.runs) ? src.runs : (src.callId ? [src] : []);
  const escalations = Array.isArray(src.escalations) ? src.escalations : [];
  if (!runs.length && !escalations.length) return null;

  const lines = ['flowchart TD', '  Parent(["Parent Coordinator"])'];
  const knownIds = new Set(['Parent']);

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || typeof run !== 'object') continue;
    const nid = 'run_' + sanitizeMermaidId(run.callId || ('w_' + i));
    knownIds.add(nid);
    const title = run.memberId || run.agent || run.callId || ('worker-' + (i + 1));
    const state = run.state || 'running';
    const sub = run.lastLine ? `\\n${sanitizeMermaidLabel(run.lastLine, 26)}` : '';
    lines.push(`  ${nid}["${sanitizeMermaidLabel(title + ' [' + state + ']', 32)}${sub}"]`);
  }

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || typeof run !== 'object') continue;
    const nid = 'run_' + sanitizeMermaidId(run.callId || ('w_' + i));
    const parentCand = run.parentCallId ? 'run_' + sanitizeMermaidId(run.parentCallId) : 'Parent';
    const fromId = knownIds.has(parentCand) ? parentCand : 'Parent';
    const edgeLabel = run.groupId ? sanitizeMermaidLabel(run.memberId || 'member', 18) : (run.agent ? sanitizeMermaidLabel(run.agent, 18) : 'delegate');
    lines.push(`  ${fromId} -->|${edgeLabel}| ${nid}`);
    if (Array.isArray(run.published)) {
      run.published.slice(0, 4).forEach((artName, aIdx) => {
        const aid = `${nid}_art_${aIdx}`;
        lines.push(`  ${aid}[("${sanitizeMermaidLabel(artName, 24)}")]`);
        lines.push(`  ${nid} -.->|publish| ${aid}`);
      });
    }
  }

  escalations.slice(0, 4).forEach((esc, idx) => {
    if (!esc || typeof esc !== 'object') return;
    const eid = `esc_${idx}`;
    lines.push(`  ${eid}{"Conflict: ${sanitizeMermaidLabel(esc.name || 'escalated', 26)}"}`);
    const srcNode = esc.sourceCallId && knownIds.has('run_' + sanitizeMermaidId(esc.sourceCallId))
      ? 'run_' + sanitizeMermaidId(esc.sourceCallId)
      : 'Parent';
    lines.push(`  ${srcNode} -.->|escalate| ${eid}`);
  });

  return lines.join('\n');
}

function buildMessagesSchema(r, args) {
  const src = (r && typeof r === 'object' && !r.error) ? r : {};
  const argObj = (args && typeof args === 'object') ? args : {};
  const callId = sanitizeMermaidLabel(src.callId || argObj.callId || 'worker', 24);
  const state = src.state ? ` (${sanitizeMermaidLabel(src.state, 16)})` : '';
  const msgLines = Array.isArray(src.lines) ? src.lines : [];
  const deliveries = Array.isArray(src.deliveries) ? src.deliveries : [];

  const seq = [
    'sequenceDiagram',
    '  participant Parent as Parent',
    `  participant Worker as ${callId}${state}`
  ];

  for (const d of deliveries.slice(0, 6)) {
    if (!d || typeof d !== 'object') continue;
    const st = sanitizeMermaidLabel(d.state || 'queued', 18);
    seq.push(`  Parent ->> Worker: steering (${st})`);
  }

  if (msgLines.length) {
    for (const item of msgLines.slice(-6)) {
      if (!item || typeof item !== 'object') continue;
      const prefix = item.kind === 'progress_update' ? '[progress] ' : '';
      const txt = sanitizeMermaidLabel(prefix + (item.text || ''), 42);
      if (txt) seq.push(`  Worker -->> Parent: ${txt}`);
    }
  } else if (!deliveries.length) {
    seq.push(`  Parent ->> Worker: poll messages`);
    seq.push(`  Worker -->> Parent: ${sanitizeMermaidLabel(src.state || 'no new lines', 32)}`);
  }

  return seq.join('\n');
}

function buildSendOrStopSchema(name, r, args) {
  const src = (r && typeof r === 'object' && !r.error) ? r : {};
  const argObj = (args && typeof args === 'object') ? args : {};
  const target = sanitizeMermaidLabel(src.callId || argObj.callId || 'worker', 24);
  const state = sanitizeMermaidLabel(src.state || (name === 'subagent_stop' ? 'cancelled' : 'queued'), 20);

  if (name === 'subagent_stop') {
    return [
      'sequenceDiagram',
      '  participant Parent as Parent',
      `  participant Worker as ${target}`,
      '  Parent ->> Worker: subagent_stop (cancel)',
      `  Worker -->> Parent: state = ${state}`
    ].join('\n');
  }

  const msg = sanitizeMermaidLabel(argObj.message || 'steering guidance', 40);
  return [
    'sequenceDiagram',
    '  participant Parent as Parent',
    `  participant Worker as ${target}`,
    `  Parent ->> Worker: ${msg}`,
    `  Note over Parent,Worker: delivery: ${state}`
  ].join('\n');
}

function buildHandoffSchema(name, r, args) {
  const src = (r && typeof r === 'object' && !r.error) ? r : {};
  const argObj = (args && typeof args === 'object') ? args : {};

  if (Array.isArray(src.artifacts)) {
    if (!src.artifacts.length) return null;
    const lines = ['flowchart LR', '  Reader(["Reader Agent"])'];
    src.artifacts.slice(0, 8).forEach((art, idx) => {
      if (!art || typeof art !== 'object') return;
      const aid = `art_${idx}`;
      const authorId = `pub_${sanitizeMermaidId(art.memberId || art.author || ('p' + idx))}`;
      const authorLabel = sanitizeMermaidLabel(art.memberId || art.author || 'publisher', 24);
      const artLabel = sanitizeMermaidLabel(art.name || ('handoff-' + idx), 26);
      lines.push(`  ${authorId}(["${authorLabel}"]) -->|publish| ${aid}[("${artLabel}")]`);
      lines.push(`  ${aid} -.->|read| Reader`);
    });
    return lines.join('\n');
  }

  const artName = sanitizeMermaidLabel(src.name || argObj.name || 'handoff', 28);
  const author = sanitizeMermaidLabel(src.memberId || src.author || 'Publisher', 24);
  const files = Array.isArray(src.files) ? src.files : (Array.isArray(argObj.files) ? argObj.files : []);
  const fileNote = files.length ? `\\n(${files.length} file${files.length === 1 ? '' : 's'})` : '';

  if (name === 'subagent_publish') {
    return [
      'flowchart LR',
      `  Pub(["${author}"]) -->|publish| Art[("${artName}${fileNote}")]`,
      '  Art -.->|available to| Scope(["Parent & Siblings"])'
    ].join('\n');
  }

  return [
    'flowchart LR',
    `  Pub(["${author}"]) -->|published| Art[("${artName}${fileNote}")]`,
    '  Art -->|subagent_read| Reader(["Current Agent"])'
  ].join('\n');
}

function buildDecisionOrConflictSchema(name, r, args) {
  const src = (r && typeof r === 'object' && !r.error) ? r : {};
  const argObj = (args && typeof args === 'object') ? args : {};
  const cObj = src.conflict && typeof src.conflict === 'object' ? src.conflict : src;

  if (name === 'subagent_decision') {
    const author = sanitizeMermaidLabel(src.author || 'Member', 22);
    const decName = sanitizeMermaidLabel(src.name || argObj.name || 'decision', 26);
    const proposal = sanitizeMermaidLabel(src.proposal || argObj.proposal || '', 38);
    const state = sanitizeMermaidLabel(src.state || 'proposed', 18);
    return [
      'sequenceDiagram',
      `  participant Author as ${author}`,
      '  participant Group as Group Store',
      '  participant Parent as Owning Parent',
      `  Author ->> Group: propose "${decName}"`,
      ...(proposal ? [`  Note over Author,Group: ${proposal}`] : []),
      `  Group -->> Parent: state = ${state} (awaiting approval)`
    ].join('\n');
  }

  const members = Array.isArray(cObj.members)
    ? cObj.members
    : (Array.isArray(argObj.members) ? argObj.members : []);
  const confName = sanitizeMermaidLabel(cObj.name || argObj.name || 'conflict', 26);
  const state = sanitizeMermaidLabel(cObj.state || src.state || 'open', 18);
  const lines = [
    'flowchart TD',
    `  Conf{{"Conflict: ${confName} [${state}]"}}`,
    '  Parent(["Parent Arbitrator"])'
  ];
  if (members.length) {
    members.slice(0, 6).forEach((m) => {
      const mid = 'm_' + sanitizeMermaidId(m);
      lines.push(`  ${mid}["${sanitizeMermaidLabel(m, 24)}"] -->|escalate| Conf`);
    });
  } else {
    lines.push('  Worker["Group Member"] -->|escalate| Conf');
  }
  lines.push('  Conf -.->|awaiting arbitrate| Parent');
  return lines.join('\n');
}

export function buildSubagentToolMermaid(toolName, result, args) {
  const n = String(toolName || '').replace(/^functions\./, '');
  if (n === 'subagent_group_create' || n === 'subagent_group_status' || n === 'subagent_group_update') {
    return buildGroupSchema(result, args);
  }
  if (n === 'subagent_status') {
    return buildStatusSchema(result, args);
  }
  if (n === 'subagent_messages') {
    return buildMessagesSchema(result, args);
  }
  if (n === 'subagent_send' || n === 'subagent_stop') {
    return buildSendOrStopSchema(n, result, args);
  }
  if (n === 'subagent_publish' || n === 'subagent_read') {
    return buildHandoffSchema(n, result, args);
  }
  if (n === 'subagent_decision' || n === 'subagent_conflict') {
    return buildDecisionOrConflictSchema(n, result, args);
  }
  return null;
}

// Build a sequence/structure Mermaid diagram for a `subagent` run when its
// nested conversation (`result.chat`) contains child subagent delegations or
// multi-agent coordination tool calls (`subagent_*`), or when the run itself
// is part of a group / publishes handoffs.
export function buildSubagentRunMermaid(result, args) {
  const r = (result && typeof result === 'object') ? result : {};
  const a = (args && typeof args === 'object') ? args : {};
  const turns = Array.isArray(r.chat) ? r.chat : [];

  const coordCalls = [];
  for (const m of turns) {
    const tcs = m && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of tcs) {
      const fn = (tc && tc.function) || tc || {};
      const name = String(fn.name || '').replace(/^functions\./, '');
      if (name === 'subagent' || name.startsWith('subagent_')) {
        let parsed = fn.arguments != null ? fn.arguments : tc.args;
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
        }
        coordCalls.push({
          id: tc.id || fn.id || '',
          name,
          args: (parsed && typeof parsed === 'object') ? parsed : {}
        });
      }
    }
  }

  const hasGroupMeta = !!(r.groupId || a.groupId || r.memberId || a.memberId || (Array.isArray(r.published) && r.published.length));
  if (!coordCalls.length && !hasGroupMeta) return null;

  const selfLabel = sanitizeMermaidLabel(
    (r.memberId || a.memberId ? `[${r.memberId || a.memberId}] ` : '') +
    (r.agent || a.agent || 'Subagent'),
    28
  );

  // Use a sequence diagram when the subagent actively orchestrates children or messages
  if (coordCalls.length) {
    const seq = [
      'sequenceDiagram',
      '  participant Parent as Parent',
      `  participant Self as ${selfLabel}`
    ];
    const declaredParticipants = new Set(['Parent', 'Self']);
    const ensurePart = (id, label) => {
      if (declaredParticipants.has(id)) return;
      declaredParticipants.add(id);
      seq.splice(2 + declaredParticipants.size - 3, 0, `  participant ${id} as ${sanitizeMermaidLabel(label, 26)}`);
    };

    const taskLabel = sanitizeMermaidLabel(a.task || 'delegate task', 38);
    seq.push(`  Parent ->> Self: ${taskLabel}`);

    for (const call of coordCalls.slice(0, 12)) {
      const ca = call.args || {};
      if (call.name === 'subagent') {
        const targetRaw = ca.memberId || ca.agent || call.id || 'child';
        const pid = 'Child_' + sanitizeMermaidId(targetRaw);
        ensurePart(pid, ca.memberId ? `[${ca.memberId}] ${ca.agent || 'worker'}` : (ca.agent || targetRaw));
        const arrow = ca.background ? '-->>' : '->>';
        seq.push(`  Self ${arrow} ${pid}: ${sanitizeMermaidLabel(ca.task || 'delegate', 34)}`);
      } else if (call.name === 'subagent_send') {
        const targetRaw = ca.callId || 'child';
        const pid = 'Child_' + sanitizeMermaidId(targetRaw);
        ensurePart(pid, targetRaw);
        seq.push(`  Self ->> ${pid}: send: ${sanitizeMermaidLabel(ca.message || 'guidance', 30)}`);
      } else if (call.name === 'subagent_messages' || call.name === 'subagent_status' || call.name === 'subagent_stop') {
        const verb = call.name.replace('subagent_', '');
        if (ca.callId) {
          const pid = 'Child_' + sanitizeMermaidId(ca.callId);
          ensurePart(pid, ca.callId);
          seq.push(`  Self ->> ${pid}: ${verb}`);
        } else {
          seq.push(`  Self ->> Self: ${verb} (all workers)`);
        }
      } else if (call.name === 'subagent_group_create' || call.name === 'subagent_group_update' || call.name === 'subagent_group_status') {
        ensurePart('GroupBus', 'Group Store');
        const detail = ca.name || ca.action || ca.groupId || '';
        seq.push(`  Self ->> GroupBus: ${call.name.replace('subagent_', '')} ${sanitizeMermaidLabel(detail, 24)}`);
      } else if (call.name === 'subagent_publish' || call.name === 'subagent_read' || call.name === 'subagent_decision' || call.name === 'subagent_conflict') {
        ensurePart('GroupBus', 'Group / Handoffs');
        const detail = ca.name || 'all';
        seq.push(`  Self ->> GroupBus: ${call.name.replace('subagent_', '')} (${sanitizeMermaidLabel(detail, 24)})`);
      }
    }

    if (Array.isArray(r.published) && r.published.length) {
      ensurePart('GroupBus', 'Group / Handoffs');
      seq.push(`  Self -->> GroupBus: published ${sanitizeMermaidLabel(r.published.join(', '), 32)}`);
    }
    seq.push(`  Self -->> Parent: ${sanitizeMermaidLabel(r.state || (r.ok === false ? 'failed' : 'completed'), 24)}`);
    return seq.join('\n');
  }

  // Group member / handoff structure diagram
  const lines = [
    'flowchart LR',
    '  Parent(["Parent"])',
    `  Self["${selfLabel}"]`,
    `  Parent -->|${sanitizeMermaidLabel(r.groupId || a.groupId || 'delegate', 20)}| Self`
  ];
  if (Array.isArray(r.published)) {
    r.published.slice(0, 4).forEach((pub, idx) => {
      const pid = `pub_${idx}`;
      lines.push(`  Self -->|publish| ${pid}[("${sanitizeMermaidLabel(pub, 24)}")]`);
    });
  }
  return lines.join('\n');
}

