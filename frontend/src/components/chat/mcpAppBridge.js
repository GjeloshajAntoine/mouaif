import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';

// The SDK transport checks source but posts to '*'. This host transport also
// pins the sandbox origin (or '*' when the outer proxy is an opaque 'null'
// origin served with CSP sandbox) and never sends app data to a navigated frame.
export function originTransport(target, origin) {
  let listener;
  const targetOrigin = origin === 'null' ? '*' : origin;
  return {
    async start() {
      listener = event => {
        if (event.source !== target || event.origin !== origin || event.data?.jsonrpc !== '2.0') return;
        this.onmessage?.(event.data);
      };
      window.addEventListener('message', listener);
    },
    async send(message) { target.postMessage(message, targetOrigin); },
    async close() { window.removeEventListener('message', listener); this.onclose?.(); }
  };
}

export function boundedHeight(height, viewport) {
  return Number.isFinite(height) ? Math.max(176, Math.min(height, viewport * 0.7)) : 288;
}

export async function connectMcpApp({ iframe, mount, onReady, onSize, onMode, onCall, onMessage, onClose }) {
  let initialized = false;
  let closed = false;
  const bridge = new AppBridge(null, { name: 'mouaif', version: '1' }, {
    serverTools: {}, message: { text: {} }, sandbox: { csp: mount.csp, permissions: {} }
  }, { hostContext: {
    displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: { width: iframe.clientWidth || 360, maxHeight: window.innerHeight * 0.7 },
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } });
  bridge.onsandboxready = () => {
    if (!closed) bridge.sendSandboxResourceReady({ html: mount.html, sandbox: 'allow-scripts' }).catch(onClose);
  };
  bridge.oninitialized = async () => {
    if (initialized || closed) return;
    initialized = true;
    try {
      await bridge.sendToolInput({ arguments: mount.arguments });
      if (mount.result?.code === 'EABORTED') await bridge.sendToolCancelled({ reason: 'Tool cancelled' });
      else await bridge.sendToolResult(mount.result);
      onReady();
    } catch (error) { onClose(error); }
  };
  bridge.oncalltool = async (params, extra) => {
    if (!initialized || closed) throw new Error('App is not initialized');
    return onCall(params, extra.mcpReq.signal);
  };
  bridge.onmessage = async (params, extra) => {
    if (!initialized || closed) throw new Error('App is not initialized');
    return onMessage(params, extra.mcpReq.signal);
  };
  bridge.onsizechange = ({ height }) => { if (initialized && !closed) onSize(height); };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    if (!initialized || closed) throw new Error('App is not initialized');
    const accepted = mode === 'fullscreen' ? 'fullscreen' : 'inline';
    onMode(accepted);
    bridge.setHostContext({ displayMode: accepted });
    return { mode: accepted };
  };
  bridge.onrequestteardown = onClose;
  // Open links, downloads and model-context mutation are deliberately
  // unsupported. The SDK returns typed unknown/unsupported method errors.
  await bridge.connect(originTransport(iframe.contentWindow, mount.origin));
  return {
    setMode(mode) { bridge.setHostContext({ displayMode: mode }); },
    async close() {
      if (closed) return;
      closed = true;
      if (initialized) {
        try { await bridge.teardownResource({}, { timeout: 500 }); } catch { /* bounded fallback */ }
      }
      await bridge.close();
    }
  };
}
