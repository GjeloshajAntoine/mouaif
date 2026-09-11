// Inspector CDP event handlers — translate CDP events into entries
// for the console and network virtual lists.
import { argToString } from './format.js';
import { normalizeMatchedRules } from './matchedRules.js';

export function createEventHandlers(state) {
  const { consoleEntries, networkEntries, reqMap, consoleVL, networkVL, cdpSend, onNavigate } = state;

  // countRefs — optional refs the InspectorView supplies so pushConsole /
  // pushNetwork can fire a single number on every event. The state lives
  // in a ref so a CDP burst doesn't queue 2000 Preact rerenders; the
  // parent reads the count and calls setCount in its own microtask.
  // Tests that don't pass refs in still work — fall back to silent stubs.
  const consoleCountRef = state.consoleCountRef || { current: null };
  const networkCountRef = state.networkCountRef || { current: null };

  function touchEntry(e) { e.rev = (e.rev || 0) + 1; }

  // How many entries the panels keep. pushConsole()/pushNetwork() render
  // the newest 2000 rows, so anything older is unreachable from the UI —
  // but it stayed in the backing array for the life of the tab, and a
  // network entry can hold a response body of up to 200 KB. A busy page
  // (a dev server HMR loop, a polling app) therefore grew the tab's heap
  // without bound until the inspector was disconnected.
  const MAX_ENTRIES = 2000;

  // Drop the oldest entries once the cap is exceeded. `map` (the request
  // id → entry map) is trimmed with them, and any body they captured is
  // released so the array slice is not the only thing that shrinks.
  function trim(list, map) {
    const over = list.current.length - MAX_ENTRIES;
    if (over <= 0) return;
    const dropped = list.current.splice(0, over);
    for (const entry of dropped) {
      if (!entry) continue;
      entry.body = null;
      entry.args = null;
      // Only forget the in-flight lookup when it still points at this
      // exact entry: a later request reusing the id must keep its own.
      if (map && entry.requestId && map.current.get(entry.requestId) === entry) {
        map.current.delete(entry.requestId);
      }
    }
  }

  function pushConsole() {
    trim(consoleEntries, null);
    const data = consoleEntries.current.slice(-MAX_ENTRIES);
    const vl = consoleVL.current;
    if (vl) {
      try { vl.setData(data); vl.scrollToIndex(data.length - 1); } catch { /* vl destroyed */ consoleVL.current = null; }
    }
    if (consoleCountRef.current) consoleCountRef.current(data.length);
  }

  function pushNetwork() {
    trim(networkEntries, reqMap);
    const data = networkEntries.current.slice(-MAX_ENTRIES);
    const vl = networkVL.current;
    if (vl) {
      try { vl.setData(data); } catch { /* vl destroyed */ networkVL.current = null; }
    }
    if (networkCountRef.current) networkCountRef.current(data.length);
  }

  function onConsoleEvent(params) {
    const args = params.args || [];
    const text = args.map(argToString).join(' ');
    const ts = Date.now();
    const entry = {
      id: 'c' + ts + '-' + consoleEntries.current.length,
      kind: 'console',
      level: params.type || 'log',
      text,
      args: args.slice(0, 8),
      url: null, line: null, stack: null,
      ts
    };
    const st = params.stackTrace && params.stackTrace.callFrames;
    if (st && st.length) {
      entry.url = st[0].url || null;
      entry.line = st[0].lineNumber != null ? st[0].lineNumber + 1 : null;
      entry.stack = st.map((f) => '  at ' + (f.functionName || '(anon)') + ' (' + (f.url || '') + ':' + ((f.lineNumber || 0) + 1) + ':' + ((f.columnNumber || 0) + 1) + ')').join('\n');
    }
    consoleEntries.current.push(entry);
    pushConsole();
  }

    // evaluateExpression — run a snippet the user typed in the editable
  // JavaScript console (JsConsole) inside the inspected page. Uses
  // includeCommandLineAPI so `$0`, `$`, `$$`, `inspect` etc. behave like
  // the real DevTools console. The result is appended to the console log
  // as an entry — either the JSON-serialised value (for value types) or
  // the RemoteObject description (for objects/functions) — and a thrown
  // exception is reported as an error row instead of failing silently.
  // Returns the result value/description so the caller can act on it.
  async function evaluateExpression(expression) {
    const ts = Date.now();
    const mkId = () => 'c' + ts + '-' + consoleEntries.current.length;
    if (!cdpSend || !expression || !String(expression).trim()) return null;
    let entry;
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: String(expression),
        includeCommandLineAPI: true,
        returnByValue: true,
        awaitPromise: true,
        objectGroup: 'mouaif-console'
      });
      entry = {
        id: mkId(),
        kind: 'console',
        level: 'info',
        text: '',
        args: [],
        url: null, line: null, stack: null,
        ts
      };
      const result = r && r.result;
      if (r && r.exceptionDetails) {
        const ex = r.exceptionDetails;
        entry.level = 'error';
        entry.text = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'Uncaught exception';
        if (ex.exception) entry.args = [ex.exception];
        const st = ex.stackTrace && ex.stackTrace.callFrames;
        if (st && st.length) {
          entry.url = st[0].url || null;
          entry.line = st[0].lineNumber != null ? st[0].lineNumber + 1 : null;
          entry.stack = st.map((f) => '  at ' + (f.functionName || '(anon)') + ' (' + (f.url || '') + ':' + ((f.lineNumber || 0) + 1) + ':' + ((f.columnNumber || 0) + 1) + ')').join('\n');
        }
      } else if (result && typeof result.value !== 'undefined') {
        // Value types come back serialised by returnByValue; show them
        // as plain text (matching how console.log renders primitives).
        // JSON.stringify can throw on circular structures — fall back
        // to the CDP description instead of dropping the row.
        let asText;
        try {
          asText = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
        } catch {
          asText = result.description || String(result.value);
        }
        entry.text = asText;
        if (typeof result.value === 'string') entry.args = [{ type: 'string', value: result.value }];
      } else if (result && (result.description || result.objectId)) {
        // Objects / functions: keep the RemoteObject so the row renderer
        // can paint a preview just like a live console.log(object).
        entry.text = result.description || '';
        entry.args = [result];
      } else {
        entry.text = 'undefined';
        entry.args = [{ type: 'undefined' }];
      }
    } catch (e) {
      entry = {
        id: mkId(),
        kind: 'console',
        level: 'error',
        text: 'Runtime.evaluate failed: ' + (e && e.message || e),
        args: [],
        url: null, line: null, stack: null,
        ts
      };
    }
    consoleEntries.current.push(entry);
    pushConsole();
    return entry;
  }

  function onExceptionEvent(params) {
    const ex = params.exceptionDetails || {};
    const text = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'exception';
    const ts = Date.now();
    const entry = {
      id: 'c' + ts + '-' + consoleEntries.current.length,
      kind: 'exception',
      level: 'error',
      text,
      args: ex.exception ? [ex.exception] : [],
      url: ex.url || null,
      line: ex.lineNumber != null ? ex.lineNumber + 1 : null,
      stack: null,
      ts
    };
    const st = ex.stackTrace && ex.stackTrace.callFrames;
    if (st && st.length) {
      entry.stack = st.map((f) => '  at ' + (f.functionName || '(anon)') + ' (' + (f.url || '') + ':' + ((f.lineNumber || 0) + 1) + ':' + ((f.columnNumber || 0) + 1) + ')').join('\n');
    }
    consoleEntries.current.push(entry);
    pushConsole();
  }

  function onRequestWillBeSent(params) {
    const req = params.request || {};
    const entry = {
      id: 'n' + (params.requestId || '') + '-' + reqMap.current.size,
      requestId: params.requestId,
      kind: 'request',
      method: req.method || 'GET',
      url: req.url || '',
      status: 'pending',
      type: (params.type || '').toLowerCase() || null,
      initiator: params.initiator && params.initiator.url || null,
      requestHeaders: req.headers || null,
      ts: Date.now(),
      _start: typeof params.timestamp === 'number' ? params.timestamp : null,
      duration: null,
      size: null,
      encodedSize: null,
      mimeType: null,
      ip: null, port: null, protocol: null,
      fromCache: false,
      body: null,
      bodyLoading: false
    };
    reqMap.current.set(params.requestId, entry);
    networkEntries.current.push(entry);
    pushNetwork();
  }

  function onResponseReceived(params) {
    const r = params.response || {};
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.status = r.status || 0;
    entry.statusText = r.statusText || '';
    entry.type = (params.type || '').toLowerCase() || entry.type;
    entry.mimeType = r.mimeType || null;
    entry.responseHeaders = r.headers || null;
    entry.encodedSize = typeof r.encodedDataLength === 'number' ? r.encodedDataLength : null;
    entry.ip = r.remoteIPAddress || null;
    entry.port = r.remotePort || null;
    entry.protocol = r.protocol || null;
    entry.fromCache = !!(r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache);
    touchEntry(entry);
    pushNetwork();
  }

  function onLoadingFinished(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.duration = (typeof params.timestamp === 'number' && entry._start != null) ? Math.round((params.timestamp - entry._start) * 1000) : null;
    if (typeof params.encodedDataLength === 'number') {
      entry.encodedSize = params.encodedDataLength;
      entry.size = params.encodedDataLength;
    }
    touchEntry(entry);
    pushNetwork();
  }

  function onLoadingFailed(params) {
    const entry = reqMap.current.get(params.requestId);
    if (!entry) return;
    entry.status = 'failed';
    entry.statusText = params.errorText || 'failed';
    touchEntry(entry);
    pushNetwork();
  }

  function captureScreenshot(opts) {
  const params = {
  // Lossless PNG preserves small text, colored edges, and fine UI detail.
  // Keep the discarded screencast signal cheap; only this image is shown.
  format: 'png',
  // Chrome's PDF viewer is a separately composited extension webview.
  // Asking it for a beyond-viewport capture can stall indefinitely;
  // viewport capture includes the rendered PDF surface immediately.
  captureBeyondViewport: state.captureBeyondViewport !== false
  };
  // Optional region capture. The Styles panel's pinned element preview asks
  // for the selected element's box only, so a full-page PNG (megabytes on a
  // real page) is never produced or decoded just to show one card.
  if (opts && opts.clip) params.clip = opts.clip;
  return cdpSend('Page.captureScreenshot', params, 8000);
  }

  // A small screencast acts as an event-driven repaint signal. Its frame
  // data is not rendered: PreviewPanel retains full-page screenshots and
  // uses each event to schedule a throttled refresh. Chrome requires every
  // frame to be acknowledged or it eventually pauses the stream.
  function startPreviewStream() {
    return cdpSend('Page.startScreencast', {
      format: 'jpeg',
      quality: 20,
      maxWidth: 320,
      maxHeight: 320,
      everyNthFrame: 1
    });
  }
  function stopPreviewStream() {
    return cdpSend('Page.stopScreencast');
  }
  function ackPreviewFrame(sessionId) {
    return cdpSend('Page.screencastFrameAck', { sessionId });
  }

  // setViewportSize — apply a device-metrics override to the inspected
  // page so the user can preview it at a chosen size (phone, tablet,
  // desktop) without resizing the real browser window. Pass `null` to
  // clear the override and return the page to its native size. The
  // override is a live CDP emulation, so it also changes how the page
  // reflows — media queries, breakpoints, and responsive layout all
  // respond as if the browser were that size.
  async function setViewportSize(preset) {
    if (!preset) {
      await cdpSend('Emulation.clearDeviceMetricsOverride');
      return;
    }
    await cdpSend('Emulation.setDeviceMetricsOverride', {
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor || 1,
      mobile: !!preset.mobile,
      screenWidth: preset.width,
      screenHeight: preset.height
    });
  }
  // viewportCoords — convert a tap point in the full-page screenshot
  // (device-pixel coordinates, computed by PreviewPanel from the image's
  // naturalWidth/naturalHeight) into a viewport CSS coordinate pair that CDP
  // commands such as Input.dispatchMouseEvent and DOM.getNodeForLocation
  // expect. We (1) divide by the page's devicePixelRatio to get page CSS
  // coordinates, then (2) offset by the page's current scroll position to get
  // viewport coordinates. Anything tapped outside the current viewport (e.g.
  // below the fold) is first scrolled into view so the command lands on the
  // point the user actually tapped. Shared by clickAt (tap-to-click) and
  // pickNodeAt (tap-to-select for the Styles panel).
  async function viewportCoords(x, y) {
    let scrollX = 0, scrollY = 0, dpr = 1;
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: '({ sx: window.scrollX || 0, sy: window.scrollY || 0, dpr: window.devicePixelRatio || 1 })',
        returnByValue: true
      });
      const o = r && r.result && r.result.value;
      if (o && typeof o === 'object') {
        scrollX = o.sx || 0;
        scrollY = o.sy || 0;
        dpr = o.dpr || 1;
      }
    } catch { /* keep defaults */ }

    const pageX = x / dpr;
    const pageY = y / dpr;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;

    let vx = Math.round(pageX - scrollX);
    let vy = Math.round(pageY - scrollY);
    let targetScrollY = scrollY;

    // If the tapped point is outside the live viewport, scroll it into
    // view (roughly centered) so the dispatched command hits the element.
    if (vh > 0 && (vy < 0 || vy > vh)) {
      targetScrollY = Math.max(0, Math.round(pageY - vh / 2));
    }
    if (targetScrollY !== scrollY) {
      try {
        await cdpSend('Runtime.evaluate', { expression: 'window.scrollTo(0, ' + targetScrollY + ')' });
        vy = Math.round(pageY - targetScrollY);
      } catch { /* fall through with the original vy */ }
    }
    return { x: vx, y: vy };
  }
  // clickAt — forward a tap on the live preview to the page. The x/y here
  // are device-pixel coordinates within the full-page screenshot
  // (captureBeyondViewport), computed by PreviewPanel from the image's
  // naturalWidth/naturalHeight. See viewportCoords for the mapping.
  async function clickAt(x, y) {
    const p = await viewportCoords(x, y);
    return cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      .then(() => cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }))
      .then(() => true)
      .catch((e) => { throw e; });
  }
