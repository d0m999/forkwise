import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import type { LayoutDelegation } from '../src/services/access.js';
import { MAX_BATCH_POSES } from '../src/mapping/contracts.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-agent-layout-write-'));
  let mapping = openMapping(directory);
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
  execute({ type: 'project.create', expected: null, payload: { name: 'Agent 布局' } });
  for (const id of ['c1', 'c2', 'c3']) {
    execute({
      type: 'thought.create',
      expected: null,
      payload: { id, title: id, text: '', x: 10, y: 20 },
    });
  }
  const scope: LayoutDelegation = {
    projectId: 'p',
    operations: ['pose.move', 'pose.batch'],
    objectKinds: ['card'],
    objectIds: '*',
    fields: ['x', 'y', 'width', 'height'],
  };
  const token = mapping.access.issue(
    'agent',
    ['p'],
    60_000,
    randomUUID().replace(/-/g, 'c'),
    ['p'],
    [scope],
  );
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  const card = (id: string) => state().cards.find((item) => item.id === id)!;
  const client = new Client({ name: 'agent-layout-test', version: '1.0.0' });
  const mcp = createMcpServer(httpTransport(origin, token));
  const [left, right] = InMemoryTransport.createLinkedPair();
  await mcp.connect(right);
  await client.connect(left);
  cleanups.push(() => void client.close());
  cleanups.push(() => void mcp.close());
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{
      isError?: boolean;
      structuredContent?: { response?: any; error?: any };
      content: { text: string }[];
    }>;
  return {
    get mapping() {
      return mapping;
    },
    origin,
    human,
    execute,
    state,
    history,
    card,
    call,
    restart() {
      mapping.close();
      mapping = openMapping(directory);
      app = createWorkspaceApp(mapping, origin, () => new Response(''));
    },
    async post(body: unknown) {
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
    },
  };
}

it('AC2 Agent 读取同快照与 Pose 版本后经真实 MCP/HTTP 写入，SQLite、revision、历史与变更一致且重开仍存在', async () => {
  const f = await fixture();
  const indexResult = await f.call('forkwise_read_map', { projectId: 'p', view: 'index', budget: 65536 });
  expect(indexResult.isError).not.toBe(true);
  const index = indexResult.structuredContent!.response;
  const entry = index.items.find((item: any) => item.id === 'c1');
  expect(entry.item.versionId).toBeTruthy();

  const commandId = randomUUID();
  const moved = await f.call('forkwise_move_card', {
    projectId: 'p',
    commandId,
    cardId: 'c1',
    expected: entry.item.versionId,
    x: 320,
    y: 240,
  });
  expect(moved.isError).not.toBe(true);
  const receipt = moved.structuredContent!.response;
  expect(receipt).toMatchObject({
    commandId,
    projectId: 'p',
    revision: index.revision + 1,
  });
  expect(receipt.changedIds).toContain(entry.item.id);

  const saved = f.card('c1');
  expect(saved.item.pose).toMatchObject({ x: 320, y: 240 });
  expect(saved.item.versionId).not.toBe(entry.item.versionId);
  expect(f.state().project.revision).toBe(index.revision + 1);
  expect(f.history().undo.at(-1)).toMatchObject({ label: 'pose.move', target: { id: 'c1' } });

  const changes = f.mapping.observe(
    { projectId: 'p', afterRevision: index.revision },
    f.mapping.access.authenticate(f.mapping.access.issue('human', ['*'])),
  );
  expect(changes.changes.at(-1)).toMatchObject({ revision: index.revision + 1 });

  // 同一 commandId 直接走 HTTP 仍是同一 execute 与同一回执。
  const replay = await f.post({
    commandId,
    projectId: 'p',
    type: 'pose.move',
    expected: entry.item.versionId,
    payload: { id: 'c1', x: 320, y: 240 },
  });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(receipt);

  f.restart();
  expect(f.card('c1').item.pose).toMatchObject({ x: 320, y: 240 });
  expect(f.state().project.revision).toBe(index.revision + 1);
});

