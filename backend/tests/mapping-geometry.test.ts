import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { Card } from '../src/mapping/contracts.js';
import type { CommitOptions } from '../src/mapping/mapping.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(options: CommitOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-geometry-'));
  let mapping = openMapping(directory, options);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const token = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(token);
  const run = (command: Record<string, unknown>, actor = human) =>
    mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  run({ type: 'project.create', expected: null, payload: { name: '自由画布' } });
  for (const id of ['a', 'b'])
    run({
      type: 'thought.create',
      expected: null,
      payload: { id, title: id, text: id + '正文', x: id === 'a' ? 10 : 410, y: 20 },
    });
  const batch = (cards: Card[], poses: Card['item']['pose'][]) => ({
    type: 'pose.batch',
    expected: Object.fromEntries(cards.map((c) => [c.id, c.item.versionId])),
    payload: { poses: cards.map((c, i) => ({ id: c.id, ...poses[i]! })) },
  });
  return {
    get mapping() {
      return mapping;
    },
    directory,
    human,
    run,
    state,
    history,
    batch,
    restart() {
      mapping.close();
      mapping = openMapping(directory, options);
    },
    travel(type: 'history.undo' | 'history.redo') {
      return run({ type, expected: state().project.revision, payload: {} });
    },
  };
}

it('多卡完整几何在一个revision和历史动作持久化，正文并发不被旧Pose覆盖，重开及Agent同快照一致', () => {
  const f = fixture();
  const before = f.state();
  const peer = openMapping(f.directory);
  try {
    peer.execute(
      {
        commandId: 'body-peer',
        projectId: 'p',
        type: 'body.edit',
        expected: before.cards[0]!.body.versionId,
        payload: { id: 'a', text: '并发新正文' },
      },
      peer.access.authenticate(f.mapping.access.issue('agent', ['p'], undefined, undefined, ['p'])),
    );
  } finally {
    peer.close();
  }
  const poses = [
    { x: 100, y: 120, width: 350, height: 200 },
    { x: 500, y: 120, width: 280, height: 160 },
  ];
  const command = f.batch(before.cards, poses);
  const receipt = f.run(command);
  const moved = f.state();
  expect(moved.cards.map((c) => c.item.pose)).toEqual(poses);
  expect(moved.cards[0]!.body.blocks[0]!.text).toBe('并发新正文');
  expect(receipt.changedIds).toEqual(before.cards.map((c) => c.item.id));
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: receipt.revision - 1 }, f.human);
  expect(delta.changes).toHaveLength(1);
  expect(delta.changes[0]!.domains).toEqual(
    before.cards.map((c) => ({ domain: 'pose', id: c.item.id })),
  );
  expect(f.history().undo).toHaveLength(4);
  f.travel('history.undo');
  expect(f.state().cards.map((c) => c.item.pose)).toEqual(before.cards.map((c) => c.item.pose));
  expect(f.state().cards[0]!.body).toEqual(moved.cards[0]!.body);
  f.travel('history.redo');
  f.restart();
  const reopened = f.state();
  const agent = f.mapping.access.authenticate(f.mapping.access.issue('agent', ['p']));
  const index = f.mapping.read({ type: 'map', view: 'index', projectId: 'p' }, agent);
  expect(index.revision).toBe(reopened.project.revision);
  expect(index.items.map((c) => c.item.pose)).toEqual(reopened.cards.map((c) => c.item.pose));
  expect(reopened.cards.map((c) => c.item.pose)).toEqual(poses);
});

it('多卡无变化不写版本或历史，旧版本、重复目标和删除目标均整批拒绝且无半写', () => {
  const f = fixture();
  const before = f.state(),
    history = f.history();
  const noop = f.run(
    f.batch(
      before.cards,
      before.cards.map((c) => c.item.pose),
    ),
  );
  expect(noop.changedIds).toEqual([]);
  expect(f.state()).toEqual(before);
  expect(f.history()).toEqual(history);
  const invalid = f.batch(before.cards, [
    { x: 30, y: 40, width: 280, height: 160 },
    { x: 430, y: 40, width: 280, height: 160 },
  ]);
  expect(() => f.run({ ...invalid, expected: { ...invalid.expected, b: 'stale' } })).toThrow(
    '布局已更新',
  );
  expect(f.state()).toEqual(before);
  expect(
    f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes,
  ).toEqual([]);
  expect(() =>
    f.run({ ...invalid, payload: { poses: [invalid.payload.poses[0], invalid.payload.poses[0]] } }),
  ).toThrow('重复卡片');
  expect(() => f.run({ ...invalid, expected: { a: before.cards[0]!.item.versionId } })).toThrow(
    '每张卡片',
  );
  f.travel('history.undo');
  const removed = f.state();
  expect(() => f.run(invalid)).toThrow('不存在');
  expect(f.state()).toEqual(removed);
  expect(f.history().redo).toHaveLength(1);
});

