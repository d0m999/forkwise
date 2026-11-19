import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { LayoutDelegation } from '../src/services/access.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const poseScope = (projectId: string, patch: Partial<LayoutDelegation> = {}): LayoutDelegation => ({
  projectId,
  operations: ['pose.move'],
  objectKinds: ['card'],
  objectIds: '*',
  fields: ['x', 'y'],
  ...patch,
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-agent-layout-auth-'));
  const mapping = openMapping(directory);
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = createWorkspaceApp(mapping, origin, () => new Response(''));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  cleanups.push(() => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
  });

  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const execute = (command: Record<string, unknown>, actor = human) =>
    mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
  execute({ type: 'project.create', expected: null, payload: { name: '授权' } });
  for (const id of ['c1', 'c2']) {
    execute({
      type: 'thought.create',
      expected: null,
      payload: { id, title: id, text: '', x: 10, y: 20 },
    });
  }
  const other = () => {
    execute({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '另一个' } });
    execute({
      projectId: 'q',
      type: 'thought.create',
      expected: null,
      payload: { id: 'q1', title: 'q', text: '', x: 0, y: 0 },
    });
    return mapping.read({ type: 'project', projectId: 'q' }, human).cards[0]!;
  };
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  const issueAgent = (scopes?: LayoutDelegation[], personalRecord = ['p']) =>
    mapping.access.issue(
      'agent',
      ['p'],
      60_000,
      randomUUID().replace(/-/g, 'a'),
      personalRecord,
      scopes,
    );
  const post = async (body: unknown, token: string) => {
    const response = await fetch(origin + '/api/mapping/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { mapping, origin, human, execute, other, state, history, issueAgent, post };
}

const moveCommand = (cardId: string, versionId: string, overrides: Record<string, unknown> = {}) => ({
  commandId: randomUUID(),
  projectId: 'p',
  type: 'pose.move',
  expected: versionId,
  payload: { id: cardId, x: 200, y: 300 },
  ...overrides,
});

it('AC1 有编辑委托但无布局细化授权时只读，布局写入在服务端拒绝且无写入', async () => {
  const f = await fixture();
  const card = f.state().cards.find((item) => item.id === 'c1')!;
  const token = f.issueAgent([]);
  const before = f.state();
  const undoBefore = f.history().undo.length;

  const denied = await f.post(moveCommand('c1', card.item.versionId), token);

  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('LAYOUT_DELEGATION_REQUIRED');
  expect(f.state()).toEqual(before);
  expect(f.history().undo).toHaveLength(undoBefore);

  const read = await fetch(f.origin + '/api/mapping/projects/p/map?view=index&budget=4096', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(read.status).toBe(200);
  const history = await fetch(f.origin + '/api/mapping/projects/p/history', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(history.status).toBe(200);

  // 只有项目读取授权、没有编辑委托时：仍可读，写入在项目级即拒绝。
  const readOnlyToken = f.issueAgent(undefined, []);
  const readOnly = await fetch(f.origin + '/api/mapping/projects/p/map?view=index&budget=4096', {
    headers: { Authorization: `Bearer ${readOnlyToken}` },
  });
  expect(readOnly.status).toBe(200);
  const readOnlyWrite = await f.post(moveCommand('c1', card.item.versionId), readOnlyToken);
  expect(readOnlyWrite.status).toBe(403);
  expect(readOnlyWrite.body.code).toBe('EDIT_DELEGATION_REQUIRED');
  expect(f.state()).toEqual(before);

  // 旧会话（capabilities 没有 layoutDelegations 键）不再默认获得 Pose 写入。
  const legacyToken = f.issueAgent(undefined, ['p']);
  const legacy = await f.post(moveCommand('c1', card.item.versionId), legacyToken);
  expect(legacy.status).toBe(403);
  expect(legacy.body.code).toBe('LAYOUT_DELEGATION_REQUIRED');
  expect(f.state()).toEqual(before);
});

it('AC1 声明式布局授权允许卡片 Pose 移动，写入 revision 与历史各增加一次', async () => {
  const f = await fixture();
  const card = f.state().cards.find((item) => item.id === 'c1')!;
  const token = f.issueAgent([poseScope('p')]);
  const before = f.state();
  const undoBefore = f.history().undo.length;

  const receipt = await f.post(moveCommand('c1', card.item.versionId), token);

  expect(receipt.status).toBe(200);
  expect(receipt.body).toMatchObject({ projectId: 'p', revision: before.project.revision + 1 });
  const after = f.state();
  expect(after.cards.find((item) => item.id === 'c1')!.item.pose).toMatchObject({ x: 200, y: 300 });
  expect(after.project.revision).toBe(before.project.revision + 1);
  expect(f.history().undo).toHaveLength(undoBefore + 1);
  expect(receipt.body.changedIds).toContain(card.item.id);
});

it('AC1 未声明 operation、对象与字段时逐项拒绝，其他对象与历史保持不变', async () => {
  const f = await fixture();
  const c1 = f.state().cards.find((item) => item.id === 'c1')!;
  const c2 = f.state().cards.find((item) => item.id === 'c2')!;
  const before = f.state();
  const undoBefore = f.history().undo.length;

  const wrongOperation = f.issueAgent([poseScope('p')]);
  const batch = await f.post(
    {
      commandId: randomUUID(),
      projectId: 'p',
      type: 'pose.batch',
      expected: { c1: c1.item.versionId },
      payload: {
        poses: [
          { id: 'c1', x: 1, y: 2, width: c1.item.pose.width, height: c1.item.pose.height },
        ],
      },
    },
    wrongOperation,
  );
  expect(batch.status).toBe(403);
  expect(batch.body.code).toBe('LAYOUT_OPERATION_FORBIDDEN');

  const unsupported = await f.post(
    {
      commandId: randomUUID(),
      projectId: 'p',
      type: 'canvas.move',
      expected: { c1: c1.item.versionId },
      payload: {
        targets: [{ kind: 'card', id: 'c1', itemId: c1.item.id, x: 1, y: 2 }],
      },
    },
    f.issueAgent([poseScope('p', { operations: ['pose.move', 'pose.batch'] })]),
  );
  expect(unsupported.status).toBe(403);
  expect(unsupported.body.code).toBe('LAYOUT_OPERATION_UNSUPPORTED');

  const narrowObject = f.issueAgent([poseScope('p', { objectIds: ['c2'] })]);
  const otherObject = await f.post(moveCommand('c1', c1.item.versionId), narrowObject);
  expect(otherObject.status).toBe(403);
  expect(otherObject.body.code).toBe('LAYOUT_OBJECT_FORBIDDEN');

  const narrowField = f.issueAgent([poseScope('p', { fields: ['x'] })]);
  const otherField = await f.post(moveCommand('c1', c1.item.versionId), narrowField);
  expect(otherField.status).toBe(403);
  expect(otherField.body.code).toBe('LAYOUT_FIELD_FORBIDDEN');

  expect(f.state()).toEqual(before);
  expect(f.history().undo).toHaveLength(undoBefore);
});

it('AC1 跨项目、跨对象 ID、额外未知字段与伪造 actor 均拒绝且不写入', async () => {
  const f = await fixture();
  const card = f.state().cards.find((item) => item.id === 'c1')!;
  f.other();
  const token = f.issueAgent([poseScope('p')]);
  const before = f.state();
  const undoBefore = f.history().undo.length;

  const crossProject = await f.post(
    { ...moveCommand('c1', card.item.versionId), projectId: 'q' },
    token,
  );
  expect(crossProject.status).toBe(403);
  expect(['PROJECT_FORBIDDEN', 'LAYOUT_DELEGATION_REQUIRED']).toContain(crossProject.body.code);

  const unknownField = await f.post(
    {
      ...moveCommand('c1', card.item.versionId),
      payload: { id: 'c1', x: 1, y: 2, title: '伪造' },
    },
    token,
  );
  expect(unknownField.status).toBe(400);

  const forgedActor = await f.post(
    { ...moveCommand('c1', card.item.versionId), actor: { id: 'local-owner', type: 'human' } },
    token,
  );
  expect(forgedActor.status).toBe(400);

  const forged = {
    ...f.mapping.access.authenticate(token),
    actor: { id: 'local-owner', type: 'human' },
  } as any;
  expect(() => f.mapping.execute(moveCommand('c1', card.item.versionId), forged)).toThrow(
    /身份和范围必须来自可信会话/,
  );

  expect(f.state()).toEqual(before);
  expect(f.history().undo).toHaveLength(undoBefore);
});

it('AC1 撤销或过期的 Agent 会话不能写入，Agent 不能自称人类签发授权', async () => {
  const f = await fixture();
  const card = f.state().cards.find((item) => item.id === 'c1')!;
  const token = f.issueAgent([poseScope('p')]);
  const before = f.state();

  const principal = f.mapping.access.authenticate(token);
  f.mapping.access.revoke(principal.tokenHash);
  const revoked = await f.post(moveCommand('c1', card.item.versionId), token);
  expect(revoked.status).toBe(401);
  expect(revoked.body.code).toBe('UNAUTHORIZED');

  const expiring = f.mapping.access.issue(
    'agent',
    ['p'],
    -1,
    randomUUID().replace(/-/g, 'b'),
    ['p'],
    [poseScope('p')],
  );
  const expired = await f.post(moveCommand('c1', card.item.versionId), expiring);
  expect(expired.status).toBe(401);
  expect(expired.body.code).toBe('UNAUTHORIZED');

  const agent = f.mapping.access.authenticate(f.issueAgent([poseScope('p')]));
  expect(() => f.mapping.access.human(agent)).toThrow(/本机会话确认/);
  expect(f.state()).toEqual(before);
});