it('AC3 过期版本、已删除目标、跨项目与越对象逐类拒绝，失败前后无任何写入', async () => {
  const f = await fixture();
  const first = f.card('c1');

  const stale = await f.call('forkwise_move_card', {
    projectId: 'p',
    commandId: randomUUID(),
    cardId: 'c1',
    expected: 'stale-version',
    x: 1,
    y: 2,
  });
  expect(stale.isError).toBe(true);
  expect(stale.content[0]!.text).toContain('VERSION_CONFLICT');

  const deleted = f.card('c3');
  f.execute({
    type: 'thought.delete',
    expected: {
      thought: deleted.versionId,
      body: deleted.body.versionId,
      pose: deleted.item.versionId,
      appearance: deleted.appearance?.versionId ?? null,
    },
    payload: { id: 'c3' },
  });
  const before = f.state();
  const gone = await f.call('forkwise_move_card', {
    projectId: 'p',
    commandId: randomUUID(),
    cardId: 'c3',
    expected: deleted.item.versionId,
    x: 5,
    y: 6,
  });
  expect(gone.isError).toBe(true);
  expect(gone.content[0]!.text).toContain('LAYOUT_TARGET_NOT_FOUND');
  expect(f.state()).toEqual(before);

  const crossProject = await f.call('forkwise_move_card', {
    projectId: 'q',
    commandId: randomUUID(),
    cardId: 'c1',
    expected: first.item.versionId,
    x: 7,
    y: 8,
  });
  expect(crossProject.isError).toBe(true);

  const batch = await f.call('forkwise_move_cards', {
    projectId: 'p',
    commandId: randomUUID(),
    expected: { c1: first.item.versionId, c2: 'stale-version' },
    poses: [
      { cardId: 'c1', x: 100, y: 100, width: first.item.pose.width, height: first.item.pose.height },
      { cardId: 'c2', x: 200, y: 200, width: 300, height: 200 },
    ],
  });
  expect(batch.isError).toBe(true);
  expect(batch.content[0]!.text).toContain('VERSION_CONFLICT');
  expect(f.card('c1').item.pose).toEqual(first.item.pose);
  expect(f.state().project.revision).toBe(before.project.revision);
});

it('AC3 批量张数上限由权威契约执行，HTTP 直连超过 200 张同样拒绝且无写入', async () => {
  const f = await fixture();
  const before = f.state();
  const poses = Array.from({ length: MAX_BATCH_POSES + 1 }, (_, index) => ({
    id: `c${index + 1}`,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  }));
  const response = await f.post({
    commandId: randomUUID(),
    projectId: 'p',
    type: 'pose.batch',
    expected: {},
    payload: { poses },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('INVALID_COMMAND');
  expect(f.state()).toEqual(before);
});

it('AC3 并发人类修改同一 Pose 后旧 Agent 请求冲突，重读并更换 commandId 才写入', async () => {
  const f = await fixture();
  const initial = f.card('c1');
  f.execute({
    type: 'pose.move',
    expected: initial.item.versionId,
    payload: { id: 'c1', x: 500, y: 500 },
  });
  const humanMoved = f.card('c1');
  const stale = await f.call('forkwise_move_card', {
    projectId: 'p',
    commandId: randomUUID(),
    cardId: 'c1',
    expected: initial.item.versionId,
    x: 1,
    y: 1,
  });
  expect(stale.isError).toBe(true);
  expect(stale.content[0]!.text).toContain('VERSION_CONFLICT');
  expect(f.card('c1').item.pose).toEqual(humanMoved.item.pose);

  const fresh = await f.call('forkwise_move_card', {
    projectId: 'p',
    commandId: randomUUID(),
    cardId: 'c1',
    expected: humanMoved.item.versionId,
    x: 620,
    y: 410,
  });
  expect(fresh.isError).not.toBe(true);
  expect(f.card('c1').item.pose).toMatchObject({ x: 620, y: 410 });
});
