'use strict';
// Shared graceful-restart scheduler used by the HTTP API and the native
// restart_app chat tool. The caller sends its response/tool result first;
// the delayed callback then stops MCP children and hands control back to
// the serve supervisor through lifecycle.restart().
const mcp = require('./mcp.js');

function clampDelay(value, fallback = 150) {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.round(value), 5000)) : fallback;
}

function requestRestart(options = {}) {
  const lifecycle = options.lifecycle || {};
  const reason = typeof options.reason === 'string' && options.reason.trim()
    ? options.reason.trim().slice(0, 500)
    : 'user-requested';
  const delayMs = clampDelay(options.delayMs, Number.isFinite(options.defaultDelayMs) ? options.defaultDelayMs : 150);
  if (lifecycle.restarting) {
    return { ok: false, restarting: true, error: 'Restart already in progress' };
  }
  lifecycle.restarting = true;
  const result = {
    ok: true,
    restarting: true,
    reason,
    delayMs,
    mode: typeof lifecycle.restart === 'function' ? 'relaunch' : 'exit'
  };
  setTimeout(async () => {
    try { process.stdout.write('[mouaif] restart requested: ' + reason + '\n'); } catch (_) {}
    try { await mcp.stopAll(); } catch (_) { /* best-effort */ }
    if (typeof lifecycle.restart === 'function') {
      try {
        await lifecycle.restart({ reason });
        lifecycle.restarting = false;
        return;
      } catch (error) {
        try { process.stderr.write('[mouaif] restart failed: ' + (error && error.message || error) + '\n'); } catch (_) {}
        lifecycle.restarting = false;
      }
    }
    process.exit(0);
  }, delayMs).unref();
  return result;
}

module.exports = { requestRestart, clampDelay };
