// Trusted outer proxy, served only by the isolated sandbox listener.
(() => {
  if (window.parent === window || !document.referrer) return;
  const hostOrigin = new URL(document.referrer).origin;
  if (hostOrigin === location.origin) return;
  try { void window.parent.document; return; } catch { /* isolation confirmed */ }
  const inner = document.createElement('iframe');
  inner.setAttribute('sandbox', 'allow-scripts');
  inner.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
  document.documentElement.appendChild(inner);
  let loaded = false;
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.jsonrpc !== '2.0') return;
    if (event.source === window.parent && event.origin === hostOrigin) {
      if (data.method === 'ui/notifications/sandbox-resource-ready') {
        if (loaded || typeof data.params?.html !== 'string') return;
        loaded = true;
        // This child has an opaque origin, and inherits tamper-proof HTTP CSP.
        inner.srcdoc = data.params.html;
      } else if (!data.method?.startsWith('ui/notifications/sandbox-')) {
        inner.contentWindow.postMessage(data, '*');
      }
    } else if (loaded && event.source === inner.contentWindow && event.origin === 'null') {
      if (data.method?.startsWith('ui/notifications/sandbox-')) return;
      window.parent.postMessage(data, hostOrigin);
    }
  });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, hostOrigin);
})();
