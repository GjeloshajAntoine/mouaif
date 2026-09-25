// mouaif web — MCP Registry install planning (pure, no DOM).
//
// Turns an official MCP Registry entry (registry.modelcontextprotocol.io,
// server.schema.json) into the install choices the store sheet offers and
// into the POST /api/mcp/servers body that installs one of them. Kept free
// of Preact so scripts/test-mcp-registry-install.mjs can run it in Node.
// See docs/features/mcp-registry-browser.md.

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

export function registryMeta(entry) {
  return (entry && entry._meta && entry._meta[OFFICIAL_META]) || {};
}

// friendlyName(entry) — what a person calls the server: its `title` when the
// publisher set one, else the last segment of the reverse-DNS name with
// dashes turned into spaces ("io.github.me/weather-mcp" -> "weather mcp").
export function friendlyName(entry) {
  const server = (entry && entry.server) || {};
  if (typeof server.title === 'string' && server.title.trim()) return server.title.trim();
  const name = String(server.name || (entry && entry.name) || '').trim();
  const last = name.includes('/') ? name.split('/').pop() : name;
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'MCP server';
}

// publisher(entry) — the namespace part of the qualified name, shown small
// under the title so two "github" servers can be told apart.
export function publisher(entry) {
  const name = String((entry && entry.server && entry.server.name) || '');
  return name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
}

// Registry inputs (environment variables, headers, arguments) share one
// shape. A field is what the sheet renders for one of them.
function toField(input, kind) {
  const value = input.value != null ? String(input.value) : (input.default != null ? String(input.default) : '');
  return {
    kind,                                   // 'env' | 'header'
    name: String(input.name || ''),
    description: typeof input.description === 'string' ? input.description : '',
    required: input.isRequired === true,
    secret: input.isSecret === true,
    placeholder: typeof input.placeholder === 'string' ? input.placeholder : '',
    value,
    choices: Array.isArray(input.choices) ? input.choices.map(String) : []
  };
}

// Registry arguments -> argv. Named args become `--flag value` (or just the
// flag when it has no value); positional args contribute their value. An
// argument with no value or default is left out — the user can add it in the
// server editor after install.
function argv(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') { if (typeof a === 'string') out.push(a); continue; }
    const value = a.value != null ? String(a.value) : (a.default != null ? String(a.default) : '');
    if (a.type === 'named') {
      if (!a.name) continue;
      out.push(String(a.name));
      if (value) out.push(value);
    } else if (value) {
      out.push(value);
    }
  }
  return out;
}

// packageCommand(pkg) -> { command, args } | null
function packageCommand(pkg) {
  const type = String(pkg.registryType || pkg.type || '').toLowerCase();
  const id = String(pkg.identifier || pkg.packageName || pkg.name || '').trim();
  if (!id) return null;
  const version = pkg.version && pkg.version !== 'latest' ? String(pkg.version) : '';
  const runtimeArgs = argv(pkg.runtimeArguments);
  const packageArgs = argv(pkg.packageArguments || pkg.arguments);
  if (type === 'npm') {
    const command = pkg.runtimeHint || 'npx';
    const pre = command === 'npx' && !runtimeArgs.includes('-y') ? ['-y'] : [];
    return { command, args: pre.concat(runtimeArgs, [version ? id + '@' + version : id], packageArgs) };
  }
  if (type === 'pypi') {
    return { command: pkg.runtimeHint || 'uvx', args: runtimeArgs.concat([id], packageArgs) };
  }
  if (type === 'oci') {
    // Registry identifiers already carry the tag (docker.io/org/img:1.0).
    // `-e NAME` forwards each declared variable from the child env into
    // the container (docker reads the value from its own environment).
    const pre = runtimeArgs[0] === 'run' ? runtimeArgs : ['run', '-i', '--rm'].concat(runtimeArgs);
    const envFlags = [];
    for (const ev of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
    if (ev && ev.name) envFlags.push('-e', String(ev.name));
    }
    return { command: pkg.runtimeHint || 'docker', args: pre.concat(envFlags, [id], packageArgs) };
  }
  if (type === 'nuget') {
    return { command: pkg.runtimeHint || 'dnx', args: runtimeArgs.concat([version ? id + '@' + version : id, '--yes'], packageArgs) };
  }
  if (pkg.runtimeHint) return { command: pkg.runtimeHint, args: runtimeArgs.concat([id], packageArgs) };
  return null;
}

const RUNTIME_LABEL = { npm: 'Node.js (npx)', pypi: 'Python (uvx)', oci: 'Docker', nuget: '.NET (dnx)' };

