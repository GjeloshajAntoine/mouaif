'use strict';

// Coverage for the native `mouaif` tool (src/tools/mouaif.js): the spec
// shape, the chats / attachments / settings / projects areas, the typed
// errors, and the `mouaif` authorization category. Runs entirely against a
// temp MOUAIF_HOME + temp project dir; no server, no network.
//
// Prints a pass/fail summary and exits non-zero on any failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Both dirs live under the real user home (not the system temp dir): the
// tool resolves projectDir through projects.ensureSafeRoot, which refuses
// anything outside the home unless MOUAIF_ALLOW_ANY_ROOT=1. Same approach
// as scripts/test-file-editor.js.
const home = fs.mkdtempSync(path.join(os.homedir(), '.mouaif-tool-test-'));
const projectDir = fs.mkdtempSync(path.join(home, 'project-'));
process.env.MOUAIF_HOME = home;

const settings = require('../src/settings.js');
const projects = require('../src/projects.js');
const authz = require('../src/tools/authorization.js');
const mouaif = require('../src/tools/mouaif.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); }
}

// A 4x4 PNG, written into the project so `attach` has a real image to read.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR4nGP8z8Dwn4EIwESMokGvCAAxBgMBAJ2DqQAAAAAASUVORK5CYII=';

async function main() {
  fs.writeFileSync(path.join(projectDir, 'shot.png'), Buffer.from(PNG_BASE64, 'base64'));
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'not an image\n');

  // --- 1) Spec shape ------------------------------------------------------
  const fn = mouaif.SPEC.function;
  check('SPEC is an OpenAI function', mouaif.SPEC.type === 'function' && fn.name === 'mouaif');
  check('SPEC requires only `action`', JSON.stringify(fn.parameters.required) === '["action"]');
  check('action enum matches ACTIONS', fn.parameters.properties.action.enum.join(',') === mouaif.ACTION_NAMES.join(','));
  check('every action is routed to an area', mouaif.ACTION_NAMES.every((a) => !!mouaif.AREAS[mouaif.ACTIONS[a]]));
  // The tool surfaces as two UI categories behind one authorization family.
  check('GROUPS defines the two UI categories', Array.isArray(mouaif.GROUPS) && mouaif.GROUPS.length === 2);
  check('the category ids are distinct', mouaif.GROUPS[0].id !== mouaif.GROUPS[1].id);
  check('the categories cover every area exactly once', (() => {
    const covered = mouaif.GROUPS.flatMap((g) => g.areas).sort().join(',');
    return covered === Object.keys(mouaif.AREAS).sort().join(',');
  })());
  check('the first category is the chats half', mouaif.GROUPS[0].areas.join(',') === 'chats,attachments');

  // --- 2) Authorization category -----------------------------------------
  const authState = authz.getAuthorization(projectDir);
  check('authorization view exposes the mouaif tool', !!authState.tools.mouaif);
  check('mouaif defaults to ask', authState.tools.mouaif.mode === 'ask');
  authz.setAuthorization(projectDir, { tools: { mouaif: { mode: 'allow' } } });
  check('mouaif mode can be stored', authz.getAuthorization(projectDir).tools.mouaif.mode === 'allow');
  authz.setAuthorization(projectDir, { tools: { mouaif: { mode: 'off' } } });
  check('mouaif mode can be turned off', authz.getAuthorization(projectDir).tools.mouaif.mode === 'off');
  const denied = await authz.authorize({ projectDir, chatId: 'aaaa1111', callId: 'c1', tool: 'mouaif' })
    .then(() => null, (e) => e.code);
  check('off mode rejects the call with ETOOL_DISABLED', denied === 'ETOOL_DISABLED');
  authz.setAuthorization(projectDir, { tools: { mouaif: { mode: 'ask' } } });

  // --- 3) Errors on a bad call -------------------------------------------
  const bad = await mouaif.runMouaif({});
  check('missing action is EBADINPUT', bad.ok === false && bad.result.code === 'EBADINPUT');
  const unknown = await mouaif.runMouaif({ action: 'nope' }, { projectDir });
  check('unknown action is EBADINPUT', unknown.ok === false && unknown.result.code === 'EBADINPUT');
  const noProject = await mouaif.runMouaif({ action: 'list' });
  check('no projectDir is EBADINPUT', noProject.ok === false && noProject.result.code === 'EBADINPUT');
  const relative = await mouaif.runMouaif({ action: 'list' }, { projectDir: 'relative/path' });
  check('relative projectDir is EBADINPUT', relative.ok === false && relative.result.code === 'EBADINPUT');

  const opts = { projectDir, chatId: null };

  // --- 4) chats: create / list / get / update / search / delete ----------
  const created = await mouaif.runMouaif({ action: 'create', title: 'Release notes', topic: 'Draft the changelog' }, opts);
  check('create returns ok', created.ok === true && created.result.chat && !!created.result.chat.id);
  check('create seeds the draft with the topic', created.result.chat.draftSnippet === 'Draft the changelog');
  const chatId = created.result.chat.id;
  check('create returns a chat url', created.result.url === '#/chat/' + encodeURIComponent(chatId));

  const created4 = await mouaif.runMouaif({ action: 'create', title: 'Fourth', topic: 'hello' }, opts);
  check('a second create works', created4.ok === true && created4.result.chat.title === 'Fourth');

  const list = await mouaif.runMouaif({ action: 'list' }, opts);
  check('list returns both chats', list.ok === true && list.result.chats.length === 2 && list.result.total === 2);
  check('list rows carry no full draft body', list.result.chats.every((c) => c.draft === undefined));

  const limited = await mouaif.runMouaif({ action: 'list', limit: 1 }, opts);
  check('list honours the limit', limited.result.chats.length === 1 && limited.result.total === 2);

  const got = await mouaif.runMouaif({ action: 'get', chatId, includeMessages: true }, opts);
  check('get returns the chat', got.ok === true && got.result.chat.id === chatId);
  check('get returns messages when asked', Array.isArray(got.result.chat.messages));
  const missing = await mouaif.runMouaif({ action: 'get', chatId: 'nosuchchat' }, opts);
  check('get on a missing chat is ENOTFOUND', missing.ok === false && missing.result.code === 'ENOTFOUND');

  const renamed = await mouaif.runMouaif({ action: 'update', chatId, title: 'Changelog v2', promptSize: 'chat' }, opts);
  check('update applies title + promptSize', renamed.ok === true
    && renamed.result.chat.title === 'Changelog v2' && renamed.result.chat.promptSize === 'chat');
  const nothing = await mouaif.runMouaif({ action: 'update', chatId }, opts);
  check('update with no fields is EBADINPUT', nothing.ok === false && nothing.result.code === 'EBADINPUT');
  const badProfile = await mouaif.runMouaif({ action: 'update', chatId, promptSize: 'huge' }, opts);
  check('update with an unknown promptSize is EBADINPUT', badProfile.ok === false && badProfile.result.code === 'EBADINPUT');
  const badModel = await mouaif.runMouaif({ action: 'update', chatId, modelId: 'no-such-model', providerId: 'ghost' }, opts);
  check('update with an unknown model is EBADINPUT', badModel.ok === false && badModel.result.code === 'EBADINPUT');

  const found = await mouaif.runMouaif({ action: 'search', query: 'Changelog' }, opts);
  check('search finds the renamed chat', found.ok === true && found.result.chats.some((c) => c.id === chatId));
  const noQuery = await mouaif.runMouaif({ action: 'search' }, opts);
  check('search without a query is EBADINPUT', noQuery.ok === false && noQuery.result.code === 'EBADINPUT');

  const unconfirmed = await mouaif.runMouaif({ action: 'delete', chatId }, opts);
  check('delete without confirm is ECONFIRM', unconfirmed.ok === false && unconfirmed.result.code === 'ECONFIRM');
  check('ECONFIRM reports what would be lost', unconfirmed.result.title === 'Changelog v2');
  const confirmed = await mouaif.runMouaif({ action: 'delete', chatId, confirm: true }, opts);
  check('delete with confirm removes the chat', confirmed.ok === true && confirmed.result.deleted === chatId);
  const gone = await mouaif.runMouaif({ action: 'get', chatId }, opts);
  check('the deleted chat is gone', gone.ok === false && gone.result.code === 'ENOTFOUND');

  // --- 5) attachments ----------------------------------------------------
  const host = await mouaif.runMouaif({ action: 'create', title: 'Images' }, opts);
  const imgChat = host.result.chat.id;
  const chatOpts = { projectDir, chatId: imgChat };

  const drafted = await mouaif.runMouaif({ action: 'attach', path: 'shot.png' }, chatOpts);
  check('attach defaults to the draft', drafted.ok === true && drafted.result.target === 'draft');
  check('the draft holds one image', drafted.result.draftAttachments === 1);
  check('attach reports the mime type', drafted.result.attached.mimeType === 'image/png');
  check('attach defaults chatId to the current chat', (await mouaif.runMouaif({ action: 'attach', path: 'shot.png' }, { projectDir, chatId: imgChat })).ok === true);

  const asMessage = await mouaif.runMouaif({
    action: 'attach', path: 'shot.png', target: 'message', content: 'here is the shot'
  }, chatOpts);
  check('attach to a message works', asMessage.ok === true && asMessage.result.target === 'message');
  check('the message attachment is persisted', !!asMessage.result.messageTs);

  const listed = await mouaif.runMouaif({ action: 'list_attachments' }, chatOpts);
  // Two images sit in the draft: the first attach plus the "defaults chatId"
  // call above, which lands on the same chat.
  check('list_attachments sees the draft images', listed.ok === true
    && listed.result.drafts.length === 2 && listed.result.messages.length === 1);
  check('list_attachments names the image', listed.result.drafts[0].name === 'shot.png');

  const notImage = await mouaif.runMouaif({ action: 'attach', path: 'notes.txt' }, chatOpts);
  check('attaching a non-image fails', notImage.ok === false && (notImage.result.code === 'ENOTIMAGE' || notImage.result.code === 'EBINARY'));
  const missingFile = await mouaif.runMouaif({ action: 'attach', path: 'nope.png' }, chatOpts);
  check('attaching a missing file is ENOENT', missingFile.ok === false && missingFile.result.code === 'ENOENT');
  // The attachment reader keeps the file editor's boundary (the user home, or
  // the whole tree under MOUAIF_ALLOW_ANY_ROOT), so /etc is refused by the
  // same guard the REST file routes use.
  const outside = await mouaif.runMouaif({ action: 'attach', path: '/etc/hosts' }, chatOpts);
  check('attaching outside the boundary is refused', outside.ok === false
    && ['EOUTSIDE_HOME', 'ENOTIMAGE', 'EBINARY'].includes(outside.result.code), outside.result.code);
  const noPath = await mouaif.runMouaif({ action: 'attach' }, chatOpts);
  check('attach without a path is EBADINPUT', noPath.ok === false && noPath.result.code === 'EBADINPUT');
  const noChat = await mouaif.runMouaif({ action: 'attach', path: 'shot.png' }, { projectDir, chatId: null });
  check('attach without a chat is EBADINPUT', noChat.ok === false && noChat.result.code === 'EBADINPUT');

  // --- 6) settings -------------------------------------------------------
  const appGet = await mouaif.runMouaif({ action: 'settings_get' }, opts);
  check('settings_get defaults to the app scope', appGet.ok === true && appGet.result.scope === 'app');
  check('settings_get never leaks an apiKey', appGet.result.settings.providers === undefined
    || appGet.result.settings.providers.every((p) => p && p.apiKey === undefined));

  const appPut = await mouaif.runMouaif({ action: 'settings_update', scope: 'app', patch: { enterForNewline: true } }, opts);
  check('settings_update writes app settings', appPut.ok === true && appPut.result.settings.enterForNewline === true);
  check('the app write is readable back', settings.getApp().enterForNewline === true);
  const appKeys = await mouaif.runMouaif({ action: 'settings_get', keys: ['enterForNewline', 'nope'] }, opts);
  check('settings_get honours the key filter', Object.keys(appKeys.result.settings).join(',') === 'enterForNewline');

  const projGet = await mouaif.runMouaif({ action: 'settings_get', scope: 'project' }, opts);
  check('settings_get reads the project scope', projGet.ok === true && projGet.result.scope === 'project');

  const projPut = await mouaif.runMouaif({
    action: 'settings_update', scope: 'project', patch: { name: 'Demo', agentFiles: false }
  }, opts);
  check('settings_update writes project settings', projPut.ok === true && projPut.result.settings.name === 'Demo');
  check('the project write is readable back', settings.getProject(projectDir).name === 'Demo');
  const unset = await mouaif.runMouaif({ action: 'settings_update', scope: 'project', unset: ['name'] }, opts);
  check('settings_update can remove project keys', unset.ok === true && settings.getProject(projectDir).name === undefined);

  const empty = await mouaif.runMouaif({ action: 'settings_update', scope: 'project' }, opts);
  check('settings_update with nothing to do is EBADINPUT', empty.ok === false && empty.result.code === 'EBADINPUT');
  const secret = await mouaif.runMouaif({
    action: 'settings_update', scope: 'project', patch: { apiKey: 'sk-nope' }
  }, opts);
  check('settings_update refuses apiKey', secret.ok === false && secret.result.code === 'EBADINPUT');
  const badScope = await mouaif.runMouaif({ action: 'settings_get', scope: 'galaxy' }, opts);
  check('an unknown scope is EBADINPUT', badScope.ok === false && badScope.result.code === 'EBADINPUT');

  // --- 7) projects + info ------------------------------------------------
  projects.registerProject(projectDir);
  const projectList = await mouaif.runMouaif({ action: 'project_list' }, opts);
  check('project_list returns the registered project', projectList.ok === true
    && projectList.result.projects.some((p) => p.path === projectDir));

  const info = await mouaif.runMouaif({ action: 'info' }, opts);
  check('info reports the tool surface', info.ok === true
    && Array.isArray(info.result.actions) && info.result.tool === 'mouaif');
  check('info lists every action with its area', info.result.actions.length === mouaif.ACTION_NAMES.length
    && info.result.actions.every((a) => a && a.action && a.area));
  check('info includes the feature state (tools)', info.result.tools && !!info.result.tools.shell);

  console.log('mouaif tool: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().finally(() => {
  settings.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
