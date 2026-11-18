import { h } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { fetchJson } from '../../api.js';
import { useModal } from '../../hooks/useModal.js';
import { parseMcpJson, serverTargetSummary } from './mcpJsonImport.js';

const EXAMPLE_JSON = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}`;

export function McpJsonImportSheet({ projectDir = '', onClose, onImported }) {
  const sheetRef = useModal({ onClose });
  const scope = projectDir ? 'project' : 'app';
  const [text, setText] = useState('');
  const [startAfter, setStartAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ text: '', kind: '' });

  const preview = useMemo(() => (text.trim() ? parseMcpJson(text) : null), [text]);
  const validServers = preview ? preview.servers : [];
  const parseErrors = preview ? preview.errors : [];

  async function runImport() {
    if (busy || !validServers.length) return;
    setBusy(true);
    setStatus({ text: 'Importing ' + validServers.length + ' server' + (validServers.length === 1 ? '' : 's') + '…', kind: 'busy' });
    const added = [];
    const failed = [];
    for (const spec of validServers) {
      try {
        const r = await fetchJson('/api/mcp/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({}, spec, { scope, projectDir }))
        });
        if ((r.status === 201 || r.status === 200) && r.body && r.body.server) {
          added.push(r.body.server);
        } else {
          failed.push(spec.name + ': ' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        }
      } catch {
        failed.push(spec.name + ': network error');
      }
    }
    if (startAfter && added.length) {
      setStatus({ text: 'Starting imported server' + (added.length === 1 ? '' : 's') + '…', kind: 'busy' });
      for (const s of added) {
        try {
          await fetchJson('/api/mcp/servers/' + encodeURIComponent(s.id) + '/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir: scope === 'app' ? '' : projectDir })
          });
        } catch { /* row status shows any start error */ }
      }
    }
    setBusy(false);
    if (added.length && onImported) onImported(added);
    if (failed.length) {
      setStatus({
        text: (added.length ? 'Imported ' + added.length + '. ' : '') + 'Failed: ' + failed.join('; '),
        kind: 'error'
      });
    } else if (added.length) {
      if (onClose) onClose();
    }
  }

  return h('div', {
    class: 'mcps__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Import MCP JSON',
    onClick: (e) => { if (e.target === e.currentTarget && onClose) onClose(); }
  },
    h('div', { class: 'mcps__sheet mcp-import__sheet', ref: sheetRef },
      h('div', { class: 'mcps-sheet__head' },
        h('div', { class: 'mcps-sheet__titles' },
          h('div', { class: 'mcps-sheet__title' }, 'Import MCP JSON'),
          h('div', { class: 'mcps-sheet__pub' }, 'Paste a standard mcpServers / .mcp.json block')
        ),
        h('button', { class: 'icon-btn mcps-sheet__close', type: 'button', onClick: onClose, 'aria-label': 'Close' },
          h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
            h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })))
      ),
      h('div', { class: 'mcps-sheet__body' },
        h('p', { class: 'hint hint--compact mcps-sheet__hint' }, projectDir
        ? 'Servers will be added to this project. Review secrets before committing .mcp.json.'
        : 'Servers will be added to App defaults (available in every project).'),
        h('div', { class: 'row mcps-field' },
          h('div', { class: 'mcp-import__label-row' },
            h('label', { class: 'label', for: 'mcp-import-json' }, 'JSON configuration'),
            !text.trim()
              ? h('button', { class: 'btn btn--small', type: 'button', onClick: () => setText(EXAMPLE_JSON) }, 'Paste example')
              : h('button', { class: 'btn btn--small', type: 'button', onClick: () => setText('') }, 'Clear')
          ),
          h('textarea', {
            class: 'input mcp-import__textarea',
            id: 'mcp-import-json',
            rows: 8,
            spellcheck: false,
            autocapitalize: 'off',
            autocomplete: 'off',
            placeholder: EXAMPLE_JSON,
            value: text,
            onInput: (e) => { setText(e.target.value); setStatus({ text: '', kind: '' }); }
          }),
          h('span', { class: 'hint hint--compact mcps-field__hint' },
            'Supports Claude Desktop / Cursor ("mcpServers"), VS Code ("servers"), mouaif .mcp.json, or a single server object.')
        ),
        parseErrors.length
          ? h('div', { class: 'mcps-note mcps-note--warn mcp-import__errors', role: 'alert' },
              parseErrors.map((errText, idx) => h('div', { key: idx }, errText)))
          : null,
        validServers.length
          ? h('div', { class: 'mcps-sheet__section' },
              h('div', { class: 'mcps-sheet__label' }, 'Ready to add (' + validServers.length + ')'),
              h('ul', { class: 'mcp-import__preview' },
                validServers.map((s, idx) => {
                  const envCount = Object.keys(s.env || {}).length;
                  const headerCount = Object.keys(s.headers || {}).length;
                  return h('li', { key: s.name + '-' + idx, class: 'mcp-import__item' },
                    h('div', { class: 'mcp-import__item-head' },
                      h('span', { class: 'mcp-import__item-name' }, s.name),
                      h('span', { class: 'mcp__scope mcp__scope--' + (scope === 'app' ? 'app' : 'project') }, s.transport)
                    ),
                    h('div', { class: 'mcp-import__item-sub' }, serverTargetSummary(s)),
                    (envCount || headerCount)
                      ? h('div', { class: 'mcp-import__item-secrets' },
                          envCount ? envCount + ' env key' + (envCount === 1 ? '' : 's') : '',
                          envCount && headerCount ? ' · ' : '',
                          headerCount ? headerCount + ' header' + (headerCount === 1 ? '' : 's') : '')
                      : null
                  );
                })
              ),
              h('label', { class: 'mcp-import__start-opt' },
                h('input', {
                  class: 'checkbox',
                  type: 'checkbox',
                  checked: startAfter,
                  onChange: (e) => setStartAfter(e.target.checked)
                }),
                h('span', null, 'Start imported servers immediately to discover tools')
              )
            )
          : null
      ),
      h('div', { class: 'mcps-sheet__foot' },
        h('span', { class: 'status mcps-sheet__status', 'data-state': status.kind || undefined, role: 'status', 'aria-live': 'polite' }, status.text),
        h('button', { class: 'btn', type: 'button', onClick: onClose, disabled: busy }, 'Cancel'),
        h('button', {
          class: 'btn btn--primary mcps-sheet__install',
          type: 'button',
          disabled: busy || !validServers.length,
          onClick: runImport
        }, busy ? 'Importing…' : ('Import' + (validServers.length ? ' (' + validServers.length + ')' : '')))
      )
    )
  );
}
