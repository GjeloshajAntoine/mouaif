import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { boundedHeight, connectMcpApp } from './mcpAppBridge.js';
import './mcp-app.css';

export function McpAppFrame({ projectDir, chatId, callId, onAuthorize }) {
  const frame = useRef(null);
  const session = useRef(null);
  const closeView = useRef(null);
  const authorize = useRef(onAuthorize);
  authorize.current = onAuthorize;
  const [mount, setMount] = useState(null);
  const [status, setStatus] = useState('Loading app…');
  const [mode, setMode] = useState('inline');
  const [height, setHeight] = useState(288);
  const [generation, setGeneration] = useState(0);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    const ctl = new AbortController();
    let id;
    setFailed(false); setUnavailable(false); setStatus('Loading app…'); setMount(null);
    fetchJson('/api/mcp/apps/mount', { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir, chatId, callId })
    }).then(async response => {
      if (!response.body?.enabled) {
        if (active) {
        if (response.status === 200 && response.body?.enabled === false) setUnavailable(true);
        else { setFailed(true); setStatus(response.body?.error || 'App unavailable — tool result shown below.'); }
        }
        return;
      }
      id = response.body.id;
      if (!active) {
        await fetch('/api/mcp/apps/' + id, { method: 'DELETE', body: '{}' }); return;
      }
      setMount(response.body);
    }).catch(error => { if (active) { setFailed(true); setStatus(error.message); } });
    return () => {
      active = false; ctl.abort();
      const closing = session.current; session.current = null;
      // Hook cleanup cannot await DOM removal. Teardown is best effort on
      // navigation/recycled rows; explicit failure waits before hiding a view.
      Promise.resolve(closing?.close()).finally(() => {
        if (id) fetch('/api/mcp/apps/' + id, { method: 'DELETE', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      });
    };
  }, [projectDir, chatId, callId, generation]);

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
    if (active) { setFailed(true); setStatus(error?.message || 'App closed — tool result shown below.'); setMode('inline'); }
    }
    };
    closeView.current = () => { void fail(new Error('App closed — Retry to reopen.')); };
    const onPageHide = () => { void fail(new Error('App paused — Retry to reopen.')); };
    const onVisibility = () => { if (document.hidden) onPageHide(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    const timeout = setTimeout(() => fail(new Error('App initialization timed out — tool result shown below.')), 10000);
    connectMcpApp({ iframe: frame.current, mount,
      onReady: () => { clearTimeout(timeout); if (active) setStatus(''); },
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
      if (active && !closing) { session.current = bridge; frame.current.src = mount.url; }
      else bridge.close();
    }).catch(fail);
    const poll = setInterval(async () => {
      try { const result = await post('/status', {}); if (result.status !== 200) await fail(new Error(result.body.error)); }
      catch (error) { if (active) await fail(error); }
    }, 5000);
    return () => {
    active = false; closeView.current = null; clearTimeout(timeout); clearInterval(poll); ctl.abort();
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mount]);

  function changeMode() {
    const next = mode === 'inline' ? 'fullscreen' : 'inline';
    setMode(next); session.current?.setMode(next);
  }
  if (unavailable) return null;
  return h('section', { class: 'mcp-app' + (mode === 'fullscreen' ? ' mcp-app--fullscreen' : ''), 'aria-label': 'MCP App' },
    h('header', { class: 'mcp-app__header' },
      h('strong', null, mount?.title || 'MCP App'),
      mount && !failed && h('button', { type: 'button', onClick: changeMode }, mode === 'inline' ? 'Fullscreen' : 'Inline'),
      mount && !failed && h('button', { type: 'button', onClick: () => closeView.current?.() }, 'Close'),
      failed && h('button', { type: 'button', onClick: () => setGeneration(n => n + 1) }, 'Retry')
    ),
    status && h('p', { role: 'status' }, status),
    mount && !failed && h('iframe', { ref: frame, title: mount.title,
      sandbox: mount.origin === 'null' ? 'allow-scripts' : 'allow-scripts allow-same-origin',
      referrerPolicy: 'origin',
      allow: "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'",
      style: { height: mode === 'fullscreen' ? '100%' : height + 'px' } })
  );
}

// One shared observer for imperative/recycled rows, only while apps exist.
// DOM connectivity checks do not trigger layout or poll detached nodes.
const mountedContainers = new Set();
let removalObserver;
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