// pickNodeAt — tap-to-select for the Styles panel. Given a screenshot
// device-pixel point, converts it to viewport coordinates (viewportCoords),
// then hit-tests the live page with document.elementFromPoint and assembles
// a full "node model" (label, inline styles, computed styles, box model,
// objectId for live editing) for the StylesPanel to render. Returns null
// when nothing selectable is under the point.
//
// We build the model entirely through Runtime (elementFromPoint +
// callFunctionOn) rather than the DOM domain. DOM.getNodeForLocation often
// returns only a backendNodeId (not a nodeId) and DOM.requestNode can map an
// objectId to nodeId 0 on some targets, so the DOM-domain hit-test route is
// unreliable across Chrome versions. elementFromPoint + callFunctionOn works
// with a RemoteObject objectId directly and needs no nodeId at all.
async function pickNodeAt(x, y) {
const p = await viewportCoords(x, y);
const ev = await cdpSend('Runtime.evaluate', {
expression: '(function(){ var e = document.elementFromPoint(' + Math.round(p.x) + ',' + Math.round(p.y) + '); return e; })()',
objectGroup: 'mouaif-pick',
returnByValue: false
}, 8000);
const objectId = ev && ev.result && ev.result.objectId;
if (!objectId) return null;
return buildNodeModel(objectId);
}
// PAGE_LABEL_SRC — the in-page `tag#id.class` labeller, shared by every
// helper that reports an element identity back to the Styles panel
// (breadcrumb ancestors, child chips, matched-rule inheritance labels).
// It is a string rather than a module import because it runs inside the
// inspected page, in the same Runtime context as the element; keeping one
// copy means the breadcrumb, the child chips, and the panel header all
// spell the same element the same way. `ml` is namespaced to avoid
// colliding with a page global.
const PAGE_LABEL_SRC = 'function ml(n){ if(!n||!n.nodeName) return ""; var s=String(n.nodeName).toLowerCase(); if(n.id) s+="#"+n.id; var c=(typeof n.className==="string")?n.className.trim().split(/\\s+/).filter(Boolean):[]; if(c.length) s+="."+c.slice(0,2).join("."); if(c.length>2) s+="…"; return s; }';
// How much of the tree the panel is offered in one read. The caps keep a deep
// or wide subtree from producing a multi-line wall of tap targets: the strips
// wrap instead of scrolling sideways, so 12 children of a wide element would be
// 6 lines of chips. Overflow is reported as `+N`.
const MAX_ANCESTORS = 8;
const MAX_CHILDREN = 6;
// requestNodeId — resolve a DOM nodeId from a Runtime objectId, or 0.
// Several CSS-domain reads need a nodeId, but DOM.requestNode can map to 0
// on some targets (and DOM.domain may be off), so every caller treats 0 as
// "fall back to the Runtime path" instead of an error.
async function requestNodeId(objectId) {
if (!objectId) return 0;
try {
const req = await cdpSend('DOM.requestNode', { objectId }, 8000);
return (req && req.nodeId) || 0;
} catch { return 0; }
}
// readElementTree — where the selected element sits in the DOM: its
// ancestors (nearest first, each with the number of `parentElement` hops
// needed to reach it) and its direct children. The Styles panel turns both
// into tap targets, which is how the tree is walked on a phone — the
// alternative, re-picking on the live preview for every parent or child,
// is the slowest possible way to move one level.
//
// One round-trip, returnByValue, no nodeId: the hops are counted here so
// the panel only has to hand back a number to move up. Ancestors are capped
// at 8 (the strip scrolls) and children at 12, with the real child count
// reported so the panel can say how many were left off.
async function readElementTree(objectId) {
if (!objectId) return null;
try {
const r = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: 'function(){ ' + PAGE_LABEL_SRC + ' var anc=[],n=this.parentElement,lv=1; while(n && lv<=' + MAX_ANCESTORS + '){ anc.push({ label: ml(n), levels: lv }); n=n.parentElement; lv++; } var k=this.children||[],kids=[]; for(var i=0;i<k.length && i<' + MAX_CHILDREN + ';i++){ kids.push({ label: ml(k[i]) }); } return { ancestors: anc, children: kids, childCount: k.length, label: ml(this) }; }',
returnByValue: true
}, 8000);
return (r && r.result && r.result.value) || null;
} catch { return null; }
}
// selectAncestorNode — move up `levels` parents and describe the result.
// Returns a full node model (or null at the top of the tree) so the panel
// adopts it exactly like a fresh pick: new objectId, new styles, new
// highlight. The element stays a live RemoteObject the whole way, so this
// needs no nodeId and no re-query by selector.
async function selectAncestorNode(objectId, levels) {
const hops = Math.max(1, Math.min(MAX_ANCESTORS, Number(levels) || 1));
const r = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: 'function(n){ var e=this; for(var i=0;i<n && e;i++){ e=e.parentElement; } return e || null; }',
arguments: [{ value: hops }],
returnByValue: false
}, 8000);
const next = r && r.result && r.result.objectId;
if (!next) return null;
return buildNodeModel(next);
}
// selectChildNode — move down into child element `index`.
async function selectChildNode(objectId, index) {
const i = Math.max(0, Number(index) || 0);
const r = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: 'function(i){ var k=this.children||[]; return k[i] || null; }',
arguments: [{ value: i }],
returnByValue: false
}, 8000);
const next = r && r.result && r.result.objectId;
if (!next) return null;
return buildNodeModel(next);
}
// NODE_PATH_SRC — a unique CSS selector path for the element.
//
// `DOM.requestNode` is the documented way to turn a Runtime objectId into a
// nodeId, and it is unreliable: on several targets (including the fixture
// this feature was verified against) it answers `nodeId: 0` for an object
// resolved through Runtime, which silently kills every CSS-domain read that
// needs a nodeId. The DOM domain's own resolution path is reliable, so we
// build a selector that identifies the element and let `DOM.querySelector`
// resolve it from the document root.
//
// The path stops as soon as a unique `#id` is reached, so the common case is
// a one-part `#hero`; otherwise it walks up emitting `tag:nth-of-type(n)`
// only where a sibling of the same tag exists (a bare `tag` is already unique
// in that position). Capped at 32 parts so a pathological tree cannot produce
// a selector longer than the protocol will accept.
const NODE_PATH_SRC = 'function(){'
+ 'function nth(n){ var i=1,s=n; while((s=s.previousElementSibling)) i++; return i; }'
+ 'function esc(v){ return (window.CSS && CSS.escape) ? CSS.escape(v) : v; }'
+ 'function unique(sel){ try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }'
+ 'var el=this, parts=[];'
+ 'while(el && el.nodeType===1){'
+ 'if(el.id && unique("#"+esc(el.id))){ parts.unshift("#"+esc(el.id)); break; }'
+ 'var p=el.nodeName.toLowerCase(), parent=el.parentElement;'
+ 'if(parent){'
+ 'var same=0, k=parent.children;'
+ 'for(var i=0;i<k.length;i++){ if(k[i].nodeName===el.nodeName) same++; }'
+ 'if(same>1) p+=":nth-of-type("+nth(el)+")";'
+ '}'
+ 'parts.unshift(p);'
+ 'el=parent;'
+ 'if(parts.length>=32) break;'
+ '}'
+ 'return parts.join(" > ");'
+ '}';
// resolveNodeId — a DOM nodeId for a Runtime objectId, or 0. Tries the
// documented `DOM.requestNode` first and falls back to the selector path
// above, which is what makes the accurate cascade and the page highlight work
// on the targets where `requestNode` answers 0. Best-effort throughout: a
// failure returns 0 and the caller degrades instead of throwing.
async function resolveNodeId(objectId) {
if (!objectId) return 0;
const direct = await requestNodeId(objectId);
if (direct) return direct;
let selector = '';
try {
const r = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: NODE_PATH_SRC,
returnByValue: true
}, 8000);
selector = (r && r.result && r.result.value) || '';
} catch { return 0; }
if (!selector) return 0;
try {
const doc = await cdpSend('DOM.getDocument', { depth: 0 }, 8000);
const rootId = doc && doc.root && doc.root.nodeId;
if (!rootId) return 0;
const q = await cdpSend('DOM.querySelector', { nodeId: rootId, selector }, 8000);
return (q && q.nodeId) || 0;
} catch { return 0; }
}
// SCAN_RULES_SRC — the in-page cascade scan.
//
// Used only as a fallback: `CSS.getMatchedStylesForNode` is the accurate
// source, but it needs a nodeId, and DOM.requestNode maps some targets'
// objectIds to nodeId 0. Rather than showing an empty "Matched rules"
// section on those targets, the panel falls back to this scan, which walks
// `document.styleSheets` and collects every style rule whose selector
// matches the element or one of its ancestors.
//
// It reports the same shape the CSS domain does — inlineStyle,
// matchedCSSRules, inherited[] — so `matchedRules.js` has exactly one
// normalizer and the panel cannot tell which source answered.
//
// Deliberate limits: a cross-origin stylesheet throws on `.cssRules` and is
// skipped; nested group rules (@media/@supports/@layer) are walked with
// their `conditionText` kept as the media caption; and the walk stops after
// RULE_BUDGET rules so a page shipping a 100 000-rule bundle cannot wedge
// the tab. Ancestors are capped at 8, matching readElementTree.
const SCAN_RULES_SRC = `function(){
var el = this;
var RULE_BUDGET = 20000;
function decl(cs){
var out = [], n = (cs && cs.length) || 0;
for (var i = 0; i < n; i++){
var p = cs.item(i);
if (!p) continue;
out.push({ name: p, value: cs.getPropertyValue(p), important: cs.getPropertyPriority(p) === "important" });
}
return out;
}
function collect(node, list, cond, sink, seen){
for (var i = 0; i < list.length; i++){
var r = list[i];
if (!r) continue;
if (r.cssRules){
cond = r.conditionText ? (cond ? cond + " and " + r.conditionText : r.conditionText) : cond;
seen = collect(node, r.cssRules, cond, sink, seen);
continue;
}
if (!r.selectorText) continue;
if (++seen > RULE_BUDGET) return seen;
var hit = false;
try { hit = node.matches(r.selectorText); } catch (e) { hit = false; }
if (!hit) continue;
var props = decl(r.style);
if (!props.length) continue;
sink.push({ rule: {
selectorList: { selectors: [{ text: r.selectorText }] },
origin: "regular",
media: cond ? [{ text: cond }] : [],
style: { cssProperties: props }
} });
}
return seen;
}
var chain = [], up = el.parentElement;
while (up && chain.length < 8){ chain.push(up); up = up.parentElement; }
var sheets = document.styleSheets || [];
var scan = function(node){
var sink = [], seen = 0;
for (var s = 0; s < sheets.length; s++){
var list = null;
try { list = sheets[s].cssRules; } catch (e) { continue; }
seen = collect(node, list, "", sink, seen);
if (seen > RULE_BUDGET) break;
}
return sink;
};
var inherited = [];
for (var c = 0; c < chain.length; c++){
inherited.push({ inlineStyle: { cssProperties: decl(chain[c].style) }, matchedCSSRules: scan(chain[c]) });
}
return { inlineStyle: { cssProperties: decl(el.style) }, matchedCSSRules: scan(el), inherited: inherited };
}`;
// hasCascade — did the CSS domain actually describe a cascade? An empty
// response is indistinguishable from "no stylesheet rules matched", and a
// disabled domain answers with nothing at all, so both cases fall through
// to the scan.
function hasCascade(raw) {
if (!raw) return false;
return !!(raw.inlineStyle
|| (raw.matchedCSSRules && raw.matchedCSSRules.length)
|| (raw.inherited && raw.inherited.length));
}
// readMatchedRules — where the element's styles actually come from, read
// only. The panel has always been able to edit `element.style` and to read
// the resolved value of every property; what it could not answer was "which
// class or rule put this value here", which is the question that decides
// whether an override is even fixable from this panel.
//
// CSS.getMatchedStylesForNode is the accurate source (shadow DOM, adopted
// sheets, real @media applicability) and is tried first; the in-page scan
// covers targets where DOM.requestNode yields no nodeId. Inherited rules
// are captioned with the ancestor labels from readElementTree — Chrome's
// inheritance chain and that label list are both built by walking up, so
// the two line up index for index.
async function readMatchedRules(objectId) {
if (!objectId) return null;
const tree = await readElementTree(objectId);
const ancestors = (tree && tree.ancestors) || [];
let raw = null;
const nodeId = await resolveNodeId(objectId);
if (nodeId) {
try { raw = await cdpSend('CSS.getMatchedStylesForNode', { nodeId }, 8000); } catch { raw = null; }
}
if (!hasCascade(raw)) {
try {
const scan = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: SCAN_RULES_SRC,
returnByValue: true
}, 8000);
const v = scan && scan.result && scan.result.value;
if (v) raw = v;
} catch { /* keep whatever the CSS domain gave us */ }
}
return normalizeMatchedRules(raw, { ancestors });
}
// buildNodeModel — resolve everything the Styles panel needs from a
// RemoteObject objectId: the DOM node identity (tag/id/class), the inline
// declared styles, the computed styles, and the box-model dimensions. Also
// highlights the node in the live page (Overlay.highlightNode) so the user
// sees which element they picked. Everything except the highlight is read
// with a single Runtime.callFunctionOn (which needs no nodeId), so the panel
// degrades gracefully when the DOM domain is unavailable.
async function buildNodeModel(objectId) {
if (!objectId) return null;
const model = { objectId, node: null, inlineProps: [], computed: [], box: null };
try {
const s = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: 'function(){ var cs = getComputedStyle(this); var inline=[]; for (var i=0;i<this.style.length;i++){ var p=this.style.item(i); inline.push([p, this.style.getPropertyValue(p)]); } var computed=[]; for (var j=0;j<cs.length;j++){ var q=cs.item(j); computed.push([q, cs.getPropertyValue(q)]); } var r=this.getBoundingClientRect(); var cls=(typeof this.className==="string")?this.className:""; var root=null, parent=null; try { root=parseFloat(getComputedStyle(document.documentElement).fontSize)||null; } catch(e){ root=null; } try { var pe=this.parentElement; parent=pe?parseFloat(getComputedStyle(pe).fontSize)||null:null; } catch(e){ parent=null; } if (parent==null) parent=parseFloat(cs.fontSize)||null; return { tag:this.nodeName, id:this.id||"", className:cls, inline:inline, computed:computed, width:r.width, height:r.height, bases:{ root:root, parent:parent, self:parseFloat(cs.fontSize)||null } }; }',
returnByValue: true
});
const v = s && s.result && s.result.value;
if (v) {
model.node = { nodeName: v.tag, attributes: [{ name: 'id', value: v.id || '' }, { name: 'class', value: v.className || '' }] };
model.inlineProps = (v.inline || []).map((x) => ({ prop: x[0], value: String(x[1] || '') }));
// Computed styles come back in whatever order the browser iterates
// CSSStyleDeclaration; sort alphabetically so the long read-only list is
// scannable (mirrors the desktop DevTools Styles pane).
model.computed = (v.computed || []).map((x) => ({ prop: x[0], value: String(x[1] || '') }))
.sort((a, b) => (a.prop < b.prop ? -1 : a.prop > b.prop ? 1 : 0));
model.box = { width: v.width, height: v.height };
// The base font sizes travel with every pick, not only with a post-edit read:
// the value-type switch needs them the moment an element is selected (a rem or
// font-size-% form must be a real number, not an assumed 16px root).
model.bases = v.bases || null;
}
} catch { /* element model unavailable */ }
// Best-effort highlight. Overlay.highlightNode needs a nodeId; resolve one
// from the objectId (through the reliable path, not only DOM.requestNode),
// and if that's unavailable just skip the highlight rather than failing the
// pick.
const nodeId = await resolveNodeId(objectId);
if (nodeId) {
try {
await cdpSend('Overlay.highlightNode', {
nodeId,
highlightConfig: {
showInfo: true,
showStyles: false,
contentColor: { r: 110, g: 168, b: 254, a: 0.3 },
paddingColor: { r: 110, g: 168, b: 254, a: 0.15 },
borderColor: { r: 110, g: 168, b: 254, a: 0.6 }
}
});
} catch { /* highlight unavailable */ }
}
return model;
}
// captureElementShot — a small clipped screenshot of one element. The
// Styles panel pins it above its property list and repeats it inside the
// edit sheet, so a CSS edit can be read back without scrolling the page to
// the Preview panel — the single biggest usability problem with editing
// styles on a phone.
//
// The element is centred in the viewport first (so a below-the-fold edit is
// actually rendered into the capture), its box is re-read afterwards, and
// the clip is padded so borders, outlines, and shadows survive. Returns
// { data, width, height } in device pixels, or null when the element has no
// usable box (display:none, detached node, zero-size).
async function captureElementShot(objectId, opts) {
if (!objectId) return null;
const pad = Math.max(0, Math.min(48, (opts && opts.pad) || 16));
const maxWidth = Math.max(64, (opts && opts.maxWidth) || 480);
let rect = null;
try {
const r = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: 'function(){ if(!this.getBoundingClientRect) return null; try { this.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { try { this.scrollIntoView(); } catch (e2) { return null; } } var b = this.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, sx: window.scrollX || 0, sy: window.scrollY || 0, dpr: window.devicePixelRatio || 1 }; }',
returnByValue: true
}, 8000);
rect = r && r.result && r.result.value;
} catch { return null; }
if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
// Clip geometry is in CSS pixels. With captureBeyondViewport the origin is
// the document, otherwise the viewport — build whichever the current target
// wants (PDF-viewer targets force viewport captures).
const beyond = state.captureBeyondViewport !== false;
const originX = beyond ? 0 : (rect.sx || 0);
const originY = beyond ? 0 : (rect.sy || 0);
// Bound the captured region to a "context window" centred on the element.
// Capturing a whole <body> (thousands of pixels tall) would either produce a
// multi-megabyte PNG or, once scaled to fit a 360 px panel, an unreadable
// smear. A window keeps the scale near 1:1 for small elements (their own box
// plus padding) and shows the element's surroundings for large ones.
const ctxW = Math.max(120, (opts && opts.contextWidth) || 520);
const ctxH = Math.max(90, (opts && opts.contextHeight) || 360);
const width = Math.min(rect.width + pad * 2, ctxW);
const height = Math.min(rect.height + pad * 2, ctxH);
const centreX = rect.x + (rect.sx || 0) + rect.width / 2;
const centreY = rect.y + (rect.sy || 0) + rect.height / 2;
const x = Math.max(0, centreX - width / 2 - originX);
const y = Math.max(0, centreY - height / 2 - originY);
// Render across at most `maxWidth` device pixels (a ~360 px panel can't use
// more), never above 2x.
let scale = Math.min(2, maxWidth / width);
if (!Number.isFinite(scale) || scale <= 0.05) scale = 0.05;
let shot = null;
try {
const r = await cdpSend('Page.captureScreenshot', {
format: 'png',
captureBeyondViewport: beyond,
clip: { x, y, width, height, scale }
}, 8000);
shot = r && r.data;
} catch { return null; }
if (!shot) return null;
return {
data: shot,
width: Math.max(1, Math.round(width * scale)),
height: Math.max(1, Math.round(height * scale))
};
}
// readElementStyles — one round-trip that returns the element's own inline
// properties and their resolved values: { inline: {prop: value}, computed:
// {prop: value} }. Inline property names are the CSSOM's, so a shorthand the
// user typed (`margin: 40px`) comes back as the longhands it expanded to —
// which are exactly the names the Computed list carries, so an edit can be
// reflected in both lists without a second lookup.
async function readElementStyles(objectId) {
if (!objectId) return null;
// The same call also reports the two base font sizes the value-type switch
// needs: `bases.root` for rem and `bases.parent` for em/percent-of-font-size
// conversions. Reading them here (rather than in the value-kind module) keeps
// the conversions honest instead of assuming a 16px root, and costs no extra
// round-trip — it is the same callFunctionOn the post-edit read already makes.
const r = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: 'function(){ var cs = getComputedStyle(this); var inline = {}; var computed = {}; for (var i = 0; i < this.style.length; i++) { var p = this.style.item(i); inline[p] = this.style.getPropertyValue(p); computed[p] = cs.getPropertyValue(p); } var root = null, parent = null; try { root = parseFloat(getComputedStyle(document.documentElement).fontSize) || null; } catch (e) { root = null; } try { var pe = this.parentElement; if (pe) parent = parseFloat(getComputedStyle(pe).fontSize) || null; } catch (e) { parent = null; } if (parent == null) parent = parseFloat(cs.fontSize) || null; return { inline: inline, computed: computed, bases: { root: root, parent: parent, self: parseFloat(cs.fontSize) || null } }; }',
returnByValue: true
}, 8000);
return (r && r.result && r.result.value) || null;
}
// readSiblingValues — what the element's siblings use for one property.
//
// "The other section on this page uses 16px" is the answer to a spacing
// decision that the page's own stylesheet values cannot give: the rules say
// what the *page* declares, this says what the *peers* do. It is one
// Runtime.callFunctionOn against the selected element (no nodeId, like every
// other read here), so it costs one round-trip per property asked about.
//
// The value is the sibling's *computed* value: a sibling that inherits its
// padding from a parent is using that padding, whether or not it declares it.
// The label is how a person refers to the element — `2nd section.input-section`
// — because the ordinal is what makes it findable on the page, and the read is
// capped at MAX_SIBLINGS so a 500-row table cannot turn one tap into a
// thousand-element read.
const MAX_SIBLINGS = 12;
async function readSiblingValues(objectId, property) {
if (!objectId || !property) return [];
try {
const r = await cdpSend('Runtime.callFunctionOn', {
objectId,
functionDeclaration: 'function(prop){'
+ ' var out = [];'
+ ' var parent = this.parentElement;'
+ ' if (!parent) return out;'
+ ' var kids = parent.children;'
+ ' for (var i = 0; i < kids.length && out.length < ' + MAX_SIBLINGS + '; i++) {'
+ '   var k = kids[i];'
+ '   if (k === this) continue;'
+ '   var v = "";'
+ '   try { v = getComputedStyle(k).getPropertyValue(prop); } catch (e) { continue; }'
+ '   v = String(v || "").trim();'
+ '   if (!v) continue;'
+ '   var nth = 1; var s = k;'
+ '   while ((s = s.previousElementSibling)) nth++;'
+ '   var suffix = nth === 1 ? "st" : nth === 2 ? "nd" : nth === 3 ? "rd" : "th";'
+ '   var cls = (typeof k.className === "string") ? k.className.trim() : "";'
+ '   var names = cls ? cls.split(/\\s+/).slice(0, 2).join(".") : "";'
+ '   out.push({ prop: prop, value: v, label: nth + suffix + " " + k.nodeName.toLowerCase() + (names ? "." + names : "") });'
+ ' }'
+ ' return out;'
+ '}',
arguments: [{ value: String(property) }],
returnByValue: true
}, 8000);
const rows = r && r.result && r.result.value;
return Array.isArray(rows) ? rows : [];
} catch { return []; }
}
// hideNodeHighlight — clear the Overlay box-model highlight on the page.
async function hideNodeHighlight() {
try { await cdpSend('Overlay.hideHighlight'); } catch { /* ignore */ }
}
// refreshNodeModel — re-fetch a node's style model after an edit, keeping
// the same objectId (so the selected element is preserved). Used by the
// Styles panel's "refresh" action so computed values reflect an applied
// inline change without re-picking the element.
async function refreshNodeModel(objectId) {
if (!objectId) return null;
return buildNodeModel(objectId);
}
// selectBySelector — pick an element by a CSS selector text instead of a
// tap. A mobile-first alternative to tap-to-select that works even when the
// preview is hidden: type `#hero .card` and the first matching element is
// resolved and described. Uses document.querySelector via Runtime, then the
// same objectId-based model builder as tap-to-select.
async function selectBySelector(selector) {
const sel = String(selector || '').trim();
if (!sel) return null;
const ev = await cdpSend('Runtime.evaluate', {
expression: '(function(){ var e = document.querySelector(' + JSON.stringify(sel) + '); return e; })()',
objectGroup: 'mouaif-pick',
returnByValue: false
}, 8000);
const objectId = ev && ev.result && ev.result.objectId;
if (!objectId) return null;
return buildNodeModel(objectId);
}
  // setInlineStyleProperty — write one CSS property onto the element's own
  // inline style via Runtime.callFunctionOn. This is the live-edit primitive
  // for the Styles panel: it always lands on the element regardless of whether
  // it already had an inline style or inherited the property from a class.
  async function setInlineStyleProperty(objectId, prop, value) {
    if (!objectId) throw new Error('element not resolved');
    const r = await cdpSend('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(p, v){ try { this.style.setProperty(p, v); return { ok:true }; } catch (e) { return { ok:false, error:String(e) }; } }',
      arguments: [{ value: String(prop) }, { value: String(value) }],
      returnByValue: true
    });
    const out = r && r.result && r.result.value;
    if (out && !out.ok) throw new Error(out.error || 'setProperty failed');
    return true;
  }
  // removeInlineStyleProperty — drop one CSS property from the element's
  // inline style (returns the element to whatever a class/stylesheet gives it).
  async function removeInlineStyleProperty(objectId, prop) {
    if (!objectId) throw new Error('element not resolved');
    await cdpSend('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(p){ this.style.removeProperty(p); return { ok:true }; }',
      arguments: [{ value: String(prop) }],
      returnByValue: true
    });
    return true;
  }

  // insertText — paste a whole string into the currently focused element in
