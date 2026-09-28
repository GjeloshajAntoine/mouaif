import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Regression test: one Off/Ask/Allow tap = exactly ONE authorization write.
//
// The bug: the chat tools card, the composer tool popup, and their MCP
// twins fired two un-awaited PUTs per tap — an `onClear` that removed the
// chat's override, then the real pick. Both responses overwrite the whole
// auth view when they land, so on a slow connection the clear response
// arrived last and snapped the segment back to the project mode: the
// control "blinked and didn't work", and an impatient re-tap fought the
// in-flight writes. The endpoint replaces the entry outright, so the clear
// write was always redundant.
//
// What must hold now:
//   1. a Tap on ToolAuthSeg calls onPick exactly once — no onClear hook;
//   2. the same for McpAuthSeg (per-server and shared flavours);
//   3. Allow still drops the allowlist, other modes keep it;
//   4. the chat call sites no longer pass onClear, so the hook's
//      _saveToolAuth/_saveMcpAuth are the single writers per tap;
//   5. the hook carries a monotonic ticket so an out-of-order response
//      cannot apply a stale echo.

const transformSource = async (relPath) => {
  const source = await readFile(new URL('../' + relPath, import.meta.url), 'utf8');
  const replaced = source
    .replace("import { h } from 'preact';", 'const h = (type, props, ...children) => ({ type, props, children });')
    .replace("import { fetchJson } from '../../api.js';", 'const fetchJson = async () => ({ status: 200, body: {} });');
  const transformed = await transform(replaced, { loader: 'jsx', format: 'esm' });
  return transformed.code;
};

const { ToolAuthSeg, McpAuthSeg } = await import('data:text/javascript;base64,' + Buffer.from(await transformSource('frontend/src/components/settings/toolAuth.js')).toString('base64'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

// Collect every vnode in a tree, including nested children.
const nodes = (node) => (typeof node !== 'object' || !node ? [] : [node, ...(node.children || []).flat(Infinity).flatMap(nodes)]);
const radios = (tree) => nodes(tree).filter((n) => n.type === 'input' && n.props && n.props.type === 'radio');
const radioFor = (tree, label) => radios(tree).find((n) => n.props.value === label);

// ---- 1. ToolAuthSeg: one pick, no separate clear -----------------------
{
  const calls = [];
  const tree = ToolAuthSeg({
    tool: 'shell', mode: 'ask', allowlist: ['^ls$'], namePrefix: 't',
    onPick: (mode, allowlist) => calls.push({ mode, allowlist })
  });

  check('ToolAuthSeg renders one radio per mode', radios(tree).length === 3, String(radios(tree).length));
  {
    const src = await readFile(new URL('../frontend/src/components/settings/toolAuth.js', import.meta.url), 'utf8');
    // No `onClear` prop destructured or invoked — only comments may mention it.
    check('ToolAuthSeg no longer destructures or calls an onClear hook',
      !/onClear\s*[,})]/.test(src) && !/if \(onClear\)/.test(src));
  }

  // A tap on Allow fires exactly one pick and clears the allowlist.
  calls.length = 0;
  radioFor(tree, 'allow').props.onChange();
  check('Allow fires exactly one write', calls.length === 1, JSON.stringify(calls));
  check('Allow drops the allowlist', calls[0] && calls[0].mode === 'allow' && calls[0].allowlist.length === 0, JSON.stringify(calls[0]));

  // A tap on Off fires exactly one pick and KEEPS the allowlist.
  calls.length = 0;
  radioFor(tree, 'off').props.onChange();
  check('Off fires exactly one write', calls.length === 1, JSON.stringify(calls));
  check('Off keeps the allowlist', calls[0] && calls[0].mode === 'off' && calls[0].allowlist[0] === '^ls$', JSON.stringify(calls[0]));

  // A tap on Ask fires exactly one pick and keeps the allowlist.
  calls.length = 0;
  radioFor(tree, 'ask').props.onChange();
  check('Ask fires exactly one write', calls.length === 1, JSON.stringify(calls));
  check('Ask keeps the allowlist', calls[0] && calls[0].mode === 'ask' && calls[0].allowlist[0] === '^ls$', JSON.stringify(calls[0]));
}

