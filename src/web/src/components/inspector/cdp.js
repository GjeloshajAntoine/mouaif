// Inspector CDP (Chrome DevTools Protocol) connection helpers
// Manages the WebSocket connection, command dispatch, and event listeners.

export function createCdpConnection() {
  const wsRef = { current: null };
  const lastProxyError = { current: null };
  const cmdId = { current: 1 };
  const pending = new Map();
  const listeners = new Map();

  function cdpSend(method, params) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('not connected'));
    const id = cmdId.current++;
    const msg = JSON.stringify({ id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { ws.send(msg); }
      catch (e) { pending.delete(id); reject(e); }
    });
  }

  function cdpOn(eventName, handler) {
    let set = listeners.get(eventName);
    if (!set) { set = new Set(); listeners.set(eventName, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  function wsOnMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    if (typeof msg.id === 'number') {
      const slot = pending.get(msg.id);
      if (slot) {
        pending.delete(msg.id);
        if (msg.error) slot.reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: msg.error.code }));
        else slot.resolve(msg.result || {});
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const set = listeners.get(msg.method);
      if (set) for (const fn of set) { try { fn(msg.params || {}); } catch { /* ignore handler errors */ } }
    }
  }

  function disconnect() {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try { ws.close(1000, 'client disconnect'); } catch { /* ignore */ }
    }
    for (const slot of pending.values()) {
      try { slot.reject(new Error('disconnected')); } catch { /* ignore */ }
    }
    pending.clear();
    listeners.clear();
  }

  function connect(debuggerUrl, targetId) {
    if (wsRef.current) disconnect();
    const host = encodeURIComponent(debuggerUrl);
    const tid = encodeURIComponent(targetId);
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const proxyUrl = proto + '//' + window.location.host + '/api/inspector/proxy?host=' + host + '&targetId=' + tid;
    let ws;
    try { ws = new WebSocket(proxyUrl); }
    catch (e) { return { error: 'WebSocket open failed: ' + (e.message || e) }; }
    wsRef.current = ws;
    ws.addEventListener('message', wsOnMessage);
    // Surface the server's typed error body when the proxy rejects the
    // upgrade (e.g. "target not found"). The raw WebSocket error event
    // carries no message, so without this the UI can only say "WebSocket
    // error". The proxy writes a small JSON body before closing, which we
    // read as a text message on the erroring socket.
    ws.addEventListener('error', () => {
      // Nothing useful in the event itself; the server's body arrives as
      // a text frame or via the close reason. See close handler below.
    });
    ws.addEventListener('close', (ev) => {
      if (ev && typeof ev.reason === 'string' && ev.reason && ev.reason !== 'client disconnect') {
        wsRef.current = null;
        lastProxyError.current = ev.reason;
      }
    });
    return { ws, cdpSend, cdpOn, disconnect: () => disconnect() };
  }

  return { wsRef, cdpSend, cdpOn, connect, disconnect, pending, listeners, cmdId, lastProxyError };
}