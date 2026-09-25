// mouaif web — McpStoreSheet: the install sheet of the MCP store.
//
// Opened from a store card. Shows what the server is, lets the user pick
// how to run it (hosted endpoint or a local package), asks only for the
// settings the registry says it needs (API keys first, optional ones
// folded away), installs it, then offers to start it right there so the
// user sees it work without leaving the store.
// See docs/features/mcp-registry-browser.md.
import { h } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { projectQS } from './projectQS.js';
import {
  friendlyName, publisher, installOptions, missingRequired, buildServerBody,
  registryMeta, relativeDate
} from './mcpRegistryInstall.js';

const RUNTIME_NEED = {
  npx: 'Node.js', node: 'Node.js', uvx: 'uv (Python)', python: 'Python',
  docker: 'Docker', dnx: 'the .NET SDK'
};

function safeHttpUrl(value) {
  try { const u = new URL(String(value || '')); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; }
  catch { return ''; }
}

export function editorHref(server, projectDir, from) {
  const scope = server.scope === 'app' ? 'app' : 'project';
  const qs = projectDir ? projectQS(projectDir) + '&scope=' + scope : '?scope=app';
  return '#/settings/mcp/' + encodeURIComponent(server.id) + qs + (from ? '&from=' + encodeURIComponent(from) : '');
}

