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
import { h, Fragment, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { fetchJson } from '../api.js';
import { createVirtualList } from '../virtual-list.js';

function taggedPathParts(relPath) {
const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const separator = normalized.lastIndexOf('/');
return {
name: separator >= 0 ? normalized.slice(separator + 1) : normalized,
folder: separator >= 0 ? normalized.slice(0, separator) : 'Project root'
};
}

export function SettingsTagsView(props) {
  const projectDir = props.projectDir || '';
  // The view may be reached with only a projectDir (Settings → Active
  // project → File tags). Resolve the registered project id from the
  // path in that case; a passed-in id always wins.
  const [resolvedId, setResolvedId] = useState(props.projectId || '');

  const [statusMsg, setStatusMsg] = useState({text: '', kind: ''});
  const [tagMap, setTagMap] = useState({});
  const [files, setFiles] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [virtualList, setVirtualList] = useState(null);

  // Read the live id so the resolver in useEffect can populate it
  // before the first loadTags()/scan() call.
  function id() { return resolvedId; }
  function base() { return '/api/projects/' + encodeURIComponent(id()) + '/tags'; }

  async function loadTags() {
    if (!id()) { setStatusMsg({text: 'no project id', kind: 'error'}); return; }
    let r;
    try { r = await fetchJson(base()); }
    catch { setStatusMsg({text: 'network error', kind: 'error'}); return; }
    if (r.status !== 200) { setStatusMsg({text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error'}); return; }
    setTagMap(r.body.tags || {});
  }

  async function scan() {
    if (!id()) { setStatusMsg({text: 'no project id', kind: 'error'}); return; }
    setIsScanning(true);
    setStatusMsg({text: 'scanning…', kind: 'busy'});
    let r;
    try {
      r = await fetchJson(base() + '/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch { setStatusMsg({text: 'network error', kind: 'error'}); setIsScanning(false); return; }
    setIsScanning(false);
    if (r.status !== 200) { setStatusMsg({text: 'HTTP ' + r.status + (r.body && r.body.error ? ' — ' + r.body.error : ''), kind: 'error'}); return; }
    setFiles(r.body.files || []);
    const tagged = Object.keys(tagMap).length;
    setStatusMsg({text: r.body.files.length + ' files · ' + tagged + ' tagged', kind: 'success'});
  }

  async function persist(newMap) {
    let r;
    try {
      r = await fetchJson(base(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: newMap })
      });
    } catch { setStatusMsg({text: 'network error', kind: 'error'}); return false; }
    if (r.status !== 200) { setStatusMsg({text: 'save failed: HTTP ' + r.status, kind: 'error'}); return false; }
    setTagMap(r.body.tags || {});
    return true;
  }

  // Build the union of scanned files and already-tagged paths so a
  // tagged file that is now missing (stale) still shows up with a
  // "missing" badge and a Remove action.
  function rows() {
    const byPath = new Map();
    for (const f of files) {
      byPath.set(f.path, { path: f.path, size: f.size, binary: !!f.binary, present: true });
    }
    for (const rel of Object.keys(tagMap)) {
      if (!byPath.has(rel)) byPath.set(rel, { path: rel, size: 0, binary: false, present: false });
    }
    return [...byPath.values()].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  }

  useEffect(() => {
    const listEl = document.getElementById('tags-list-container');
    if (!listEl) return;
    const all = rows();
    listEl.classList.toggle('is-empty', !all.length);
    if (!all.length) {
      if (virtualList) virtualList.setData([]);
      listEl.dataset.emptyText = 'No files scanned yet. Tap Scan to list the project\u2019s text files.';
      return;
    }
    delete listEl.dataset.emptyText;
    if (virtualList) virtualList.setData(all);
  }, [files, tagMap, virtualList]);

  function renderRow(f) {
    const entry = tagMap[f.path] || null;
    const isTagged = !!entry;
    const pathParts = taggedPathParts(f.path);
    
    return h('div', { class: 'tags__row' + (isTagged ? ' is-tagged' : '') + (f.binary ? ' is-binary' : '') },
      h('div', { class: 'tags__row-head' },
        h('div', { class: 'tags__row-path', title: f.path },
          h('span', { class: 'tags__row-name' }, pathParts.name),
          h('span', { class: 'tags__row-folder' }, pathParts.folder)
        ),
        !f.present 
          ? h('span', { class: 'tags__badge tags__badge--missing' }, 'missing')
          : f.binary 
            ? h('span', { class: 'tags__badge' }, 'binary')
            : null
      ),
      (f.binary && !entry) ? null : h(Fragment, null,
        h('div', { class: 'tags__chips' },
          ((entry && entry.tags) || []).map(t => h('span', { key: t, class: 'tags__chip' },
            t,
            h('button', {
              type: 'button',
              class: 'tags__chip-x',
              'aria-label': 'Remove tag ' + t,
              onClick: async () => {
                const newMap = { ...tagMap };
                const cur = newMap[f.path];
                if (!cur) return;
                cur.tags = cur.tags.filter(x => x !== t);
                if (!cur.tags.length && cur.excerpt == null && cur.includeInChat) {
                  delete newMap[f.path];
                }
                await persist(newMap);
              }
            }, '×')
          )),
          h('input', {
            class: 'tags__chip-input',
            type: 'text',
            placeholder: (entry && entry.tags && entry.tags.length) ? 'add tag…' : 'type a tag, Enter to add',
            onKeyDown: async (ev) => {
              if (ev.key === 'Enter' || ev.key === ',') {
                ev.preventDefault();
                const val = ev.target.value.trim().replace(/,+$/, '');
                if (!val) return;
                const newMap = { ...tagMap };
                const cur = newMap[f.path] || { tags: [], excerpt: null, includeInChat: true };
                if (!cur.tags.includes(val)) cur.tags.push(val);
                newMap[f.path] = cur;
                ev.target.value = '';
                await persist(newMap);
              }
            }
          })
        ),
        h('div', { class: 'tags__controls' },
          h('label', { class: 'tags__toggle' },
            h('input', {
              type: 'checkbox',
              class: 'checkbox',
              checked: entry ? entry.includeInChat !== false : true,
              onChange: async (e) => {
                const newMap = { ...tagMap };
                const cur = newMap[f.path] || { tags: [], excerpt: null, includeInChat: true };
                cur.includeInChat = e.target.checked;
                newMap[f.path] = cur;
                await persist(newMap);
              }
            }),
            ' Include in chat'
          ),
          h('div', { class: 'tags__excerpt' },
            'Lines ',
            h('input', {
              type: 'number',
              min: '1',
              class: 'tags__excerpt-num',
              placeholder: 'start',
              value: entry && entry.excerpt ? entry.excerpt.start : '',
              onChange: async (e) => {
                const newMap = { ...tagMap };
                const cur = newMap[f.path] || { tags: [], excerpt: null, includeInChat: true };
                const s = parseInt(e.target.value, 10);
                const exEnd = document.getElementById(`tags-ex-end-${encodeURIComponent(f.path)}`);
                const ev = exEnd ? exEnd.value : (entry && entry.excerpt ? entry.excerpt.end : '');
                const end = parseInt(ev, 10);
                if (Number.isInteger(s) && Number.isInteger(end) && s >= 1 && end >= s) {
                  cur.excerpt = { start: s, end };
                } else {
                  cur.excerpt = null;
                }
                newMap[f.path] = cur;
                await persist(newMap);
              }
            }),
            '–',
            h('input', {
              id: `tags-ex-end-${encodeURIComponent(f.path)}`,
              type: 'number',
              min: '1',
              class: 'tags__excerpt-num',
              placeholder: 'end',
              value: entry && entry.excerpt ? entry.excerpt.end : '',
              onChange: async (e) => {
                const newMap = { ...tagMap };
                const cur = newMap[f.path] || { tags: [], excerpt: null, includeInChat: true };
                const end = parseInt(e.target.value, 10);
                const s = entry && entry.excerpt ? entry.excerpt.start : '';
                if (Number.isInteger(s) && Number.isInteger(end) && s >= 1 && end >= s) {
                  cur.excerpt = { start: s, end };
                } else {
                  cur.excerpt = null;
                }
                newMap[f.path] = cur;
                await persist(newMap);
              }
            })
          ),
          h('button', {
            type: 'button',
            class: 'btn btn--small',
            'data-danger': '1',
            disabled: !entry,
            onClick: async () => {
              if (!tagMap[f.path]) return;
              let r;
              try {
                r = await fetchJson(base() + '/files/' + f.path.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' });
              } catch { setStatusMsg({text: 'network error', kind: 'error'}); return; }
              if (r.status !== 200 && r.status !== 404) { setStatusMsg({text: 'remove failed: HTTP ' + r.status, kind: 'error'}); return; }
              const newMap = { ...tagMap };
              delete newMap[f.path];
              setTagMap(newMap);
              setStatusMsg({text: 'removed ' + f.path, kind: 'success'});
            }
          }, 'Remove')
        )
      )
    );
  }

  useEffect(() => {
    const listEl = document.getElementById('tags-list-container');
    if (!listEl) return;
    const vl = createVirtualList({
      scroller: listEl,
      itemHeight: 248,
      overscan: 3,
      data: [],
      render: (file, node) => {
        // Preact requires explicit rendering into the dom node for virtualization, 
        // but now we'll pass our vnode to Preact's render
        node.className = 'tags__virtual-slot';
        render(renderRow(file), node);
      }
    });
    setVirtualList(vl);
    (async () => {
      let runId = resolvedId;
      // Resolve the registered project id from the path when the route
      // only carried projectDir. The tags REST surface hangs off the id.
      if (!runId && projectDir) {
        try {
          const r = await fetchJson('/api/projects/registered');
          if (r.status === 200 && Array.isArray(r.body.projects)) {
            const hit = r.body.projects.find((p) => p && p.path === projectDir);
            if (hit) {
              runId = hit.id;
              setResolvedId(hit.id);
            }
          }
        } catch { /* fall through to the no-id error */ }
        if (!runId) {
          setStatusMsg({text: 'this folder is not a registered project — register it first', kind: 'error'});
          return;
        }
      }
      if (runId) {
        // use local override for id() function scope issues inside effects where state may lag
        const originalId = id;
        const tempBase = () => '/api/projects/' + encodeURIComponent(runId) + '/tags';
        const loadTagsTemp = async () => {
          try {
            const r = await fetchJson(tempBase());
            if (r.status === 200) setTagMap(r.body.tags || {});
            else setStatusMsg({text: 'HTTP ' + r.status, kind: 'error'});
          } catch { setStatusMsg({text: 'network error', kind: 'error'}); }
        };
        const scanTemp = async () => {
          setIsScanning(true);
          setStatusMsg({text: 'scanning…', kind: 'busy'});
          try {
            const r = await fetchJson(tempBase() + '/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            setIsScanning(false);
            if (r.status === 200) {
              setFiles(r.body.files || []);
              setStatusMsg({text: r.body.files.length + ' files · ' + Object.keys(tagMap).length + ' tagged', kind: 'success'});
            } else setStatusMsg({text: 'HTTP ' + r.status, kind: 'error'});
          } catch { setStatusMsg({text: 'network error', kind: 'error'}); setIsScanning(false); }
        };
        await loadTagsTemp();
        await scanTemp();
      }
    })().catch(() => setStatusMsg({text: 'load failed', kind: 'error'}));
    return () => {
      if (vl) vl.destroy();
    };
  }, [projectDir]);

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/projects', class: 'view-back', 'aria-label': 'Back to projects' }, '‹'),
      h('h2', { class: 'view-title' }, 'File tags')
    ),
    h('p', { class: 'hint hint--compact' }, projectDir || '(project)'),
    h('p', { class: 'hint hint--compact' }, 'Tag project files, then toggle “Include in chat” to auto-inject them into every chat send. Reference one explicitly with @path in the composer.'),
    h('div', { id: 'tags-list-container', class: 'tags__list', role: 'list', 'aria-label': 'Project files' }),
    h('div', { class: 'page-bar' },
      h('span', { class: 'status page-bar__status' + (statusMsg.kind ? ' status--' + statusMsg.kind : ''), 'aria-live': 'polite' }, statusMsg.text),
      h('button', { class: 'btn', type: 'button', onClick: scan, disabled: isScanning }, 'Scan')
    )
  );
}