// installOptions(entry) -> Option[]
//
// Every way mouaif can run this server, best first: a hosted Streamable
// HTTP endpoint needs nothing installed locally, so it leads; then local
// stdio packages. SSE-only remotes and non-stdio packages are returned with
// `supported: false` and a reason so the sheet can explain instead of
// silently hiding them.
//
// Option: { key, kind: 'remote'|'local', label, detail, supported, reason,
//           transport, url?, command?, args?, fields: Field[] }
export function installOptions(entry) {
  const server = (entry && entry.server) || {};
  const out = [];
  (Array.isArray(server.remotes) ? server.remotes : []).forEach((r, i) => {
    if (!r || !r.url) return;
    const type = String(r.type || '');
    const supported = type === 'streamable-http' || type === 'http';
    out.push({
      key: 'remote-' + i,
      kind: 'remote',
      label: 'Hosted',
      detail: r.url,
      supported,
      reason: supported ? '' : 'Uses the older SSE transport, which mouaif does not support yet.',
      transport: 'http',
      url: String(r.url),
      fields: (Array.isArray(r.headers) ? r.headers : []).filter((x) => x && x.name).map((x) => toField(x, 'header'))
    });
  });
  (Array.isArray(server.packages) ? server.packages : []).forEach((p, i) => {
    if (!p) return;
    const type = String(p.registryType || p.type || '').toLowerCase();
    const transport = (p.transport && p.transport.type) || 'stdio';
    const cmd = packageCommand(p);
    const supported = !!cmd && transport === 'stdio';
    out.push({
      key: 'pkg-' + i,
      kind: 'local',
      label: RUNTIME_LABEL[type] || (type || 'Local'),
      detail: cmd ? [cmd.command].concat(cmd.args).join(' ') : String(p.identifier || ''),
      supported,
      reason: supported ? '' : (cmd ? 'Runs as a local ' + transport + ' server, which mouaif cannot launch.' : 'Unknown package type "' + type + '".'),
      transport: 'stdio',
      command: cmd ? cmd.command : '',
      args: cmd ? cmd.args : [],
      fields: (Array.isArray(p.environmentVariables) ? p.environmentVariables : []).filter((x) => x && x.name).map((x) => toField(x, 'env'))
    });
  });
  // Stable: supported first, remote before local within each group.
  return out
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (Number(b.o.supported) - Number(a.o.supported)) || (a.o.kind === b.o.kind ? a.i - b.i : (a.o.kind === 'remote' ? -1 : 1)))
    .map((x) => x.o);
}

// summary(entry) -> { kind: 'remote'|'local'|'mixed'|'none', needsKey, supported }
// The one-line facts the result card shows without opening the sheet.
export function summary(entry) {
  const opts = installOptions(entry);
  const ok = opts.filter((o) => o.supported);
  const kinds = new Set(ok.map((o) => o.kind));
  const best = ok[0];
  return {
    kind: kinds.size === 2 ? 'mixed' : (kinds.has('remote') ? 'remote' : (kinds.has('local') ? 'local' : 'none')),
    runtime: ok.filter((o) => o.kind === 'local').map((o) => o.label)[0] || '',
    needsKey: !!best && best.fields.some((f) => f.required && !f.value),
    supported: ok.length > 0
  };
}

// missingRequired(option, values) -> string[]  names still empty
export function missingRequired(option, values) {
  const v = values || {};
  return (option ? option.fields : []).filter((f) => f.required && !String(v[f.name] != null ? v[f.name] : f.value).trim()).map((f) => f.name);
}

// buildServerBody(option, { name, scope, projectDir, values, oauth }) -> body
// for POST /api/mcp/servers. Empty optional fields are omitted so the
// server's own defaults apply.
export function buildServerBody(option, opts) {
  const o = opts || {};
  const values = o.values || {};
  const pick = (f) => String(values[f.name] != null ? values[f.name] : f.value).trim();
  const body = {
    projectDir: o.projectDir || null,
    scope: o.scope === 'project' && o.projectDir ? 'project' : 'app',
    name: String(o.name || '').trim() || 'MCP server',
    transport: option.transport
  };
  if (option.transport === 'http') {
    body.url = option.url;
    const headers = {};
    for (const f of option.fields) {
      const v = pick(f);
      if (!v) continue;
      // OAuth owns Authorization; a typed bearer would be ignored anyway.
      if (o.oauth && f.name.toLowerCase() === 'authorization') continue;
      headers[f.name] = v;
    }
    body.headers = headers;
    if (o.oauth) body.oauth = { enabled: true, clientId: '', scope: '' };
  } else {
    body.command = option.command;
    body.args = option.args.slice();
    const env = {};
    for (const f of option.fields) { const v = pick(f); if (v) env[f.name] = v; }
    body.env = env;
  }
  return body;
}

// findInstalled(entry, servers) -> configured server | null
// A registry entry counts as installed when a configured server points at
// one of its remote URLs, or runs one of its packages.
export function findInstalled(entry, servers) {
  const list = Array.isArray(servers) ? servers : [];
  const opts = installOptions(entry);
  const urls = new Set(opts.filter((o) => o.url).map((o) => o.url.replace(/\/+$/, '')));
  const ids = ((entry && entry.server && entry.server.packages) || []).map((p) => String(p && p.identifier || '')).filter(Boolean);
  for (const s of list) {
    if (!s) continue;
    if (s.url && urls.has(String(s.url).replace(/\/+$/, ''))) return s;
    const args = Array.isArray(s.args) ? s.args : [];
    if (ids.some((id) => args.some((a) => a === id || String(a).startsWith(id + '@') || String(a).startsWith(id + '==')))) return s;
  }
  return null;
}

// relativeDate(iso, now) -> "today" | "3 days ago" | "2 months ago" | ...
export function relativeDate(iso, now) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const days = Math.floor(((now || Date.now()) - t) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? 'a month ago' : months + ' months ago';
  const years = Math.floor(days / 365);
  return years <= 1 ? 'a year ago' : years + ' years ago';
}