export function McpStoreSheet(props) {
  const { entry, projectDir = '', from = '', installed = null, onClose, onInstalled } = props;
  const sheetRef = useModal({ onClose });
  const server = (entry && entry.server) || {};
  const options = useMemo(() => installOptions(entry), [entry]);
  const firstOk = options.find((o) => o.supported) || null;

  const [optionKey, setOptionKey] = useState(firstOk ? firstOk.key : '');
  const [values, setValues] = useState({});
  const [name, setName] = useState(friendlyName(entry));
  const [scope, setScope] = useState(projectDir ? 'project' : 'app');
  const option = options.find((o) => o.key === optionKey) || null;
  const needsBearer = !!option && option.fields.some((f) => f.kind === 'header' && f.name.toLowerCase() === 'authorization');
  // Hosted servers without a declared key usually sign in with OAuth (the
  // registry has no field for it), so that is the default there.
  const [auth, setAuth] = useState(firstOk && firstOk.kind === 'remote' && !firstOk.fields.length ? 'oauth' : 'key');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState({ text: '', kind: '' });
  const [created, setCreated] = useState(null);
  const [started, setStarted] = useState(null); // { ok, text }

  const meta = registryMeta(entry);
  const website = safeHttpUrl(server.websiteUrl);
  const repo = safeHttpUrl(server.repository && server.repository.url);
  const updated = relativeDate(meta.updatedAt || meta.publishedAt);
  const oauth = !!option && (option.transport === 'http' || option.transport === 'sse') && auth === 'oauth';
  const visibleFields = option ? option.fields.filter((f) => !(oauth && f.kind === 'header' && f.name.toLowerCase() === 'authorization')) : [];
  const required = visibleFields.filter((f) => f.required);
  const optional = visibleFields.filter((f) => !f.required);
  const missing = option ? missingRequired({ fields: visibleFields }, values) : [];

  function pickOption(key) {
    setOptionKey(key);
    setValues({});
    const next = options.find((o) => o.key === key);
    if (next && next.kind === 'remote') setAuth(next.fields.length ? 'key' : 'oauth');
    setMessage({ text: '', kind: '' });
  }

  async function install() {
    if (!option || busy) return;
    if (missing.length) { setMessage({ text: 'Fill in ' + missing.join(', ') + ' first.', kind: 'error' }); return; }
    setBusy('install');
    setMessage({ text: 'Installing…', kind: 'busy' });
    const body = buildServerBody(option, { name, scope, projectDir, values, oauth });
    try {
      const r = await fetchJson('/api/mcp/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status !== 201 && r.status !== 200) {
        setMessage({ text: 'Could not install: ' + ((r.body && r.body.error) || 'HTTP ' + r.status), kind: 'error' });
      } else {
        const s = Object.assign({ scope: body.scope }, r.body && r.body.server);
        setCreated(s);
        setMessage({ text: '', kind: '' });
        if (onInstalled) onInstalled(s);
      }
    } catch {
      setMessage({ text: 'Could not reach mouaif — check the app is still running.', kind: 'error' });
    }
    setBusy('');
  }

  async function start() {
    if (!created || busy) return;
    setBusy('start');
    setStarted({ ok: null, text: option && option.kind === 'local' ? 'Starting… the first run downloads the package, this can take a minute.' : 'Connecting…' });
    try {
      const r = await fetchJson('/api/mcp/servers/' + encodeURIComponent(created.id) + '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectDir })
      });
      if (r.status === 200) {
        const tools = (r.body && r.body.server && r.body.server.tools) || [];
        setStarted({ ok: true, text: 'Running · ' + tools.length + ' tool' + (tools.length === 1 ? '' : 's') + ' ready for your chats.' });
      } else {
        setStarted({ ok: false, text: ((r.body && r.body.error) || 'HTTP ' + r.status) });
      }
    } catch {
      setStarted({ ok: false, text: 'Could not reach mouaif — check the app is still running.' });
    }
    setBusy('');
  }

  function fieldRow(f) {
    const id = 'mcps-f-' + f.kind + '-' + f.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const value = values[f.name] != null ? values[f.name] : f.value;
    const set = (e) => setValues((prev) => Object.assign({}, prev, { [f.name]: e.target.value }));
    const isBearer = f.kind === 'header' && f.name.toLowerCase() === 'authorization';
    return h('div', { class: 'row mcps-field', key: id },
      h('label', { class: 'label mcps-field__label', for: id },
        h('span', { class: 'mcps-field__name' }, f.name),
        f.required ? h('span', { class: 'mcps-field__req' }, 'required') : null,
        f.secret ? h('span', { class: 'mcps-field__secret' }, 'secret') : null
      ),
      f.choices.length
        ? h('select', { class: 'input', id, value, onChange: set },
            f.required && !value ? h('option', { value: '' }, 'Choose…') : null,
            f.required ? null : h('option', { value: '' }, 'Default'),
            f.choices.map((c) => h('option', { value: c, key: c }, c)))
        : h('input', {
            class: 'input', id, value, onInput: set,
            type: f.secret ? 'password' : 'text',
            autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
            placeholder: f.placeholder || (isBearer ? 'Bearer your-token' : (f.value ? '' : (f.required ? '' : 'Leave empty for the default')))
          }),
      f.description ? h('span', { class: 'hint hint--compact mcps-field__hint' }, f.description) : null
    );
  }

  const scopeSeg = projectDir
    ? h('div', { class: 'mcps-sheet__section' },
        h('div', { class: 'mcps-sheet__label' }, 'Install for'),
        h('div', { class: 'seg mcps-seg', role: 'radiogroup', 'aria-label': 'Install for' },
          [['project', 'This project'], ['app', 'All projects']].map(([v, label]) =>
            h('label', { key: v, class: 'seg__item' + (scope === v ? ' seg__item--on' : '') },
              h('input', { type: 'radio', name: 'mcps-scope', value: v, checked: scope === v, onChange: () => setScope(v) }),
              h('span', { class: 'seg__pill' }, label)))
        ),
        h('span', { class: 'hint hint--compact mcps-sheet__hint' }, scope === 'project'
          ? 'Saved in this project\'s .mcp.json (secret values included — review before committing).'
          : 'Saved in the app, available in every project.')
      )
    : null;

  const runtimeNeed = option && option.kind === 'local' ? RUNTIME_NEED[option.command] : '';

  const body = created
    ? h('div', { class: 'mcps-sheet__body' },
        h('div', { class: 'mcps-done' },
          h('div', { class: 'mcps-done__check', 'aria-hidden': 'true' }, '✓'),
          h('div', { class: 'mcps-done__title' }, created.name + ' is installed'),
          h('div', { class: 'mcps-done__sub' }, created.scope === 'app' ? 'Available in every project.' : 'Available in this project.'),
          oauth
            ? h('p', { class: 'hint mcps-done__hint' }, 'This server signs in with OAuth. Open its settings and tap Sign in, then start it from the MCP list.')
            : started
              ? h('p', { class: 'mcps-done__start mcps-done__start--' + (started.ok === null ? 'busy' : (started.ok ? 'ok' : 'err')), role: 'status' }, started.text)
              : h('p', { class: 'hint mcps-done__hint' }, 'Start it now to check it works. Its tools then show up in your chats.')
        )
      )
    : h('div', { class: 'mcps-sheet__body' },
        server.description ? h('p', { class: 'mcps-sheet__desc' }, server.description) : null,
        h('div', { class: 'mcps-sheet__facts' },
          server.version ? h('span', null, 'v' + server.version) : null,
          updated ? h('span', null, 'Updated ' + updated) : null,
          website ? h('a', { href: website, target: '_blank', rel: 'noopener noreferrer' }, 'Website ↗') : null,
          repo ? h('a', { href: repo, target: '_blank', rel: 'noopener noreferrer' }, 'Source ↗') : null
        ),
        installed
          ? h('div', { class: 'mcps-note' },
              'Already installed as ', h('strong', null, installed.name), '. ',
              h('a', { href: editorHref(installed, projectDir, from) }, 'Open its settings'))
          : null,
        !options.length
          ? h('div', { class: 'mcps-note mcps-note--warn' }, 'The publisher did not list a package or endpoint, so mouaif cannot install this server automatically. Check its website or source for setup steps.')
          : h('div', { class: 'mcps-sheet__section' },
              h('div', { class: 'mcps-sheet__label' }, 'How to run it'),
              h('div', { class: 'mcps-opts', role: 'radiogroup', 'aria-label': 'How to run it' },
                options.map((o) => h('label', {
                  key: o.key,
                  class: 'mcps-opt' + (o.key === optionKey ? ' mcps-opt--on' : '') + (o.supported ? '' : ' mcps-opt--off')
                },
                  h('input', { type: 'radio', name: 'mcps-opt', value: o.key, checked: o.key === optionKey, disabled: !o.supported, onChange: () => pickOption(o.key) }),
                  h('span', { class: 'mcps-opt__body' },
                    h('span', { class: 'mcps-opt__title' }, o.kind === 'remote' ? 'Hosted — nothing to install' : 'Run on this machine · ' + o.label),
                    h('span', { class: 'mcps-opt__detail' }, o.detail),
                    o.reason ? h('span', { class: 'mcps-opt__reason' }, o.reason) : null
                  )
                ))
              ),
              runtimeNeed ? h('span', { class: 'hint hint--compact mcps-sheet__hint' }, 'Needs ' + runtimeNeed + ' installed where mouaif runs.') : null
            ),
        option && (option.transport === 'http' || option.transport === 'sse')
          ? h('div', { class: 'mcps-sheet__section' },
              h('div', { class: 'mcps-sheet__label' }, 'Sign-in'),
              h('div', { class: 'seg mcps-seg', role: 'radiogroup', 'aria-label': 'Sign-in' },
                [['key', needsBearer ? 'API key' : 'None'], ['oauth', 'OAuth sign-in']].map(([v, label]) =>
                  h('label', { key: v, class: 'seg__item' + (auth === v ? ' seg__item--on' : '') },
                    h('input', { type: 'radio', name: 'mcps-auth', value: v, checked: auth === v, onChange: () => setAuth(v) }),
                    h('span', { class: 'seg__pill' }, label)))
              ),
              h('span', { class: 'hint hint--compact mcps-sheet__hint' }, auth === 'oauth'
                ? 'You sign in with your account in the browser after installing. Tokens stay in the OS keychain.'
                : (needsBearer ? 'Paste the key the service gave you below.' : 'Pick OAuth if the service asks you to sign in.'))
            )
          : null,
        required.length
          ? h('div', { class: 'mcps-sheet__section' },
              h('div', { class: 'mcps-sheet__label' }, 'Required'),
              required.map(fieldRow))
          : null,
        option
          ? h('details', { class: 'mcps-more' },
              h('summary', { class: 'mcps-more__summary' }, 'More options' + (optional.length ? ' (' + (optional.length + 1) + ')' : '')),
              h('div', { class: 'row mcps-field' },
                h('label', { class: 'label', for: 'mcps-name' }, 'Name in mouaif'),
                h('input', { class: 'input', id: 'mcps-name', value: name, onInput: (e) => setName(e.target.value), autocomplete: 'off' })
              ),
              optional.map(fieldRow)
            )
          : null,
        option ? scopeSeg : null
      );

  const foot = created
    ? [
        h('a', { key: 'edit', class: 'btn', href: editorHref(created, projectDir, from) }, oauth ? 'Sign in' : 'Settings'),
        oauth ? null : h('button', { key: 'start', class: 'btn' + (started && started.ok ? '' : ' btn--primary'), type: 'button', disabled: !!busy || (started && started.ok), onClick: start },
          busy === 'start' ? 'Starting…' : (started && started.ok === false ? 'Try again' : (started && started.ok ? 'Running' : 'Start now'))),
        h('button', { key: 'done', class: 'btn' + (oauth || (started && started.ok) ? ' btn--primary' : ''), type: 'button', onClick: onClose }, 'Done')
      ]
    : [
        h('span', { key: 'msg', class: 'status mcps-sheet__status', 'data-state': message.kind || undefined, role: 'status', 'aria-live': 'polite' },
          message.text || (option && missing.length ? 'Needs ' + missing.join(', ') : '')),
        h('button', {
          key: 'install', class: 'btn btn--primary mcps-sheet__install', type: 'button',
          disabled: !option || !!busy || missing.length > 0 || !name.trim(),
          onClick: install
        }, busy === 'install' ? 'Installing…' : (installed ? 'Install again' : 'Install'))
      ];

  return h('div', {
    class: 'mcps__overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': friendlyName(entry),
    onClick: (e) => { if (e.target === e.currentTarget && onClose) onClose(); }
  },
    h('div', { class: 'mcps__sheet', ref: sheetRef },
      h('div', { class: 'mcps-sheet__head' },
        h('span', { class: 'mcps-avatar', style: avatarStyle(server.name), 'aria-hidden': 'true' }, initial(entry)),
        h('div', { class: 'mcps-sheet__titles' },
          h('div', { class: 'mcps-sheet__title' }, friendlyName(entry)),
          publisher(entry) ? h('div', { class: 'mcps-sheet__pub' }, publisher(entry)) : null
        ),
        h('button', { class: 'icon-btn mcps-sheet__close', type: 'button', onClick: onClose, 'aria-label': 'Close' },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
            h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })))
      ),
      body,
      h('div', { class: 'mcps-sheet__foot' }, foot)
    )
  );
}

// Letter avatar with a stable hue per server name — the registry has no
// reliable icons, and a coloured initial makes a long list scannable.
export function initial(entry) {
  const n = friendlyName(entry).replace(/^[^A-Za-z0-9]+/, '');
  return (n[0] || '?').toUpperCase();
}
export function avatarStyle(key) {
  let hash = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return 'background:hsl(' + (Math.abs(hash) % 360) + ' 45% 38%)';
}
