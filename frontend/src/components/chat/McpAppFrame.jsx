import { h, render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { boundedHeight, connectMcpApp, containerDimensionsFor } from './mcpAppBridge.js';
import { THEME_PAINTED, surfaceHostContext, themeHostContext } from './appHostContext.js';
import './mcp-app.css';

// `surface` ({ extensionId, surfaceId, slot, projectName }) mounts an
// extension's view instead of a tool call's (docs/features/extensions.md);
// `onClosed` tells its slot the view closed (a dock collapses to its chip),
// and `onBridge` hands the slot the live bridge (host events, badges).
export function McpAppFrame({ projectDir, chatId, callId, appPath, appTitle, onAuthorize, onMountStateChange, surface, onClosed, onBridge }) {
  const frame = useRef(null);
  const session = useRef(null);
  const closeView = useRef(null);
  const authorize = useRef(onAuthorize);
  authorize.current = onAuthorize;
  const mountStateChange = useRef(onMountStateChange);
  mountStateChange.current = onMountStateChange;
  const [mount, setMount] = useState(null);
  const [status, setStatus] = useState('Loading app…');
  const [mode, setMode] = useState('inline');
  const [height, setHeight] = useState(288);
  const [generation, setGeneration] = useState(0);
  const [titleOverride, setTitleOverride] = useState('');
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const resolvedPath = normalizeAppPath(mount?.result?.path || appPath);
  const resolvedTitle = titleOverride || mount?.title || appTitle || '';

  useEffect(() => {
    const reload = payload => {
      if (payload && typeof payload.name === 'string' && payload.name.trim() && payload.name !== 'On-the-fly app') {
        setTitleOverride(payload.name.trim());
      }
      setGeneration(n => n + 1);
    };
    // Extension views are not on-the-fly apps: nothing reloads or messages them by path.
    if (surface) return undefined;
    registerActiveAppFrame(projectDir, chatId, callId, { path: resolvedPath, title: resolvedTitle, reload });
    return () => unregisterActiveAppFrame(callId, reload);
  }, [projectDir, chatId, callId, resolvedPath, resolvedTitle, surface]);
  const surfaceKey = surface ? surface.extensionId + '/' + surface.surfaceId : '';
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const bridgeRef = useRef(onBridge);
  bridgeRef.current = onBridge;
  const sheetRef = useModal({
    active: mode === 'fullscreen' && !!mount && !failed,
    onClose: () => applyMode('inline'),
    initialFocus: 'none'
  });

  function applyMode(next) {
    setMode(next);
    queueMicrotask(() => {
      if (session.current && frame.current) {
        session.current.setMode(next, containerDimensionsFor(frame.current, next));
      }
    });
  }

  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) return undefined;
    if (mode !== 'fullscreen' || !mount || failed) {
      if (el.open && typeof el.close === 'function') {
        try { el.close(); } catch { /* ignore */ }
      }
      el.setAttribute('open', '');
      el.style.removeProperty('--mcp-app-vv-top');
      el.style.removeProperty('--mcp-app-vv-height');
      return undefined;
    }
    if (el.open && typeof el.close === 'function') {
      try { el.close(); } catch { /* ignore */ }
    }
    if (!el.open && typeof el.showModal === 'function') {
      try { el.showModal(); } catch { el.setAttribute('open', ''); }
    }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const syncViewport = () => {
      const top = vv ? Math.max(0, vv.offsetTop) : 0;
      const vh = vv && vv.height ? vv.height : window.innerHeight;
      el.style.setProperty('--mcp-app-vv-top', top + 'px');
      el.style.setProperty('--mcp-app-vv-height', vh + 'px');
      if (session.current && frame.current) {
        session.current.setMode('fullscreen', containerDimensionsFor(frame.current, 'fullscreen'));
      }
    };
    const onCancel = event => {
      event.preventDefault();
      applyMode('inline');
    };
    el.addEventListener('cancel', onCancel);
    if (vv) {
      vv.addEventListener('resize', syncViewport);
      vv.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    syncViewport();
    return () => {
      el.removeEventListener('cancel', onCancel);
      if (vv) {
        vv.removeEventListener('resize', syncViewport);
        vv.removeEventListener('scroll', syncViewport);
      }
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      if (el.open && typeof el.close === 'function') {
        try { el.close(); } catch { /* ignore */ }
      }
      el.setAttribute('open', '');
      el.style.removeProperty('--mcp-app-vv-top');
      el.style.removeProperty('--mcp-app-vv-height');
    };
  }, [mode, mount, failed]);

  useEffect(() => {
    let active = true;
    const ctl = new AbortController();
    let id;
    setFailed(false); setUnavailable(false); setStatus('Loading app…'); setMount(null);
    const mountBody = surface
      ? { projectDir, chatId: chatId || undefined, extensionId: surface.extensionId, surfaceId: surface.surfaceId }
      : { projectDir, chatId, callId };
    fetchJson('/api/mcp/apps/mount', { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mountBody)
    }).then(async response => {
      if (!response.body?.enabled) {
        if (active) {
        if (response.status === 200 && response.body?.enabled === false) {
          setUnavailable(true);
          mountStateChange.current?.(false);
        } else {
          setFailed(true);
          setStatus(response.body?.error || 'App unavailable — tool result shown below.');
          mountStateChange.current?.(true);
        }
        }
        return;
      }
      id = response.body.id;
      if (!active) {
        await fetch('/api/mcp/apps/' + id, { method: 'DELETE', body: '{}' }); return;
      }
      setMount(response.body);
      mountStateChange.current?.(true);
    }).catch(error => {
      if (active) {
        setFailed(true);
        setStatus(error.message);
        mountStateChange.current?.(true);
      }
    });
    return () => {
      active = false; ctl.abort();
      const closing = session.current; session.current = null;
      // Hook cleanup cannot await DOM removal. Teardown is best effort on
      // navigation/recycled rows; explicit failure waits before hiding a view.
      Promise.resolve(closing?.close()).finally(() => {
        if (id) fetch('/api/mcp/apps/' + id, { method: 'DELETE', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      });
    };
  }, [projectDir, chatId, callId, surfaceKey, generation]);

  useEffect(() => {
    if (!mount || !frame.current) return;
    let active = true;
    const ctl = new AbortController();
    const post = (suffix, body, signal = ctl.signal) => fetchJson('/api/mcp/apps/' + mount.id + suffix, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    let closing = false;
    const fail = async error => {
    if (!active || closing) return;
    closing = true;
    clearTimeout(timeout); clearInterval(poll);
    ctl.abort(); // settle host-owned approval UI before waiting for teardown
    const bridge = session.current; session.current = null;
    // Revoke independently of app cooperation or frame connectivity.
    void fetch('/api/mcp/apps/' + mount.id, { method: 'DELETE', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    try { await bridge?.close(); } finally {
    if (active) { setFailed(true); setStatus(error?.message || (surface ? 'View closed — Retry to reopen.' : 'App closed — tool result shown below.')); setMode('inline'); }
    if (bridgeRef.current) bridgeRef.current(null);
    // Only the user's Close collapses an extension view's slot; a failure
    // stays visible with its reason and Retry.
    if (userClosed && closedRef.current) closedRef.current();
    }
    };
    let userClosed = false;
    closeView.current = () => { userClosed = true; void fail(new Error('App closed — Retry to reopen.')); };
    const onPageHide = () => { void fail(new Error('App paused — Retry to reopen.')); };
    const onVisibility = () => { if (document.hidden) onPageHide(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    const timeout = setTimeout(() => fail(new Error('App initialization timed out — tool result shown below.')), 10000);
    connectMcpApp({ iframe: frame.current, mount,
    hostContext: surface ? surfaceHostContext({ ...surface, chatId }) : undefined,
    onReady: () => {
      clearTimeout(timeout);
      if (!active) return;
      setStatus('');
      const pending = consumePendingAgentMessages(projectDir, chatId, mount.title);
      for (const item of pending) void session.current?.sendAgentMessage(item).catch(() => {});
    },
    onSize: value => { if (active) setHeight(boundedHeight(value, window.innerHeight)); },
      onMode: value => { if (active) setMode(value); }, onClose: fail,
      onMessage: async (params, signal) => {
        const response = await post('/message', params, AbortSignal.any([signal, ctl.signal]));
        if (response.status !== 200) throw new Error(response.body.error || 'App message failed');
        // App receives an acknowledgement only; the normal chat follower loads
        // the user row and AI response without exposing them back to the view.
        return {};
      },
      onCall: async (params, appSignal) => {
        const signal = AbortSignal.any([appSignal, ctl.signal]);
        const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
        const body = { requestId, name: params.name, arguments: params.arguments || {} };
        const cancel = () => fetch('/api/mcp/apps/' + mount.id + '/cancel', { method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) }).catch(() => {});
        signal.addEventListener('abort', cancel, { once: true });
        try {
          let response = await post('/call', body, signal);
          if (response.status === 409 && response.body.code === 'EAUTH_REQUIRED') {
            const decision = await authorize.current(response.body.request, signal);
            if (decision === 'deny' || !active || signal.aborted) throw new Error('App tool call denied or cancelled');
            response = await post('/call', body, signal);
          }
          if (response.status !== 200) throw new Error(response.body.error || 'App tool call failed');
          return response.body;
        } finally { signal.removeEventListener('abort', cancel); }
      }
    }).then(bridge => {
    if (active && !closing) {
    session.current = bridge;
    if (!surface) registerActiveAppSession(projectDir, chatId, callId, resolvedTitle, bridge, resolvedPath);
    else if (bridgeRef.current) bridgeRef.current(bridge, mount);
    frame.current.src = mount.url;
    }
    else bridge.close();
    }).catch(fail);
    const poll = setInterval(async () => {
    try { const result = await post('/status', {}); if (result.status !== 200) await fail(new Error(result.body.error)); }
    catch (error) { if (active) await fail(error); }
    }, 5000);
    // An extension view follows the active theme.
    const onTheme = () => {
      if (!surface || !session.current) return;
      const t = themeHostContext();
      session.current.updateHostContext({ theme: t.theme, styles: t.styles, mouaif: { ...surfaceHostContext({ ...surface, chatId }).mouaif } });
    };
    window.addEventListener(THEME_PAINTED, onTheme);
    return () => {
    active = false; closeView.current = null; clearTimeout(timeout); clearInterval(poll); ctl.abort();
    window.removeEventListener(THEME_PAINTED, onTheme);
    if (surface && bridgeRef.current) bridgeRef.current(null);
    if (!surface) unregisterActiveAppSession(callId, session.current);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mount]);

  function changeMode() {
    applyMode(mode === 'inline' ? 'fullscreen' : 'inline');
  }
  if (unavailable) return null;
  const isFullscreen = mode === 'fullscreen';
  return h('dialog', {
    ref: sheetRef,
    open: isFullscreen ? undefined : true,
    class: 'mcp-app' + (isFullscreen ? ' mcp-app--fullscreen' : ''),
    role: isFullscreen ? 'dialog' : 'region',
    'aria-modal': isFullscreen ? 'true' : undefined,
    'aria-label': resolvedTitle || 'MCP App',
    'data-surface': surface ? surface.slot : undefined
  },
    h('header', { class: 'mcp-app__header' },
      h('strong', { class: 'mcp-app__title' }, resolvedTitle || 'MCP App'),
      mount && !failed && h('button', {
        type: 'button',
        class: 'btn mcp-app__btn mcp-app__btn--mode' + (isFullscreen ? ' is-active' : ''),
        onClick: changeMode,
        'aria-pressed': String(isFullscreen),
        'aria-label': isFullscreen ? 'Exit fullscreen' : 'Fullscreen app',
        title: isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen app'
      },
        h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' },
          h('path', {
            d: isFullscreen
              ? 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5'
              : 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
            fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
          })
        ),
        h('span', null, isFullscreen ? 'Inline' : 'Fullscreen')
      ),
      mount && !failed && h('button', {
        type: 'button',
        class: 'btn mcp-app__btn mcp-app__btn--close',
        onClick: () => closeView.current?.(),
        'aria-label': 'Close app',
        title: 'Close app'
      }, 'Close'),
      failed && h('button', {
        type: 'button',
        class: 'btn mcp-app__btn mcp-app__btn--retry',
        onClick: () => setGeneration(n => n + 1)
      }, 'Retry')
    ),
    status && h('p', { role: 'status' }, status),
    mount && !failed && h('iframe', { ref: frame, title: mount.title,
      sandbox: mount.origin === 'null' ? 'allow-scripts' : 'allow-scripts allow-same-origin',
      referrerPolicy: 'origin',
      allow: "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'",
      style: { height: isFullscreen ? '100%' : height + 'px' } })
  );
}

// One shared observer for imperative/recycled rows, only while apps exist.
// DOM connectivity checks do not trigger layout or poll detached nodes.
const mountedContainers = new Set();
let removalObserver;
const activeAppSessions = new Map();
const activeAppFrames = new Map();
const pendingAgentMessages = new Map();

function normalizeAppPath(value) {
  return typeof value === 'string' ? value.trim().replace(/^\.\/+/, '') : '';
}

function registerActiveAppFrame(projectDir, chatId, callId, entry) {
  activeAppFrames.set(callId, { projectDir, chatId, callId, ...entry, at: Date.now() });
}

function unregisterActiveAppFrame(callId, reload) {
  const entry = activeAppFrames.get(callId);
  if (entry && (!reload || entry.reload === reload)) activeAppFrames.delete(callId);
}

export function reloadMcpApp(projectDir, chatId, payload = {}) {
  if (!projectDir || !chatId) return false;
  const wantedCallId = typeof payload.callId === 'string' && payload.callId ? payload.callId : '';
  const wantedPath = normalizeAppPath(payload.path);
  const wantedName = typeof payload.name === 'string' && payload.name.trim() && payload.name !== 'On-the-fly app'
    ? payload.name.trim()
    : '';
  const candidates = [];
  for (const entry of activeAppFrames.values()) {
    if (entry.projectDir === projectDir && entry.chatId === chatId) candidates.push(entry);
  }
  let target = null;
  if (wantedCallId) {
    target = candidates.find(entry => entry.callId === wantedCallId) || null;
  }
  if (!target && wantedPath) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].path && candidates[i].path === wantedPath) { target = candidates[i]; break; }
    }
  }
  if (!target && wantedName) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].title === wantedName) { target = candidates[i]; break; }
    }
  }
  if (!target) return false;
  target.reload(payload);
  return true;
}

