import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { CommitOptions } from '../src/mapping/mapping.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(options: CommitOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-history-'));
  let mapping = openMapping(directory, options);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const token = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(token);
  const state = (projectId = 'p') => mapping.read({ type: 'project', projectId }, human);
  const history = (projectId = 'p') => mapping.read({ type: 'history', projectId }, human);
  const run = (command: Record<string, unknown>, actor = human) =>
    mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
  const project = (projectId = 'p') =>
    run({ projectId, type: 'project.create', expected: null, payload: { name: '研究' } });
  const create = (id = 'c', projectId = 'p', editGroup?: string) =>
    run({
      projectId,
      type: 'thought.create',
      expected: null,
      payload: { id, title: '', text: '', x: 10, y: 20 },
      ...(editGroup ? { editGroup } : {}),
    });
  const travel = (type: 'history.undo' | 'history.redo', projectId = 'p') =>
    run({ projectId, type, expected: state(projectId).project.revision, payload: {} });
  project();
  return {
    get mapping() {
      return mapping;
    },
    human,
    run,
    state,
    history,
    create,
    project,
    travel,
    restart() {
      mapping.close();
      mapping = openMapping(directory, options);
    },
  };
}
it('创建撤销持久删除并保留身份，重做恢复同卡/正文/块/位置且生成新版本', () => {
  const f = fixture();
  f.create();
  const original = f.state().cards[0]!;
  expect(f.history().undo).toHaveLength(1);
  const command = {
    commandId: 'undo-create',
    type: 'history.undo',
    expected: f.state().project.revision,
    payload: {},
  };
  const receipt = f.run(command);
  expect(f.state().cards).toEqual([]);
  expect(receipt.deletedIds).toEqual([original.id, original.body.id, original.item.id]);
  expect(
    f.mapping.observe({ projectId: 'p', afterRevision: receipt.revision - 1 }, f.human).changes[0],
  ).toMatchObject({ after: null, deletedIds: receipt.deletedIds });
  expect(() => f.create()).toThrow('身份已使用');
  f.restart();
  expect(f.run(command)).toEqual(receipt);
  expect(f.history().redo).toHaveLength(1);
  f.travel('history.redo');
  const restored = f.state().cards[0]!;
  expect(restored).toMatchObject({
    id: original.id,
    title: '',
    body: { id: original.body.id, blocks: original.body.blocks },
    item: { id: original.item.id, pose: original.item.pose },
  });
  expect(restored.versionId).not.toBe(original.versionId);
  expect(restored.body.versionId).not.toBe(original.body.versionId);
  expect(restored.item.versionId).not.toBe(original.item.versionId);
});
it('human/Agent 的 Body 与 Pose 按项目时间倒序，撤销只写变化域且旧版本永不再次有效', () => {
  const f = fixture();
  f.create();
  f.project('other');
  f.create('other-card', 'other');
  const other = f.state('other');
  const agent = f.mapping.access.authenticate(
    f.mapping.access.issue('agent', ['p'], undefined, undefined, ['p']),
  );
  const initial = f.state().cards[0]!;
  f.run({
    type: 'body.edit',
    expected: initial.body.versionId,
    payload: { id: 'c', text: '本人正文' },
  });
  const humanBody = f.state().cards[0]!;
  f.run(
    {
      type: 'body.edit',
      expected: humanBody.body.versionId,
      payload: { id: 'c', text: 'Agent 正文' },
    },
    agent,
  );
  const agentBody = f.state().cards[0]!;
  f.run({
    type: 'pose.move',
    expected: initial.item.versionId,
    payload: { id: 'c', x: 90, y: 100 },
  });
  expect(
    f.mapping.read({ type: 'history', projectId: 'p' }, agent).undo.map((a) => a.actor.type),
  ).toEqual(['human', 'human', 'agent', 'human']);
  expect(() =>
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} }, agent),
  ).toThrow('本机会话');
  expect(() =>
    f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} }, agent),
  ).toThrow('本机会话');
  f.travel('history.undo');
  const afterMove = f.state().cards[0]!;
  expect(afterMove.body).toEqual(agentBody.body);
  expect(afterMove.versionId).toBe(agentBody.versionId);
  expect(afterMove.item.pose).toEqual(initial.item.pose);
  expect(afterMove.item.versionId).not.toBe(initial.item.versionId);
  f.travel('history.undo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('本人正文');
  expect(f.state().cards[0]!.item).toEqual(afterMove.item);
  expect(() =>
    f.run({
      type: 'body.edit',
      expected: humanBody.body.versionId,
      payload: { id: 'c', text: '过期' },
    }),
  ).toThrow('正文已更新');
  f.travel('history.undo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('');
  for (let i = 0; i < 3; i++) f.travel('history.redo');
  expect(f.state().cards[0]).toMatchObject({
    body: { blocks: [{ text: 'Agent 正文' }] },
    item: { pose: { x: 90, y: 100 } },
  });
  expect(f.state('other')).toEqual(other);
});
it('仅最近40步可撤销：第41步截断最老动作，重启保留边界且无变化不清redo', () => {
  const f = fixture();
  f.create();
  for (let i = 1; i <= 40; i++)
    f.run({
      type: 'body.edit',
      expected: f.state().cards[0]!.body.versionId,
      payload: { id: 'c', text: String(i) },
    });
  expect(f.history().undo).toHaveLength(40);
  f.restart();
  for (let i = 0; i < 40; i++) f.travel('history.undo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('');
  expect(f.history().redo).toHaveLength(40);
  expect(() => f.travel('history.undo')).toThrow('没有可撤销');
  const state = f.state();
  const history = f.history();
  f.run({
    type: 'body.edit',
    expected: state.cards[0]!.body.versionId,
    payload: { id: 'c', text: '' },
  });
  expect(f.state()).toEqual(state);
  expect(f.history()).toEqual(history);
  f.travel('history.redo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('1');
  f.run({
    type: 'body.edit',
    expected: f.state().cards[0]!.body.versionId,
    payload: { id: 'c', text: '新分支' },
  });
  expect(f.history().redo).toEqual([]);
});
it('相邻正文保存批次合为一组，布局及其他actor命令截断，undo/redo不重新打开旧组', () => {
  const f = fixture();
  f.create();
  const body = (text: string, editGroup: string, actor = f.human) =>
    f.run(
      {
        type: 'body.edit',
        editGroup,
        expected: f.state().cards[0]!.body.versionId,
        payload: { id: 'c', text },
      },
      actor,
    );
  body('一', 'session:typing');
  body('一二', 'session:typing');
  expect(f.history().undo).toHaveLength(2);
  f.travel('history.undo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('');
  f.travel('history.redo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('一二');
  body('一二三', 'session:typing');
  expect(f.history().undo).toHaveLength(3);
  f.run({
    type: 'pose.move',
    expected: f.state().cards[0]!.item.versionId,
    payload: { id: 'c', x: 50, y: 70 },
  });
  body('四', 'session:typing');
  expect(f.history().undo).toHaveLength(5);
  const agent = f.mapping.access.authenticate(
    f.mapping.access.issue('agent', ['p'], undefined, undefined, ['p']),
  );
  body('Agent', 'session:typing', agent);
  body('五', 'session:typing');
  expect(f.history().undo).toHaveLength(7);
  f.travel('history.undo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('Agent');
  f.travel('history.undo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('四');
});
it('首次标题和创建只合并连续同组动作，已有标题整轮撤销，回到原标题不留空动作', () => {
  const f = fixture();
  f.create('c', 'p', 'first-title');
  const title = (value: string, editGroup: string) =>
    f.run({
      type: 'thought.title',
      editGroup,
      expected: f.state().cards[0]!.versionId,
      payload: { id: 'c', title: value },
    });
  title('库', 'first-title');
  title('库存观察', 'first-title');
  expect(f.history().undo).toHaveLength(1);
  f.travel('history.undo');
  expect(f.state().cards).toEqual([]);
  f.travel('history.redo');
  expect(f.state().cards[0]!.title).toBe('库存观察');
  title('需求', 'second-title');
  title('需求观察', 'second-title');
  expect(f.history().undo).toHaveLength(2);
  f.travel('history.undo');
  expect(f.state().cards[0]!.title).toBe('库存观察');
  title('临时', 'third-title');
  title('库存观察', 'third-title');
  expect(f.history().undo).toHaveLength(1);
  f.create('d', 'p', 'another-create');
  f.run({
    type: 'pose.move',
    expected: f.state().cards[1]!.item.versionId,
    payload: { id: 'd', x: 30, y: 40 },
  });
  f.run({
    type: 'thought.title',
    editGroup: 'another-create',
    expected: f.state().cards[1]!.versionId,
    payload: { id: 'd', title: '不跨布局' },
  });
  f.travel('history.undo');
  expect(f.state().cards[1]!.title).toBe('');
  expect(f.state().cards).toHaveLength(2);
});
it('项目改名与跨域 card.edit 均完整撤销，未改域不更新版本', () => {
  const f = fixture();
  f.create();
  f.run({
    type: 'project.rename',
    expected: f.state().project.versionId,
    payload: { name: '新名称' },
  });
  const renamed = f.state().project;
  f.travel('history.undo');
  expect(f.state().project.name).toBe('研究');
  expect(f.state().project.versionId).not.toBe(renamed.versionId);
  f.travel('history.redo');
  expect(f.state().project.name).toBe('新名称');
  const card = f.state().cards[0]!;
  f.run({
    type: 'card.edit',
    expected: { body: card.body.versionId, pose: card.item.versionId },
    payload: { id: 'c', text: '跨域', x: 50, y: 60 },
  });
  f.travel('history.undo');
  expect(f.state().cards[0]).toMatchObject({
    title: '',
    body: { blocks: [{ text: '' }] },
    item: { pose: { x: 10, y: 20 } },
  });
  f.travel('history.redo');
  expect(f.state().cards[0]).toMatchObject({
    body: { blocks: [{ text: '跨域' }] },
    item: { pose: { x: 50, y: 60 } },
  });
});
it.each(['versions', 'history', 'receipt'] as const)(
  'undo 在 %s 处失败完全回滚，原键重试跨重启不再撤销下一步',
  (phase) => {
    let fail = false;
    const f = fixture({
      checkpoint(at) {
        if (fail && at === phase) throw new Error('INJECTED');
      },
    });
    f.create();
    const before = f.state();
    const history = f.history();
    const command = {
      commandId: 'retry',
      type: 'history.undo',
      expected: before.project.revision,
      payload: {},
    };
    fail = true;
    expect(() => f.run(command)).toThrow('INJECTED');
    expect(f.state()).toEqual(before);
    expect(f.history()).toEqual(history);
    expect(
      f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human)
        .changes,
    ).toEqual([]);
    fail = false;
    const receipt = f.run(command);
    f.restart();
    expect(f.run(command)).toEqual(receipt);
    expect(f.history().redo).toHaveLength(1);
    expect(() => f.run({ ...command, expected: 0 })).toThrow('命令编号');
  },
);
it('真实HTTP允许Agent只读历史，禁止撤销/重做及借用human回执或伪造身份', async () => {
  const f = fixture();
  f.create();
  const { serve } = await import('@hono/node-server');
  const { createWorkspaceApp } = await import('../src/mapping/http.js');
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = createWorkspaceApp(f.mapping, origin, () => new Response(''));
  try {
    const agent = f.mapping.access.issue('agent', ['p'], undefined, undefined, ['p']);
    const human = f.mapping.access.issue('human', ['p']);
    const other = f.mapping.access.issue('agent', ['other']);
    const read = (token: string) =>
      fetch(origin + '/api/mapping/projects/p/history', {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await read(agent)).status).toBe(200);
    expect(await (await read(agent)).json()).toMatchObject({
      undo: [{ target: { id: 'c' } }],
      redo: [],
    });
    expect((await read(other)).status).toBe(403);
    const post = (token: string, input: unknown) =>
      fetch(origin + '/api/mapping/execute', {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });
    const command = {
      commandId: 'http-undo',
      projectId: 'p',
      type: 'history.undo',
      expected: f.state().project.revision,
      payload: {},
    };
    expect((await post(human, command)).status).toBe(200);
    expect((await post(agent, command)).status).toBe(403);
    expect((await post(agent, { ...command, type: 'history.redo' })).status).toBe(403);
    expect((await post(agent, { ...command, actor: { type: 'human' } })).status).toBe(400);
    expect(f.history().redo).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
it('同名editGroup不跨可信会话合并，无变化布局命令也结束当前输入组', () => {
  const f = fixture();
  f.create();
  const otherSession = f.mapping.access.authenticate(f.mapping.access.issue('human', ['p']));
  const body = (text: string, actor = f.human) =>
    f.run(
      {
        type: 'body.edit',
        editGroup: 'same-group',
        expected: f.state().cards[0]!.body.versionId,
        payload: { id: 'c', text },
      },
      actor,
    );
  body('A');
  body('B', otherSession);
  expect(f.history().undo).toHaveLength(3);
  body('C', otherSession);
  const before = f.state();
  f.run(
    {
      type: 'pose.move',
      expected: before.cards[0]!.item.versionId,
      payload: { id: 'c', x: 10, y: 20 },
    },
    otherSession,
  );
  expect(f.state()).toEqual(before);
  body('D', otherSession);
  expect(f.history().undo).toHaveLength(4);
  f.travel('history.undo');
  expect(f.state().cards[0]!.body.blocks[0]!.text).toBe('C');
});
it('同一历史修订的重复或竞争撤销不会多退一步，变更保持单调', () => {
  const f = fixture();
  f.create();
  f.run({
    type: 'body.edit',
    expected: f.state().cards[0]!.body.versionId,
    payload: { id: 'c', text: '内容' },
  });
  const before = f.state();
  const command = {
    commandId: 'one-travel',
    type: 'history.undo',
    expected: before.project.revision,
    payload: {},
  };
  const receipt = f.run(command);
  expect(f.run(command)).toEqual(receipt);
  expect(() => f.run({ ...command, commandId: 'racing-travel' })).toThrow('项目历史已更新');
  expect(f.state().cards).toHaveLength(1);
  expect(f.history().redo).toHaveLength(1);
  expect(
    f.mapping
      .observe({ projectId: 'p', afterRevision: before.project.revision }, f.human)
      .changes.map((c) => c.revision),
  ).toEqual([before.project.revision + 1]);
});
it('隔离合成前版库副本以空研究栈打开，保留旧内容、不可变版本和成功回执', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { copyFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'forkwise-pre-history-'));
  let m = openMapping(join(root, 'previous'));
  let open = true;
  try {
    const token = m.access.issue('human', ['*']);
    const actor = m.access.authenticate(token);
    m.execute(
      {
        commandId: 'p',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: '前版' },
      },
      actor,
    );
    const command = {
      commandId: 'c',
      projectId: 'p',
      type: 'thought.create',
      expected: null,
      payload: { id: 'c', title: '前版标题', text: '前版正文', x: 1, y: 2 },
    };
    const receipt = m.execute(command, actor);
    const previous = m.read({ type: 'project', projectId: 'p' }, actor);
    m.close();
    open = false;
    // Only this test-owned fixture is reduced to the #3 schema. Never open user libraries.
    const db = new Database(join(root, 'previous/workspace.sqlite'));
    db.exec('DROP TABLE mapping_history; DROP TABLE mapping_card_ids;');
    db.close();
    const { mkdirSync, chmodSync } = await import('node:fs');
    mkdirSync(join(root, 'copy'), { mode: 0o700 });
    copyFileSync(join(root, 'previous/workspace.sqlite'), join(root, 'copy/workspace.sqlite'));
    chmodSync(join(root, 'copy/workspace.sqlite'), 0o600);
    m = openMapping(join(root, 'copy'));
    open = true;
    const reopened = m.access.authenticate(token);
    expect(m.read({ type: 'project', projectId: 'p' }, reopened)).toEqual(previous);
    expect(m.read({ type: 'history', projectId: 'p' }, reopened)).toEqual({
      revision: 2,
      undo: [],
      redo: [],
    });
    expect(m.execute(command, reopened)).toEqual(receipt);
    const card = previous.cards[0]!;
    expect(
      m.read(
        {
          type: 'version',
          projectId: 'p',
          domain: 'body',
          id: card.body.id,
          versionId: card.body.versionId,
        },
        reopened,
      ),
    ).toEqual(card.body);
    m.execute(
      {
        commandId: 'edit',
        projectId: 'p',
        type: 'body.edit',
        expected: card.body.versionId,
        payload: { id: 'c', text: '本版修改' },
      },
      reopened,
    );
    m.execute(
      { commandId: 'undo', projectId: 'p', type: 'history.undo', expected: 3, payload: {} },
      reopened,
    );
    expect(
      m.read({ type: 'project', projectId: 'p' }, reopened).cards[0]!.body.blocks[0]!.text,
    ).toBe('前版正文');
  } finally {
    if (open) m.close();
    rmSync(root, { recursive: true, force: true });
  }
});
