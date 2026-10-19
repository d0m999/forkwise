import { afterEach, expect, it } from 'vitest';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { compactFixture, closeCompactFixtures } from './compact-fixture.js';
import { readFile } from 'node:fs/promises';

afterEach(closeCompactFixtures);

it('正式 HTTP 搜索返回原文锚点并校验条件与当前项目授权', async () => {
  const f = compactFixture();
  f.create('c', '😀多頭平倉');
  const origin = 'http://127.0.0.1:8790';
  const app = createWorkspaceApp(f.mapping, origin, () => new Response(''));
  const token = f.mapping.access.issue('agent', ['p']);
  const search = (body: object, authorization = token) =>
    app.request(origin + '/api/mapping/projects/p/search', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${authorization}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const result = await search({ text: '"多头平仓"' });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    state: 'ready',
    projectId: 'p',
    results: [{ cardId: 'c', bodyHits: [{ start: 2, end: 6 }] }],
  });
  expect((await search({ text: '平仓', projectId: 'other' })).status).toBe(400);
  expect((await search({ text: '平仓' }, f.mapping.access.issue('agent', ['other']))).status).toBe(
    403,
  );
  expect((await search({ text: '平仓' }, 'forged')).status).toBe(401);
  expect(await (await search({ text: '平仓', tagIds: ['missing'] })).json()).toMatchObject({
    state: 'invalid_tags',
    invalidTagIds: ['missing'],
    results: [],
  });
});

it('库读取期间撤销会话后，搜索不得泄露结果', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = compactFixture({
    searchAssetReader: async (url) => {
      entered();
      await gate;
      return readFile(url);
    },
  });
  f.create('private', '私有原文');
  const pending = f.mapping.read({ type: 'search', projectId: 'p', text: '原文' }, f.agent);
  await started;
  f.mapping.access.revoke(f.agent.tokenHash);
  release();
  await expect(pending).rejects.toMatchObject({ status: 401 });
});