// ---- 2. McpAuthSeg: per-server and shared -----------------------------
{
  const saved = [];
  const perServer = McpAuthSeg({
    name: 'git', slug: 'git', servers: {}, shared: { mode: 'ask' },
    namePrefix: 'm', onSave: (patch) => saved.push(patch)
  });
  check('McpAuthSeg renders one radio per mode', radios(perServer).length === 3);
  saved.length = 0;
  radioFor(perServer, 'allow').props.onChange();
  check('MCP per-server Allow fires exactly one write',
    saved.length === 1 && saved[0].servers && saved[0].servers.git && saved[0].servers.git.mode === 'allow',
    JSON.stringify(saved));
  check('MCP per-server write carries no null (clear) entry',
    !saved.some((p) => p.servers && p.servers.git === null), JSON.stringify(saved));

  const sharedSaved = [];
  const shared = McpAuthSeg({
    name: 'Any MCP', slug: null, servers: {}, shared: { mode: 'ask' },
    namePrefix: 'm2', onSave: (patch) => sharedSaved.push(patch)
  });
  radioFor(shared, 'off').props.onChange();
  check('MCP shared-flavour pick writes { mode } once',
    sharedSaved.length === 1 && sharedSaved[0].mode === 'off', JSON.stringify(sharedSaved));

  // Ask over an existing allowlist persists the allowlist mode.
  const withList = [];
  const listed = McpAuthSeg({
    name: 'git', slug: 'git', servers: { git: { mode: 'allowlist', allowlist: ['^x$'] } }, shared: { mode: 'ask' },
    namePrefix: 'm3', onSave: (patch) => withList.push(patch)
  });
  radioFor(listed, 'ask').props.onChange();
  check('Ask over an allowlist persists allowlist mode',
    withList.length === 1 && withList[0].servers.git.mode === 'allowlist', JSON.stringify(withList));
}

// ---- 3. Chat call sites are single-writer -----------------------------
{
  const cards = await readFile(new URL('../frontend/src/components/chat/cards.js', import.meta.url), 'utf8');
  const popup = await readFile(new URL('../frontend/src/components/chat/ToolPopup.jsx', import.meta.url), 'utf8');
  check('cards.js passes no onClear to the segments', !/onClear\s*:/.test(cards));
  check('ToolPopup.jsx passes no onClear to the segments', !/onClear\s*:/.test(popup));
  check('cards.js wires the native pick through _saveToolAuth once',
    (cards.match(/_saveToolAuth\(toolName, mode, allowlist\)/g) || []).length === 1);
  check('ToolPopup wires the native pick through onSave once',
    /onPick: \(mode, allowlist\) => \{ if \(onSave\) onSave\(toolName, mode, allowlist\); \}/.test(popup));
}

// ---- 4. The hook guards against out-of-order responses ----------------
{
  const hook = await readFile(new URL('../frontend/src/components/chat/useChatState.js', import.meta.url), 'utf8');
  check('useChatState defines an auth-save ticket', /_authSaveSeq/.test(hook));
  check('both save paths check their ticket before applying',
    (hook.match(/seq !== state\._authSaveSeq/g) || []).length === 2,
    String((hook.match(/seq !== state\._authSaveSeq/g) || []).length));
}

// ---- 5. Read tools / Edit tools share ONE family, not one radio group ---
//
// The two file-tool rows are two controls over a single `tools.file`
// authorization family. They must not share a radio-group name: with the
// same `name`, the browser treats them as one group, so picking a mode on
// Read tools would visibly clear Edit tools. This pins both halves of the
// contract — distinct radio names, one shared write target.
{
  const rowName = (tree) => (radios(tree)[0] || { props: {} }).props.name;
  const read = ToolAuthSeg({ tool: 'files-read', name: 'file', mode: 'ask', namePrefix: 'sp', onPick: () => {} });
  const edit = ToolAuthSeg({ tool: 'files-edit', name: 'file', mode: 'ask', namePrefix: 'sp', onPick: () => {} });
  check('the two file rows use DIFFERENT radio-group names', rowName(read) !== rowName(edit), rowName(read) + ' vs ' + rowName(edit));
  check('each radio name keys off the row id', /files-read/.test(rowName(read)) && /files-edit/.test(rowName(edit)), rowName(read));

  const settingsTree = await readFile(new URL('../frontend/src/components/SettingsProject.jsx', import.meta.url), 'utf8');
  check('the settings tree writes the file family through pickFileMode on both rows',
    (settingsTree.match(/toolModeSegs\(meta\.name, segMode\(fileAuth\.mode\), pickFileMode, \[/g) || []).length === 1 && /for \(const \[kind, list\] of \[\['read', readFiles\], \['edit', editFiles\]\]\)/.test(settingsTree));
  check('the settings group checkbox writes per-leaf overrides, not the family',
    /pickFileLeavesMode\(names, mode\)/.test(settingsTree) && !/'file', \.\.\.toolNames/.test(settingsTree));

  const cards = await readFile(new URL('../frontend/src/components/chat/cards.js', import.meta.url), 'utf8');
  const popup = await readFile(new URL('../frontend/src/components/chat/ToolPopup.jsx', import.meta.url), 'utf8');
  check('the chat card maps both file rows to the `file` family',
    /\[READ_GROUP_ID\]: 'file'/.test(cards) && /\[EDIT_GROUP_ID\]: 'file'/.test(cards));
  check('the popup maps both file rows to the `file` family',
    /\[READ_GROUP_ID\]: 'file'/.test(popup) && /\[EDIT_GROUP_ID\]: 'file'/.test(popup));
  check('the chat card keys the radio name on the row id, not the family',
    /tool:\s*g\.id,/.test(cards));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
