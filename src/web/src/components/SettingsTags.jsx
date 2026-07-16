// mouaif web — SettingsTagsView (per-project file tagging)
// The user attaches tags to files inside a project. Tagged files with
// "Include in chat" on are auto-injected into every chat send as a
// synthetic system message. See docs/features/file-tagging.md and
// docs/decisions.md §15.
//
// The REST surface hangs off the registered project id:
//   GET    /api/projects/:id/tags
//   PUT    /api/projects/:id/tags
//   POST   /api/projects/:id/tags/scan
//   DELETE /api/projects/:id/tags/files/<relPath>
import { h, Fragment } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { fetchJson, setStatus } from '../api.js';

export function SettingsTagsView(props) {
  const projectId = props.projectId || '';
  const projectDir = props.projectDir || '';

  const listEl = useRef(null);
  const statusEl = useRef(null);
  const scanBtn = useRef(null);

  // Local working state. `tagMap` is the persisted { relPath: entry }
  // map; `files` is the last scan result. Kept in refs (not signals)
  // because the rows are rendered imperatively, matching SettingsMcp.
  const tagMap = useRef({});
  const files = useRef([]);

  const base = '/api/projects/' + encodeURIComponent(projectId) + '/tags';

  async function loadTags() {
    if (!projectId) { setStatus(statusEl, 'no project id', 'error'); return; }
    let r;
    try { r = await fetchJson(base); }
    catch { setStatus(statusEl, 'network error', 'error'); return; }
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), 'error'); return; }
    tagMap.current = r.body.tags || {};
  }

  async function scan() {
    if (!projectId) { setStatus(statusEl, 'no project id', 'error'); return; }
    if (scanBtn.current) scanBtn.current.disabled = true;
    setStatus(statusEl, 'scanning…', 'busy');
    let r;
    try {
      r = await fetchJson(base + '/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch { setStatus(statusEl, 'network error', 'error'); if (scanBtn.current) scanBtn.current.disabled = false; return; }
    if (scanBtn.current) scanBtn.current.disabled = false;
    if (r.status !== 200) { setStatus(statusEl, 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), 'error'); return; }
    files.current = r.body.files || [];
    render();
    const tagged = Object.keys(tagMap.current).length;
    setStatus(statusEl, files.current.length + ' files · ' + tagged + ' tagged', 'success');
  }

  async function persist() {
    let r;
    try {
      r = await fetchJson(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: tagMap.current })
      });
    } catch { setStatus(statusEl, 'network error', 'error'); return false; }
    if (r.status !== 200) { setStatus(statusEl, 'save failed: HTTP ' + r.status, 'error'); return false; }
    tagMap.current = r.body.tags || {};
    return true;
  }

  // Build the union of scanned files and already-tagged paths so a
  // tagged file that is now missing (stale) still shows up with a
  // "missing" badge and a Remove action.
  function rows() {
    const byPath = new Map();
    for (const f of files.current) {
      byPath.set(f.path, { path: f.path, size: f.size, binary: !!f.binary, present: true });
    }
    for (const rel of Object.keys(tagMap.current)) {
      if (!byPath.has(rel)) byPath.set(rel, { path: rel, size: 0, binary: false, present: false });
    }
    return [...byPath.values()].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  }

  function render() {
    if (!listEl.current) return;
    listEl.current.innerHTML = '';
    const all = rows();
    if (!all.length) {
      const li = document.createElement('li');
      li.className = 'tags__empty';
      li.textContent = 'No files scanned yet. Tap Scan to list the project\u2019s text files.';
      listEl.current.appendChild(li);
      return;
    }
    for (const f of all) listEl.current.appendChild(renderRow(f));
  }

  function renderRow(f) {
    const entry = tagMap.current[f.path] || null;
    const li = document.createElement('li');
    li.className = 'tags__row' + (entry ? ' is-tagged' : '') + (f.binary ? ' is-binary' : '');

    const head = document.createElement('div');
    head.className = 'tags__row-head';

    const pathEl = document.createElement('div');
    pathEl.className = 'tags__row-path';
    pathEl.textContent = f.path;
    head.appendChild(pathEl);

    if (!f.present) {
      const badge = document.createElement('span');
      badge.className = 'tags__badge tags__badge--missing';
      badge.textContent = 'missing';
      head.appendChild(badge);
    } else if (f.binary) {
      const badge = document.createElement('span');
      badge.className = 'tags__badge';
      badge.textContent = 'binary';
      head.appendChild(badge);
    }
    li.appendChild(head);

    // Binary files cannot be tagged (decisions §15).
    if (f.binary && !entry) return li;

    // Tag chips input: comma / Enter to add, tap × to remove.
    const chipStrip = document.createElement('div');
    chipStrip.className = 'tags__chips';
    function repaintChips() {
      chipStrip.innerHTML = '';
      const e = tagMap.current[f.path];
      const list = (e && Array.isArray(e.tags)) ? e.tags : [];
      for (const t of list) {
        const chip = document.createElement('span');
        chip.className = 'tags__chip';
        chip.textContent = t;
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'tags__chip-x'; x.textContent = '×';
        x.setAttribute('aria-label', 'Remove tag ' + t);
        x.addEventListener('click', async () => {
          const cur = tagMap.current[f.path];
          if (!cur) return;
          cur.tags = cur.tags.filter(x2 => x2 !== t);
          if (!cur.tags.length && cur.excerpt == null && cur.includeInChat) {
            // no tags left and default state — drop the entry entirely
            delete tagMap.current[f.path];
          }
          if (await persist()) { repaintChips(); syncControls(); }
        });
        chip.appendChild(x);
        chipStrip.appendChild(chip);
      }
      const input = document.createElement('input');
      input.className = 'tags__chip-input';
      input.type = 'text';
      input.placeholder = list.length ? 'add tag…' : 'type a tag, Enter to add';
      input.addEventListener('keydown', async (ev) => {
        if (ev.key === 'Enter' || ev.key === ',') {
          ev.preventDefault();
          const val = input.value.trim().replace(/,+$/, '');
          if (!val) return;
          const cur = tagMap.current[f.path] || { tags: [], excerpt: null, includeInChat: true };
          if (!cur.tags.includes(val)) cur.tags.push(val);
          tagMap.current[f.path] = cur;
          input.value = '';
          if (await persist()) { repaintChips(); syncControls(); }
        }
      });
      chipStrip.appendChild(input);
    }
    li.appendChild(chipStrip);

    // Controls row: Include-in-chat toggle + excerpt start/end + Remove.
    const controls = document.createElement('div');
    controls.className = 'tags__controls';

    const incLabel = document.createElement('label');
    incLabel.className = 'tags__toggle';
    const inc = document.createElement('input');
    inc.type = 'checkbox'; inc.className = 'checkbox';
    inc.addEventListener('change', async () => {
      const cur = tagMap.current[f.path] || { tags: [], excerpt: null, includeInChat: true };
      cur.includeInChat = inc.checked;
      tagMap.current[f.path] = cur;
      await persist();
    });
    incLabel.appendChild(inc);
    incLabel.appendChild(document.createTextNode(' Include in chat'));
    controls.appendChild(incLabel);

    const exWrap = document.createElement('div');
    exWrap.className = 'tags__excerpt';
    const exStart = document.createElement('input');
    exStart.type = 'number'; exStart.min = '1'; exStart.className = 'tags__excerpt-num';
    exStart.placeholder = 'start';
    const exEnd = document.createElement('input');
    exEnd.type = 'number'; exEnd.min = '1'; exEnd.className = 'tags__excerpt-num';
    exEnd.placeholder = 'end';
    async function commitExcerpt() {
      const cur = tagMap.current[f.path] || { tags: [], excerpt: null, includeInChat: true };
      const s = parseInt(exStart.value, 10);
      const e = parseInt(exEnd.value, 10);
      if (Number.isInteger(s) && Number.isInteger(e) && s >= 1 && e >= s) {
        cur.excerpt = { start: s, end: e };
      } else {
        cur.excerpt = null;
      }
      tagMap.current[f.path] = cur;
      await persist();
    }
    exStart.addEventListener('change', commitExcerpt);
    exEnd.addEventListener('change', commitExcerpt);
    exWrap.appendChild(document.createTextNode('Lines '));
    exWrap.appendChild(exStart);
    exWrap.appendChild(document.createTextNode('–'));
    exWrap.appendChild(exEnd);
    controls.appendChild(exWrap);

    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'btn btn--small'; rm.setAttribute('data-danger', '1');
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      if (!tagMap.current[f.path]) return;
      let r;
      try {
        r = await fetchJson(base + '/files/' + f.path.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' });
      } catch { setStatus(statusEl, 'network error', 'error'); return; }
      if (r.status !== 200 && r.status !== 404) { setStatus(statusEl, 'remove failed: HTTP ' + r.status, 'error'); return; }
      delete tagMap.current[f.path];
      render();
      setStatus(statusEl, 'removed ' + f.path, 'success');
    });
    controls.appendChild(rm);

    li.appendChild(controls);

    function syncControls() {
      const e = tagMap.current[f.path];
      inc.checked = e ? e.includeInChat !== false : true;
      exStart.value = e && e.excerpt ? e.excerpt.start : '';
      exEnd.value = e && e.excerpt ? e.excerpt.end : '';
      rm.disabled = !e;
      li.classList.toggle('is-tagged', !!e);
    }

    repaintChips();
    syncControls();
    return li;
  }

  useEffect(() => {
    loadTags().then(scan).catch(() => setStatus(statusEl, 'load failed', 'error'));
  }, []);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '‹'),
      h('h2', { class: 'view-title' }, 'File tags')
    ),
    h('p', { class: 'hint hint--compact' }, projectDir || '(project)'),
    h('p', { class: 'hint hint--compact' }, 'Tag project files, then toggle “Include in chat” to auto-inject them into every chat send. Reference one explicitly with @path in the composer.'),
    h('ul', { ref: listEl, class: 'tags__list', 'aria-label': 'Project files' }),
    h('div', { class: 'page-bar' },
      h('span', { ref: statusEl, class: 'status page-bar__status', 'aria-live': 'polite' }),
      h('button', { ref: scanBtn, class: 'btn', type: 'button', onClick: scan }, 'Scan')
    )
  );
}
