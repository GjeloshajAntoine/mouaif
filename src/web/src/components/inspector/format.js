// Inspector formatting helpers
// Pure functions for formatting timestamps, bytes, duration, etc.

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

export function statusLabel(s) {
  if (s === 'pending') return '···';
  if (s === 'failed') return 'FAIL';
  return String(s);
}

export function statusClass(s) {
  if (s === 'pending') return 'pending';
  if (s === 'failed') return 'failed';
  const n = Number(s);
  if (!isNaN(n) && n >= 400) return 'error';
  if (!isNaN(n) && n >= 300) return 'redirect';
  if (!isNaN(n) && n >= 200) return 'ok';
  return 'other';
}

export function fmtBytes(n) {
  if (typeof n !== 'number' || isNaN(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

export function fmtDur(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return '';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

// Render one CDP RemoteObject as DOM. Falls back to description / value.
export function appendRemoteObject(host, arg) {
  if (!arg) return;
  const span = document.createElement('span');
  span.className = 'inspector__arg inspector__arg--' + (arg.type || 'unknown');
  if (arg.type === 'object' && arg.preview && Array.isArray(arg.preview.properties)) {
    const props = arg.preview.properties;
    const shown = props.slice(0, 5).map((p) => p.name + ': ' + (p.value !== undefined ? p.value : (p.type || ''))).join(', ');
    span.textContent = (arg.className === 'Array' ? '[' : '{') + shown + (props.length > 5 ? ', …' : '') + (arg.className === 'Array' ? ']' : '}');
    span.title = arg.description || '';
  } else if (arg.type === 'string') {
    span.textContent = String(arg.value !== undefined ? arg.value : (arg.description || ''));
  } else if (typeof arg.value !== 'undefined') {
    span.textContent = String(arg.value);
  } else if (typeof arg.description !== 'undefined') {
    span.textContent = arg.description;
  } else if (arg.type === 'function') {
    span.textContent = 'ƒ ' + (arg.description || '');
  } else {
    span.textContent = arg.type || '';
  }
  host.appendChild(span);
}

export function argToString(arg) {
  if (!arg) return '';
  if (typeof arg.value !== 'undefined') return String(arg.value);
  if (typeof arg.description !== 'undefined') return arg.description;
  if (arg.type === 'function') return 'ƒ ' + (arg.description || '');
  return arg.type || '';
}