// mouaif web — Settings client domains view
//
// Manages allowed origins and API keys for external clients.
// One row per domain: shows origin pattern, masked API key prefix,
// and actions (regenerate key, delete, copy key).

import { h, Fragment } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import { fetchJson, setStatus } from '../api.js';
import { nav } from '../router.js';
import { loadClientDomains, createClientDomain, deleteClientDomain, regenerateClientKey } from '../api.js';

export function SettingsClientDomainsView() {
  const statusEl = useRef(null);
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const newOrigin = useRef(null);
  const newStatus = useRef(null);
  const [newKey, setNewKey] = useState(''); // shown once after creation

  async function load() {
    setLoading(true);
    setStatus(statusEl, 'loading…', 'busy');
    try {
      const list = await loadClientDomains();
      setDomains(list);
      setStatus(statusEl, list.length === 0 ? 'no domains configured' : '', '');
    } catch (e) {
      setStatus(statusEl, 'failed to load: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate() {
    const pattern = (newOrigin.current && newOrigin.current.value || '').trim();
    if (!pattern) { setStatus(newStatus, 'enter an origin pattern', 'error'); return; }
    setStatus(newStatus, 'creating…', 'busy');
    try {
      const domain = await createClientDomain(pattern);
      setNewKey(domain.apiKey);
      setDomains((prev) => prev.concat([{
        id: domain.id,
        origin_pattern: domain.originPattern,
        api_key_prefix: domain.apiKeyPrefix,
        created_at: domain.createdAt
      }]));
      if (newOrigin.current) newOrigin.current.value = '';
      setShowNew(false);
      setStatus(newStatus, 'domain created — copy the API key now (shown once)', 'success');
    } catch (e) {
      setStatus(newStatus, 'create failed: ' + e.message, 'error');
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this client domain? Any services using this API key will lose access.')) return;
    try {
      await deleteClientDomain(id);
      setDomains((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      setStatus(statusEl, 'delete failed: ' + e.message, 'error');
    }
  }

  async function handleRegenerate(id) {
    if (!confirm('Regenerate the API key? The old key will stop working immediately.')) return;
    try {
      const result = await regenerateClientKey(id);
      setNewKey(result.apiKey);
      setDomains((prev) => prev.map((d) => d.id === id ? { ...d, api_key_prefix: result.apiKeyPrefix } : d));
      setStatus(statusEl, 'new key generated — copy it now (shown once)', 'success');
    } catch (e) {
      setStatus(statusEl, 'regenerate failed: ' + e.message, 'error');
    }
  }

  function copyKey(key) {
    if (!key) return;
    navigator.clipboard.writeText(key).then(() => {
      setStatus(statusEl, 'API key copied to clipboard', 'success');
    }).catch(() => {
      setStatus(statusEl, 'could not copy — select the key manually', 'error');
    });
  }

  return h('section', { class: 'settings-client-domains' },
    h('div', { class: 'group' },
      h('div', { class: 'group__title' },
        'Client domains',
        h('span', { class: 'group__title-note' }, 'allowed origins & API keys')
      ),
      h('ul', { class: 'group__list' },
        domains.map((d) =>
          h('li', { key: d.id, class: 'group__row' },
            h('div', { class: 'group__row-body' },
              h('span', { class: 'group__row-label' }, d.origin_pattern),
              h('span', { class: 'group__row-detail' }, 'key: ' + d.api_key_prefix + '…')
            ),
            h('div', { class: 'group__row-actions' },
              h('button', {
                type: 'button',
                class: 'btn btn--small',
                onClick: () => handleRegenerate(d.id),
                'aria-label': 'Regenerate key for ' + d.origin_pattern
              }, 'New key'),
              h('button', {
                type: 'button',
                class: 'btn btn--small btn--danger',
                onClick: () => handleDelete(d.id),
                'aria-label': 'Delete ' + d.origin_pattern
              }, 'Delete')
            )
          )
        )
      ),
      domains.length === 0 && !loading
        ? h('p', { class: 'hint hint--compact' }, 'No client domains configured. Add one to generate an API key for external access.')
        : null
    ),

    // New API key display (shown once after creation)
    newKey
      ? h('div', { class: 'group' },
          h('div', { class: 'group__title' }, 'New API key'),
          h('div', { class: 'group__list' },
            h('div', { class: 'client-domain__key-display' },
              h('pre', { class: 'client-domain__key-value' }, newKey),
              h('button', {
                type: 'button',
                class: 'btn btn--small',
                onClick: () => copyKey(newKey)
              }, 'Copy key'),
              h('button', {
                type: 'button',
                class: 'btn btn--small',
                onClick: () => setNewKey('')
              }, 'Dismiss')
            )
          ),
          h('p', { class: 'hint hint--compact' }, 'This key is shown only once. Copy it now — you will not be able to see it again.')
        )
      : null,

    // Add new domain form
    showNew
      ? h('div', { class: 'group' },
          h('div', { class: 'group__title' }, 'New domain'),
          h('div', { class: 'group__list' },
            h('div', { class: 'form-row' },
              h('label', { class: 'form-row__label' }, 'Origin pattern'),
              h('input', {
                ref: newOrigin,
                type: 'text',
                class: 'input',
                placeholder: 'https://*.example.com',
                'aria-label': 'Origin pattern',
                onKeyDown: (e) => { if (e.key === 'Enter') handleCreate(); }
              })
            ),
            h('div', { class: 'form-row' },
              h('button', { type: 'button', class: 'btn btn--primary', onClick: handleCreate }, 'Create'),
              h('button', { type: 'button', class: 'btn', onClick: () => setShowNew(false) }, 'Cancel'),
              h('span', { ref: newStatus, class: 'status', role: 'status' })
            )
          )
        )
      : h('div', { class: 'group' },
          h('button', {
            type: 'button',
            class: 'btn btn--primary',
            onClick: () => setShowNew(true)
          }, 'Add domain')
        ),

    h('p', { class: 'hint hint--compact' },
      'Client domains let external services access the mouaif API. ' +
      'Each domain has a unique API key that is hashed and never stored in plaintext.'
    ),
    h('span', { ref: statusEl, class: 'status', role: 'status' })
  );
}