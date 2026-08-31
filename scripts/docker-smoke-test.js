'use strict';

const assert = require('node:assert/strict');

const BASE_URL = process.env.BASE_URL || 'http://app:5732';
const PROJECT_DIR = process.env.PROJECT_DIR || '/workspace/example';

async function request(path, options = {}) {
  const response = await fetch(BASE_URL + path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  assert.ok(response.ok, `${options.method || 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

async function step(name, run) {
  await run();
  console.log(`PASS  ${name}`);
}

async function main() {
  let projectId;
  let chatId;

  await step('serves the built mobile UI', async () => {
    const { response, body } = await request('/');
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    assert.match(body, /<main id="app"><\/main>/);
  });

  await step('exposes the isolated container settings store', async () => {
    const { body } = await request('/api/settings');
    assert.equal(body.home, '/data');
  });

  await step('lists the mounted example project', async () => {
    const { body } = await request('/api/projects?dir=%2Fworkspace');
    assert.ok(body.entries.some((entry) => entry.path === PROJECT_DIR));
  });

  await step('registers the example project without changing its files', async () => {
    const { body } = await request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ action: 'register', dir: PROJECT_DIR, dbBacked: true })
    });
    projectId = body.project.id;
    assert.equal(body.project.path, PROJECT_DIR);
    assert.equal(body.dbBacked, true);
  });

  await step('reads example content through the file API', async () => {
    const query = new URLSearchParams({ projectDir: PROJECT_DIR, path: 'README.md' });
    const { body } = await request(`/api/file?${query}`);
    assert.match(body.content, /Docker test example/);
    assert.equal(body.path, `${PROJECT_DIR}/README.md`);
  });

  await step('creates a project chat', async () => {
    const { body } = await request('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ projectDir: PROJECT_DIR, title: 'Container smoke test' })
    });
    chatId = body.chat.id;
    assert.equal(body.chat.title, 'Container smoke test');
  });

  await step('persists and reads a complete example conversation', async () => {
    for (const message of [
      { role: 'user', content: 'Summarize the example greeting module.' },
      { role: 'assistant', content: 'It exports a friendly greeting function.' }
    ]) {
      await request(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ projectDir: PROJECT_DIR, ...message })
      });
    }
    const query = new URLSearchParams({ projectDir: PROJECT_DIR });
    const { body } = await request(`/api/chats/${encodeURIComponent(chatId)}/messages?${query}`);
    assert.deepEqual(body.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Summarize the example greeting module.' },
      { role: 'assistant', content: 'It exports a friendly greeting function.' }
    ]);
  });

  await step('returns the registered project and chat from list APIs', async () => {
    const { body: registered } = await request('/api/projects/registered');
    assert.ok(registered.projects.some((project) => project.id === projectId));
    const query = new URLSearchParams({ projectDir: PROJECT_DIR });
    const { body: chats } = await request(`/api/chats?${query}`);
    assert.ok(chats.chats.some((chat) => chat.id === chatId));
  });

  console.log('\nDocker smoke test passed.');
}

main().catch((error) => {
  console.error('\nDocker smoke test failed.');
  console.error(error.stack || error);
  process.exitCode = 1;
});
