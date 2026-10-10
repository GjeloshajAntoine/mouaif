// Test-only flattened CDP sessions: inspect cross-process sandbox frames
// without disabling Chrome's normal site isolation.
import WebSocket from 'ws';

export async function connectAppCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let next = 0;
  const pending = new Map();
  const sessions = new Map();
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 45000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  socket.on('message', raw => {
    const event = JSON.parse(raw);
    const waiting = pending.get(event.id);
    if (waiting) {
      clearTimeout(waiting.timer); pending.delete(event.id);
      if (event.error) waiting.reject(new Error(JSON.stringify(event.error)));
      else waiting.resolve(event.result);
    }
    if (event.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = event.params;
      const session = { targetInfo, contexts: new Map() };
      sessions.set(sessionId, session);
      // Recursively attach child OOPIFs, including the opaque inner view.
      session.ready = Promise.all([
        send('Runtime.enable', {}, sessionId),
        send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
          filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, sessionId),
        send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      ]).catch(() => {});
    }
    if (event.method === 'Runtime.executionContextCreated') {
      sessions.get(event.sessionId)?.contexts.set(event.params.context.id, event.params.context);
    }
    if (event.method === 'Runtime.executionContextDestroyed') sessions.get(event.sessionId)?.contexts.delete(event.params.executionContextId);
    if (event.method === 'Runtime.executionContextsCleared') sessions.get(event.sessionId)?.contexts.clear();
    if (event.method === 'Target.detachedFromTarget') sessions.delete(event.params.sessionId);
  });
  return {
    send,
    async attachFrames() {
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }] });
    },
    async evaluate(expression, sessionId, contextId) {
      const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true,
        ...(contextId ? { contextId } : {}) }, sessionId);
      if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails));
      return out.result.value;
    },
    async appContext() {
      for (const [sessionId, session] of sessions) {
        await session.ready;
        for (const context of session.contexts.values()) {
          if (!context.auxData?.isDefault) continue;
          try {
            if (await this.evaluate("!!document.querySelector('#ready')", sessionId, context.id)) {
              return expression => this.evaluate(expression, sessionId, context.id);
            }
          } catch { /* context navigated while inspecting */ }
        }
      }
      return null;
    },
    close() {
      for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('CDP closed')); }
      pending.clear(); socket.close();
    }
  };
}
