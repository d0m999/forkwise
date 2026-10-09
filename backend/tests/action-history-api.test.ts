import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { statement } from './helpers.js';

test('HTTP 撤销与增量同步共用回执，恢复检索内容并保留项目权限', async () => {
  const origin = 'http://127.0.0.1:8787',
    app = createApplication({ database: ':memory:', origin });
  const token = app.access.issue('human', ['*']);
  const call = async (
    path: string,
    method = 'GET',
    body?: unknown,
    key = randomUUID(),
    credential = token,
  ) => {
    const response = await app.app.request(origin + '/api/v1' + path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    const project = (await call('/projects', 'POST', { name: '统一历史接口' })).data;
    const root = `/projects/${project.id}`;
    await call(root + '/operations', 'POST', {
      expected: {},
      commands: [statement('a', '旧版收入论证')],
    });
    await call(root + '/operations', 'POST', {
      expected: { a: 1 },
      commands: [{ op: 'statement.edit', id: 'a', text: '新版利润论证', scope: 'all' }],
    });
    const workspace = (await call(root + '/workspace')).data;
    const request = {
      direction: 'undo',
      expectedRevision: workspace.state.project.revision,
      expectedHistoryVersion: workspace.history.version,
      expectedLayoutVersion: workspace.layout.version,
    };
    const foreign = app.access.issue('agent', []);
    expect(
      (await call(root + '/action-history', 'GET', undefined, randomUUID(), foreign)).status,
    ).toBe(403);
    const agent = app.access.issue('agent', [project.id]);
    expect(
      (await call(root + '/action-history/travel', 'POST', request, randomUUID(), agent)).data,
    ).toBeNull();
    const key = randomUUID(),
      reverted = await call(root + '/action-history/travel', 'POST', request, key);
    expect(reverted.status).toBe(200);
    expect(reverted.data.upserted[0]).toMatchObject({ version: 3, data: { text: '旧版收入论证' } });
    expect(await call(root + '/action-history/travel', 'POST', request, key)).toEqual(reverted);
    const sync = (await call(root + '/sync?afterRevision=2&layoutVersion=0')).data;
    expect(sync.needsSnapshot).toBe(false);
    expect(sync.changes).toEqual([reverted.data]);
    expect(sync.history.redo.label).toBe('改写主张');
    expect(app.search.search(project.id, '旧版收入').results.map((x) => x.entityId)).toEqual(['a']);
    expect(app.search.search(project.id, '新版利润').results).toEqual([]);
  } finally {
    app.db.close();
  }
});
