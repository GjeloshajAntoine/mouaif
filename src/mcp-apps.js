'use strict';

// Reviewed official extension, not a claim that the web host is implemented.
const PROTOCOL_VERSION = '2026-01-26';
const REVIEWED_REVISION = '82221c0c8ce7661efa6771c9d461511b1650495f';
const MIME_TYPE = 'text/html;profile=mcp-app';
const MAX_HTML_BYTES = 1024 * 1024;
const { err } = require('./util.js');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUiUri(value) {
  return typeof value === 'string' && value.startsWith('ui://') && value.length <= 4096
    && !/[\s\x00-\x1f\x7f]/.test(value) && value.length > 5;
}

// Only preserve recognized tool metadata; never trust arbitrary _meta as host config.
function normalizeToolMeta(meta) {
  if (!isObject(meta)) return null;
  const ui = isObject(meta.ui) ? meta.ui : {};
  const out = {};
  const uri = ui.resourceUri === undefined ? meta['ui/resourceUri'] : ui.resourceUri;
  if (isUiUri(uri)) out.resourceUri = uri;
  if (ui.visibility !== undefined) {
    // Malformed explicit visibility fails closed, rather than granting both callers.
    out.visibility = Array.isArray(ui.visibility)
      ? [...new Set(ui.visibility.filter(v => v === 'model' || v === 'app'))]
      : [];
  }
  return Object.keys(out).length ? { ui: out } : null;
}

function toolVisibleTo(tool, caller) {
  const visibility = tool && tool._meta && tool._meta.ui && tool._meta.ui.visibility;
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes(caller));
}

function parseUiResource(result, uri) {
  const contents = result && result.contents;
  // Do not pick an unrelated resource out of a multi-content response.
  const matches = Array.isArray(contents) ? contents.filter(c => c && c.uri === uri) : [];
  if (matches.length !== 1 || matches[0].mimeType !== MIME_TYPE || typeof matches[0].text !== 'string') {
    throw err('EMCP_APP_RESOURCE', 'Expected one matching MCP App HTML resource', { uri });
  }
  const content = matches[0];
  if (Buffer.byteLength(content.text, 'utf8') > MAX_HTML_BYTES) {
    throw err('EMCP_APP_RESOURCE', 'MCP App HTML exceeds the 1 MiB limit', { uri });
  }
  const ui = isObject(content._meta) && isObject(content._meta.ui) ? content._meta.ui : {};
  // Return declared metadata as data only. A future host must validate/approve it
  // before constructing HTTP CSP and Permissions-Policy; never render this raw.
  return { uri, mimeType: MIME_TYPE, text: content.text, _meta: { ui } };
}

module.exports = {
  PROTOCOL_VERSION, REVIEWED_REVISION, MIME_TYPE, MAX_HTML_BYTES,
  isUiUri, normalizeToolMeta, toolVisibleTo, parseUiResource
};
