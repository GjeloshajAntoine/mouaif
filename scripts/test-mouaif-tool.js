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
  // Each category lists its own actions — that is what the tools tree renders
  // as child rows, so a category reads as a category and not as one more tool.
  // The lists are derived from ACTIONS, so this asserts the derivation, not a
  // hand-kept copy: every action appears under its area's category exactly once.
  check('every action lands in exactly one category', (() => {
    const listed = mouaif.GROUPS.flatMap((g) => g.actions).sort();
    return listed.join(',') === mouaif.ACTION_NAMES.slice().sort().join(',');
  })());
  check('a category lists only its own areas\u2019 actions', mouaif.GROUPS[0].actions.every((a) => ['chats', 'attachments'].includes(mouaif.ACTIONS[a]))
    && mouaif.GROUPS[1].actions.every((a) => ['settings', 'projects', 'info'].includes(mouaif.ACTIONS[a])));
  check('the chats category lists the eight chat + attachment actions', mouaif.GROUPS[0].actions.join(',') === 'list,get,create,update,delete,search,attach,list_attachments');
  check('the settings category lists the four settings + project actions', mouaif.GROUPS[1].actions.join(',') === 'settings_get,settings_update,project_list,info');

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
  const chats = require('../src/chats.js');
  const messages = require('../src/messages.js');
  const prompts = require('../src/prompts.js');
  for (const args of [null, [], { action: 'toString' }, { action: 'constructor' },
    { action: 'create', title: 123 }, { action: 'list', limit: '2' },
    { action: 'get', includeMessages: 'true' }, { action: 'settings_get', keys: [123] },
    { action: 'settings_update', patch: [] }, { action: 'settings_update', unset: [null] },
    { action: 'settings_get', unexpected: true }, { action: 'attach', target: 'unknown' }]) {
    const result = await mouaif.runMouaif(args, opts);
    check('malformed arguments return EBADINPUT: ' + JSON.stringify(args), result.ok === false && result.result.code === 'EBADINPUT');
  }
  check('invalid calls have no side effects', chats.countChats(projectDir) === 0);

  // --- 4) chats: create / list / get / update / search / delete ----------
  const created = await mouaif.runMouaif({ action: 'create', title: 'Release notes', topic: 'Draft the changelog' }, opts);
  check('create returns ok', created.ok === true && created.result.chat && !!created.result.chat.id);
  check('create seeds the draft with the topic', created.result.chat.draftSnippet === 'Draft the changelog');
  const chatId = created.result.chat.id;
  check('create returns a chat url', created.result.url === '#/chat/' + encodeURIComponent(chatId));

  const invalidCreate = await mouaif.runMouaif({ action: 'create', title: 'Must not exist', modelId: 'missing', providerId: 'ghost' }, opts);
  check('create rejects an invalid model', invalidCreate.ok === false && invalidCreate.result.code === 'EBADINPUT');
  check('failed model validation leaves no blank chat', chats.countChats(projectDir) === 1);
  const providerOnly = await mouaif.runMouaif({ action: 'create', providerId: 'ghost' }, opts);
  check('create rejects a provider without a model', providerOnly.result.code === 'EBADINPUT' && chats.countChats(projectDir) === 1);

  const created4 = await mouaif.runMouaif({ action: 'create', title: 'Fourth', topic: 'hello' }, opts);
  check('a second create works', created4.ok === true && created4.result.chat.title === 'Fourth');

  const list = await mouaif.runMouaif({ action: 'list' }, opts);
  check('list returns both chats', list.ok === true && list.result.chats.length === 2 && list.result.total === 2);
  check('list rows carry no full draft body', list.result.chats.every((c) => c.draft === undefined));
  check('list preserves the stored draft preview', list.result.chats.find((c) => c.id === chatId).draftSnippet === 'Draft the changelog');

  const limited = await mouaif.runMouaif({ action: 'list', limit: 1 }, opts);
  check('list honours the limit', limited.result.chats.length === 1 && limited.result.total === 2);

  const got = await mouaif.runMouaif({ action: 'get', chatId, includeMessages: true }, opts);
  check('get returns the chat', got.ok === true && got.result.chat.id === chatId);
  check('get returns messages when asked', Array.isArray(got.result.chat.messages));
  for (let i = 0; i < 3; i++) messages.appendMessage(projectDir, chatId, { role: 'user', content: 'message ' + i });
  const recent = await mouaif.runMouaif({ action: 'get', includeMessages: true, messageLimit: 2 }, { projectDir, chatId });
  check('get defaults to the running chat and returns the latest messages in order', recent.ok === true
    && recent.result.chat.messages.map((m) => m.content).join(',') === 'message 1,message 2');
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
  const badPrompt = await mouaif.runMouaif({ action: 'update', chatId, title: 'Must not change', promptId: 'missing' }, opts);
  check('unknown prompts are rejected before any update', badPrompt.result.code === 'EBADINPUT' && chats.getChat(projectDir, chatId).title === 'Changelog v2');
  const prompt = prompts.createPrompt(projectDir, { title: 'Review', content: 'Review the code.', scope: 'project' });
  const pinned = await mouaif.runMouaif({ action: 'update', chatId, promptId: prompt.id }, opts);
  check('update pins the selected prompt', pinned.ok === true && chats.getChat(projectDir, chatId).promptSnapshot.content === 'Review the code.');
  await mouaif.runMouaif({ action: 'update', chatId, promptId: '' }, opts);
  check('update can detach the prompt', chats.getChat(projectDir, chatId).promptSnapshot == null);

  settings.setProject(projectDir, { models: [{ id: 'fixture-model', provider: 'openai-compatible' }] });
  settings.setApp({ providers: [{ id: 'openai-compatible', baseUrl: 'http://fixture/v1', apiKey: 'fixture-secret' }] });
  const modeled = await mouaif.runMouaif({ action: 'create', title: 'With model', modelId: 'fixture-model' }, opts);
  check('create infers and persists the project model provider', modeled.ok === true
    && modeled.result.chat.providerId === 'openai-compatible' && !modeled.content.includes('fixture-secret'));
  const live = await mouaif.runMouaif({ action: 'update', chatId: modeled.result.chat.id, providerId: 'openai-compatible', modelId: 'live-model' }, opts);
  check('update accepts a live-catalog selection without persisting a model', live.ok === true
    && live.result.chat.modelId === 'live-model' && settings.getProject(projectDir).models.length === 1);
  const badProvider = await mouaif.runMouaif({ action: 'update', chatId: modeled.result.chat.id, providerId: 'ghost' }, opts);
  check('provider-only updates validate the resulting model pair', badProvider.result.code === 'EBADINPUT'
    && chats.getChat(projectDir, modeled.result.chat.id).providerId === 'openai-compatible');
  const clearedModel = await mouaif.runMouaif({ action: 'update', chatId: modeled.result.chat.id, modelId: '' }, opts);
  check('empty modelId clears the model and provider together', clearedModel.ok === true
    && clearedModel.result.chat.modelId === null && clearedModel.result.chat.providerId === null);

  const found = await mouaif.runMouaif({ action: 'search', query: 'Changelog' }, opts);
  check('search finds the renamed chat', found.ok === true && found.result.chats.some((c) => c.id === chatId));
  check('search preserves title match evidence', found.result.chats.find((c) => c.id === chatId).matchField === 'title'
    && found.result.chats.find((c) => c.id === chatId).snippet.toLowerCase().includes('changelog'));
  const draftHit = await mouaif.runMouaif({ action: 'search', query: 'Draft the' }, opts);
  check('search preserves draft match evidence', draftHit.result.chats[0].matchField === 'draft'
    && draftHit.result.chats[0].snippet.includes('Draft the changelog') && draftHit.result.chats[0].draftSnippet === 'Draft the changelog');
  const messageHit = await mouaif.runMouaif({ action: 'search', query: 'message 2' }, opts);
  check('search preserves message match evidence', messageHit.result.chats[0].matchField === 'message'
    && messageHit.result.chats[0].snippet.includes('message 2'));
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
  const invalidTarget = await mouaif.runMouaif({ action: 'attach', path: 'shot.png', target: 'typo' }, chatOpts);
  check('invalid attachment targets cannot silently modify the draft', invalidTarget.result.code === 'EBADINPUT'
    && chats.getChat(projectDir, imgChat).draftAttachments.length === 2);

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
  for (let i = 0; i < 200; i++) messages.appendMessage(projectDir, imgChat, { role: 'user', content: 'after image ' + i });
  const attachmentPage = await mouaif.runMouaif({ action: 'list_attachments' }, chatOpts);
  check('list_attachments reports a cursor instead of silently hiding older images', attachmentPage.ok === true
    && attachmentPage.result.messages.length === 0 && attachmentPage.result.nextBeforeSeq === 1);
  const olderAttachments = await mouaif.runMouaif({ action: 'list_attachments', beforeSeq: 1, limit: 1 }, chatOpts);
  check('list_attachments can retrieve an image older than the latest 200 messages', olderAttachments.ok === true
    && olderAttachments.result.messages.length === 1 && olderAttachments.result.messages[0].name === 'shot.png'
    && olderAttachments.result.nextBeforeSeq === null && !olderAttachments.content.includes('data:image'));
  const emptyAttachments = await mouaif.runMouaif({ action: 'list_attachments', beforeSeq: 0 }, chatOpts);
  check('list_attachments handles an exhausted cursor without losing drafts', emptyAttachments.ok === true
    && emptyAttachments.result.messages.length === 0 && emptyAttachments.result.nextBeforeSeq === null
    && emptyAttachments.result.drafts.length === 2);
  for (const beforeSeq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = await mouaif.runMouaif({ action: 'list_attachments', beforeSeq }, chatOpts);
    check('list_attachments rejects invalid cursor ' + beforeSeq, invalid.ok === false && invalid.result.code === 'EBADINPUT');
  }

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
  const emptyPatch = await mouaif.runMouaif({ action: 'settings_update', patch: {} }, opts);
  check('empty settings patches are rejected', emptyPatch.result.code === 'EBADINPUT');
  for (const scope of ['app', 'project']) {
    const seed = { providers: [{ id: 'openai-compatible', apiKey: 'provider-secret' }],
      models: [{ id: 'fixture-model', provider: 'openai-compatible', apiKey: 'model-secret' }] };
    if (scope === 'app') settings.setApp(seed);
    else settings.setProject(projectDir, seed);
    const get = await mouaif.runMouaif({ action: 'settings_get', scope }, opts);
    check(scope + ' settings redact provider and model secrets', !get.content.includes('provider-secret')
      && !get.content.includes('model-secret') && get.result.settings.providers[0].hasApiKey === true);
    const patch = { providers: get.result.settings.providers, models: get.result.settings.models };
    const put = await mouaif.runMouaif({ action: 'settings_update', scope, patch }, opts);
    const stored = scope === 'app' ? settings.getApp() : settings.getProject(projectDir);
    check(scope + ' redacted round-trip preserves secrets and drops response markers', put.ok === true
      && stored.providers[0].apiKey === 'provider-secret' && stored.models[0].apiKey === 'model-secret'
      && stored.providers[0].hasApiKey === undefined && stored.models[0].hasApiKey === undefined);
    check(scope + ' writes return redacted settings without mutating caller arguments', !put.content.includes('provider-secret')
      && !put.content.includes('model-secret') && patch.providers[0].apiKey === undefined);
    for (const key of ['providers', 'models']) {
      const deniedSecret = await mouaif.runMouaif({ action: 'settings_update', scope, patch: { [key]: [{ id: 'fixture', apiKey: 'forbidden' }] } }, opts);
      check(scope + ' refuses nested credentials in ' + key, deniedSecret.result.code === 'EBADINPUT');
    }
  }
  const both = await mouaif.runMouaif({ action: 'settings_update', scope: 'project', patch: { name: 'Must be unset' }, unset: ['name'] }, opts);
  check('unset wins over patch like the REST endpoint', both.ok === true && both.result.settings.name === undefined);
  settings.setDbBacked(projectDir, true);
  const dbRead = await mouaif.runMouaif({ action: 'settings_get', scope: 'project' }, opts);
  const dbWrite = await mouaif.runMouaif({ action: 'settings_update', patch: { name: 'DB project' } }, opts);
  check('DB-backed reads and writes never expose the storage marker', dbRead.result.settings.__dbBacked === undefined
    && dbWrite.result.settings.__dbBacked === undefined && settings.getProject(projectDir).__dbBacked === true);

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
  chats.updateChat(projectDir, imgChat, { toolAuth: { native: { shell: { mode: 'off' }, mouaif: { mode: 'allow' } } } });
  const chatInfo = await mouaif.runMouaif({ action: 'info' }, chatOpts);
  check('info reports effective chat-specific permissions', chatInfo.result.tools.shell.mode === 'off'
    && chatInfo.result.tools.mouaif.mode === 'allow');
  const features = await require('../src/agentFeatures.js').dispatchListFeatures({}, chatOpts);
  check('list_features agrees with info about chat-specific permissions', features.result.tools.shell.mode === 'off'
    && features.result.tools.mouaif.mode === 'allow');
  const projectInfo = await mouaif.runMouaif({ action: 'info' }, opts);
  check('project info does not inherit another chat\u2019s permissions', projectInfo.result.tools.shell.mode === info.result.tools.shell.mode
    && projectInfo.result.tools.mouaif.mode === info.result.tools.mouaif.mode);

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
