import { afterEach, expect, it } from 'vitest';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { compactFixture, closeCompactFixtures } from './compact-fixture.js';

afterEach(closeCompactFixtures);

it('公开搜索记录接口完整序列化条件、历史和清理保护，返回独立版本与同修订标签并拒绝越权', async () => {
  const f = compactFixture();
  f.mapping.execute(
    {
      type: 'tag.create',
      projectId: 'p',
      commandId: 'tag',
      expected: null,
      payload: { id: 'macro', name: '宏观' },
    },
    f.human,
  );
  const query = { text: 'ETF', tagIds: ['macro'] };
  const recorded = f.mapping.execute(
    {
      type: 'search.record',
      projectId: 'p',
      commandId: 'record',
      expected: null,
      payload: { query, intent: 'exit' },
    },
    f.human,
  ).searchState!;
  const cleared = f.mapping.execute(
    {
      type: 'search.clear',
      projectId: 'p',
      commandId: 'clear',
      expected: recorded.versionId,
      payload: { query },
    },
    f.human,
  ).searchState!;
  const origin = 'http://127.0.0.1:8790',
    app = createWorkspaceApp(f.mapping, origin, () => new Response(''));
  const token = f.mapping.access.issue('human', ['p']);
  const read = (authorization = token) =>
    app.request(origin + '/api/mapping/projects/p/search-state', {
      headers: { Authorization: `Bearer ${authorization}` },
    });
  const response = await read();
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value).toMatchObject({
    ...cleared,
    projectRevision: f.mapping.read({ type: 'project', projectId: 'p' }, f.human).project.revision,
    tags: [{ id: 'macro', name: '宏观' }],
  });
  expect(value.removed.entries).toEqual(recorded.history);
  expect((await read(f.mapping.access.issue('agent', ['other']))).status).toBe(403);
  expect((await read('forged')).status).toBe(401);
});