// the inspected page (CDP Input.insertText). This is the Preview panel's
// "type into the page" primitive: the user taps a text field (clickAt
// focuses it), then types in the preview's text bar and we forward the
// entire string as one insert. Input.insertText handles every character
// (unicode, emoji, IME composition) without simulating keydown/keyup
// pairs, which is what makes it full text input rather than a
// per-keystroke echo. Returns the CDP result or throws on failure.
async function insertText(text) {
if (text == null) return null;
const value = String(text);
if (!value) return null;
return cdpSend('Input.insertText', { text: value });
}
// pressEnter — send a real Enter key to the focused element so forms
// submit and textareas get a newline. Uses Input.dispatchKeyEvent
// (keyDown + char + keyUp) rather than Input.insertText('\n'), which
// some inputs treat as a literal character instead of a submit. Mirrors
// the single key send a physical keyboard would fire on "Enter".
async function pressEnter() {
const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' });
await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function fetchMetrics() {
const out = { netCount: networkEntries.current.length };
    try {
      const m = await cdpSend('Performance.getMetrics');
      const list = (m && m.metrics) || [];
      const byName = {};
      for (const x of list) byName[x.name] = x.value;
      out.documents = byName.Documents;
      out.frames = byName.Frames;
      out.nodes = byName.Nodes;
      out.listeners = byName.JSEventListeners;
      out.jsHeap = byName.JSHeapUsedSize;
      out.layoutCount = byName.LayoutCount;
      out.recalcCount = byName.RecalcStyleCount;
    } catch { /* Performance domain off */ }
    return out;
  }

  async function loadResponseBody(item) {
    if (!item || !item.requestId || item.bodyLoading) return;
    item.bodyLoading = true;
    touchEntry(item);
    if (state.rerender) state.rerender();
    try {
      const r = await cdpSend('Network.getResponseBody', { requestId: item.requestId });
      let body = r && typeof r.body === 'string' ? r.body : '';
      if (r && r.base64Encoded) {
        try { body = decodeURIComponent(escape(atob(body))); } catch { body = atob(body); }
      }
      item.body = body.length > 200000 ? body.slice(0, 200000) + '\n… (truncated)' : body;
    } catch (e) {
      item.body = '(failed to fetch body: ' + (e && e.message || e) + ')';
    } finally {
      item.bodyLoading = false;
      touchEntry(item);
      if (state.rerender) state.rerender();
    }
  }

  function onFrameNavigated(params) {
    const frame = params && params.frame;
    if (!frame) return;
    // Main frame navigation: frame.parentId is missing or null
    if (!frame.parentId && typeof onNavigate === 'function') {
      onNavigate(frame.url || '', frame.name || '');
    }
  }

  function onNavigatedWithinDocument(params) {
    if (params && params.url && typeof onNavigate === 'function') {
      onNavigate(params.url, '');
    }
  }

  return {
onConsoleEvent, onExceptionEvent, onRequestWillBeSent,
onResponseReceived, onLoadingFinished, onLoadingFailed,
onFrameNavigated, onNavigatedWithinDocument,
pushConsole, pushNetwork, captureScreenshot, clickAt, fetchMetrics,
startPreviewStream, stopPreviewStream, ackPreviewFrame,
loadResponseBody, evaluateExpression, setViewportSize,
insertText, pressEnter,
pickNodeAt, hideNodeHighlight, setInlineStyleProperty, removeInlineStyleProperty,
refreshNodeModel, selectBySelector, captureElementShot, readElementStyles,
readSiblingValues,
readElementTree, selectAncestorNode, selectChildNode, readMatchedRules
};
}