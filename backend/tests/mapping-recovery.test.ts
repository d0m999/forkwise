import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('恢复身份查询区分有效、已删除与异项目缺失，重开不复活且观察流不被读取修改', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-recovery-'));
  let mapping = openMapping(directory);
  const token = mapping.access.issue('human', ['*']);
  const actor = mapping.access.authenticate(token);
  const run = (input: unknown) => mapping.execute(input, actor);
  try {
    for (const projectId of ['p', 'other'])
      run({
        commandId: 'p',
        projectId,
        type: 'project.create',
        expected: null,
        payload: { name: projectId },
      });
    run({
      commandId: 'c',
      projectId: 'p',
      type: 'thought.create',
      expected: null,
      payload: { id: 'c', title: '原卡', text: '原文', x: 0, y: 0 },
    });
    const query = { type: 'card.identity' as const, projectId: 'p', id: 'c' };
    expect(mapping.read(query, actor)).toMatchObject({
      availability: 'available',
      card: { id: 'c', title: '原卡' },
    });
    const before = mapping.observe({ projectId: 'p', afterRevision: 0 }, actor);
    expect(mapping.read({ ...query, projectId: 'other' }, actor)).toEqual({
      availability: 'not_found',
    });
    run({ commandId: 'delete', projectId: 'p', type: 'history.undo', expected: 2, payload: {} });
    expect(mapping.read(query, actor)).toEqual({ availability: 'deleted' });
    mapping.close();
    mapping = openMapping(directory);
    expect(mapping.read(query, actor)).toEqual({ availability: 'deleted' });
    expect(mapping.read({ ...query, id: 'never' }, actor)).toEqual({ availability: 'not_found' });
    expect(mapping.read({ type: 'project', projectId: 'p' }, actor).cards).toEqual([]);
    expect(mapping.observe({ projectId: 'p', afterRevision: 0 }, actor).changes).toHaveLength(
      before.changes.length + 1,
    );
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('正文引用尚未持久化媒体时不给保存ACK且不改变版本或历史，去掉引用后可用原键重试', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-gate-'));
  const mapping = openMapping(directory);
  const actor = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  try {
    mapping.execute(
      {
        commandId: 'p',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: '媒体保存门槛' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'c',
        projectId: 'p',
        type: 'thought.create',
        expected: null,
        payload: { id: 'c', title: '', text: '', x: 0, y: 0 },
      },
      actor,
    );
    const before = mapping.read({ type: 'project', projectId: 'p' }, actor);
    const command = {
      commandId: 'save',
      projectId: 'p',
      type: 'body.edit',
      expected: before.cards[0]!.body.versionId,
      payload: { id: 'c', text: '有未完成图片的文字', requiredAssetIds: ['not-persisted'] },
    };
    expect(() => mapping.execute(command, actor)).toThrowError(
      expect.objectContaining({ code: 'MEDIA_NOT_PERSISTED' }),
    );
    expect(mapping.read({ type: 'project', projectId: 'p' }, actor)).toEqual(before);
    const receipt = mapping.execute(
      { ...command, payload: { ...command.payload, requiredAssetIds: [] } },
      actor,
    );
    expect(receipt.revision).toBe(3);
    expect(mapping.read({ type: 'history', projectId: 'p' }, actor).undo).toHaveLength(2);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('恢复身份HTTP入口真实回环鉴权，越项目与未授权请求不泄露原卡', async () => {
  const { createWorkspaceApp } = await import('../src/mapping/http.js');
  const { serve } = await import('@hono/node-server');
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-recovery-http-'));
  const mapping = openMapping(directory);
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => app.fetch(req) });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = createWorkspaceApp(mapping, origin, () => new Response(''));
  try {
    const token = mapping.access.issue('human', ['*']);
    const actor = mapping.access.authenticate(token);
    mapping.execute(
      {
        commandId: 'p',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: '私有项目' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'c',
        projectId: 'p',
        type: 'thought.create',
        expected: null,
        payload: { id: 'c', title: '原卡', text: '', x: 0, y: 0 },
      },
      actor,
    );
    const url = origin + '/api/mapping/projects/p/cards/c/identity';
    expect((await fetch(url)).status).toBe(401);
    const other = mapping.access.issue('agent', ['other']);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${other}` } })).status).toBe(403);
    expect(
      (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json())
        .availability,
    ).toBe('available');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