function registerActiveAppSession(projectDir, chatId, callId, title, bridge, path = '') {
  activeAppSessions.set(callId, { projectDir, chatId, callId, title: title || '', path: normalizeAppPath(path), bridge, at: Date.now() });
}

function unregisterActiveAppSession(callId, bridge) {
  const entry = activeAppSessions.get(callId);
  if (entry && (!bridge || entry.bridge === bridge)) activeAppSessions.delete(callId);
}

function consumePendingAgentMessages(projectDir, chatId, title) {
  const key = projectDir + '::' + chatId;
  const list = pendingAgentMessages.get(key);
  if (!Array.isArray(list) || !list.length) return [];
  const keep = [];
  const matched = [];
  for (const item of list) {
    if (!item.name || item.name === 'On-the-fly app' || item.name === title) matched.push(item);
    else keep.push(item);
  }
  if (keep.length) pendingAgentMessages.set(key, keep);
  else pendingAgentMessages.delete(key);
  return matched;
}

export function deliverMcpAppMessage(projectDir, chatId, payload) {
  if (!projectDir || !chatId || !payload || typeof payload.message !== 'string') return false;
  const candidates = [];
  for (const entry of activeAppSessions.values()) {
    if (entry.projectDir === projectDir && entry.chatId === chatId) candidates.push(entry);
  }
  const wantedName = typeof payload.name === 'string' && payload.name.trim() && payload.name !== 'On-the-fly app'
    ? payload.name.trim()
    : '';
  let target = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!wantedName || candidates[i].title === wantedName) { target = candidates[i]; break; }
  }
  if (!target && candidates.length) target = candidates[candidates.length - 1];
  if (target) {
    Promise.resolve(target.bridge.sendAgentMessage(payload)).then(sent => {
      if (!sent) queuePendingAgentMessage(projectDir, chatId, payload);
    }).catch(() => {});
    return true;
  }
  queuePendingAgentMessage(projectDir, chatId, payload);
  return false;
}

function queuePendingAgentMessage(projectDir, chatId, payload) {
  const key = projectDir + '::' + chatId;
  const list = pendingAgentMessages.get(key) || [];
  list.push(payload);
  if (list.length > 16) list.shift();
  pendingAgentMessages.set(key, list);
}

export function mountMcpApp(container, props) {
  render(h(McpAppFrame, props), container);
  mountedContainers.add(container);
  if (!removalObserver) {
    removalObserver = new MutationObserver(() => {
      for (const node of mountedContainers) {
        if (!node.isConnected) { mountedContainers.delete(node); render(null, node); }
      }
      if (!mountedContainers.size) { removalObserver.disconnect(); removalObserver = null; }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
  }
}