it.each(['versions', 'history', 'receipt'] as const)(
  '多卡在%s故障完全回滚，原命令成功后重启幂等不重复几何历史',
  (phase) => {
    let fail = false;
    const f = fixture({
      checkpoint(at) {
        if (fail && at === phase) throw new Error('INJECTED');
      },
    });
    const before = f.state();
    const history = f.history();
    const command = {
      commandId: 'retry-geometry',
      ...f.batch(before.cards, [
        { x: 30, y: 40, width: 500, height: 300 },
        { x: 430, y: 40, width: 280, height: 160 },
      ]),
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
    const saved = f.state();
    f.restart();
    expect(f.run(command)).toEqual(receipt);
    expect(f.state()).toEqual(saved);
    expect(f.history().undo).toHaveLength(3);
  },
);

it('真实HTTP原子几何进入同SQLite，MCP SDK固定快照及变化一致，撤销授权后拒绝读取与回执重试', async () => {
  const { serve } = await import('@hono/node-server');
  const { createWorkspaceApp } = await import('../src/mapping/http.js');
  const { createMcpServer, httpTransport } = await import('../src/mcp-server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const f = fixture();
  let app: ReturnType<typeof createWorkspaceApp>;
  const http = serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => app.fetch(r) });
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  app = createWorkspaceApp(f.mapping, origin, () => new Response(''));
  const token = f.mapping.access.issue('agent', ['p'], undefined, undefined, ['p']);
  const readonly = f.mapping.access.issue('agent', ['p']);
  const server = createMcpServer(httpTransport(origin, token));
  const client = new Client({ name: 'geometry-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const before = f.state(),
      command = {
        commandId: 'http-geometry',
        projectId: 'p',
        ...f.batch(before.cards, [
          { x: 90, y: 100, width: 400, height: 300 },
          { x: 490, y: 100, width: 280, height: 160 },
        ]),
      };
    const write = (access: string) =>
      fetch(origin + '/api/mapping/execute', {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: `Bearer ${access}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
      });
    expect((await write(readonly)).status).toBe(403);
    expect(f.state()).toEqual(before);
    const response = await write(token);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.changedIds).toEqual(before.cards.map((c) => c.item.id));
    const result = await client.callTool({
      name: 'forkwise_read_map',
      arguments: { projectId: 'p', view: 'index' },
    });
    expect(result.isError).not.toBe(true);
    const index = (result.structuredContent as { response: { snapshot: string; revision: number } })
      .response;
    expect(index.revision).toBe(receipt.revision);
    expect(index).toEqual(
      f.mapping.read(
        { type: 'map', view: 'index', projectId: 'p', snapshot: index.snapshot },
        f.human,
      ),
    );
    const observed = await client.callTool({
      name: 'forkwise_observe_map',
      arguments: { projectId: 'p', afterRevision: before.project.revision },
    });
    expect(observed.isError).not.toBe(true);
    expect(
      (observed.structuredContent as { response: { changes: unknown[] } }).response.changes,
    ).toMatchObject([
      {
        revision: receipt.revision,
        domains: before.cards.map((c) => ({ domain: 'pose', id: c.item.id })),
      },
    ]);
    const saved = f.state();
    f.mapping.access.revoke(f.mapping.access.authenticate(token).tokenHash);
    expect((await write(token)).status).toBe(401);
    expect(
      (
        await client.callTool({
          name: 'forkwise_read_map',
          arguments: { projectId: 'p', view: 'index', snapshot: index.snapshot },
        })
      ).isError,
    ).toBe(true);
    expect(f.state()).toEqual(saved);
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
  }
});
