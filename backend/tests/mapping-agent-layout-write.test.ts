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
import type { Card } from '../src/mapping/contracts.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(cardCount = 3) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-agent-layout-write-'));
  let mapping = openMapping(directory);
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  app = createWorkspaceApp(mapping, origin, () => new Response(''));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  cleanups.push(() => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
  });

  const humanToken = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(humanToken);
  const execute = (command: Record<string, unknown>, actor = human) =>
    mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
  execute({ type: 'project.create', expected: null, payload: { name: 'Agent 布局' } });
  for (let index = 1; index <= cardCount; index++) {
    const id = `c${index}`;
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
    agent: mapping.access.authenticate(token),
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
    async post(body: unknown, actor: 'agent' | 'human' = 'agent') {
      const response = await fetch(origin + '/api/mapping/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          ...(actor === 'human'
            ? { Cookie: `forkwise_workspace_${port}=${humanToken}` }
            : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
  };
}

const BATCH_OVER_AGENT_LIMIT = 201;

const poseBatch = (cards: Card[], dx = 0) => ({
  commandId: randomUUID(),
  projectId: 'p',
  type: 'pose.batch',
  expected: Object.fromEntries(cards.map((card) => [card.id, card.item.versionId])),
  payload: {
    poses: cards.map(({ id, item }) => ({ id, ...item.pose, x: item.pose.x + dx })),
  },
});

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

it('AC3 Agent 经 HTTP 直连超过 200 张时先于目标查找拒绝，且不占用 commandId', async () => {
  const f = await fixture(BATCH_OVER_AGENT_LIMIT - 1);
  const before = f.state();
  const history = f.history();
  const valid = poseBatch(before.cards, 10);
  const missing = { ...valid.payload.poses[0]!, id: 'c201' };
  const response = await f.post({
    ...valid,
    expected: { ...valid.expected, [missing.id]: 'missing-version' },
    payload: { poses: [...valid.payload.poses, missing] },
  });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('INVALID_COMMAND');
  expect(f.state()).toEqual(before);
  expect(f.history()).toEqual(history);
  expect((await f.post(valid)).status).toBe(200);
});

it('人类经工作台使用的 HTTP 入口批量移动 201 张卡片，末项版本冲突时整批回滚，成功后重启可重放', async () => {
  const f = await fixture(BATCH_OVER_AGENT_LIMIT);
  const before = f.state();
  const history = f.history();
  const command = poseBatch(before.cards, 10);
  const conflicted = await f.post(
    { ...command, expected: { ...command.expected, [before.cards.at(-1)!.id]: 'stale-version' } },
    'human',
  );
  expect(conflicted.status).toBe(409);
  expect(conflicted.body.code).toBe('VERSION_CONFLICT');
  expect(f.state()).toEqual(before);
  expect(f.history()).toEqual(history);

  const saved = await f.post(command, 'human');
  expect(saved.status).toBe(200);
  expect(saved.body.revision).toBe(before.project.revision + 1);
  expect(saved.body.changedIds).toHaveLength(BATCH_OVER_AGENT_LIMIT);
  const after = f.state();
  expect(after.cards.map(({ id, item }) => ({ id, ...item.pose }))).toEqual(command.payload.poses);
  const savedHistory = f.history();
  expect(savedHistory.undo.at(-1)).toMatchObject({ label: 'pose.batch' });

  f.restart();
  expect(await f.post(command, 'human')).toEqual(saved);
  expect(f.state()).toEqual(after);
  expect(f.history()).toEqual(savedHistory);
});

it('AC4 Agent 在上限生效前保存的 201 张卡片批量回执可跨重启重放', async () => {
  const f = await fixture(BATCH_OVER_AGENT_LIMIT);
  const before = f.state();
  const history = f.history();
  const command = poseBatch(before.cards);
  const receipt = {
    commandId: command.commandId,
    projectId: command.projectId,
    revision: before.project.revision,
    changedIds: [],
  };
  // 上限生效前经 HTTP 直连提交的旧批次没有改变任何 Pose，只留下成功回执。
  f.mapping.access.db
    .prepare('INSERT INTO mapping_receipts (project_id, command_id, actor_id, request, receipt) VALUES (?, ?, ?, ?, ?)')
    .run(command.projectId, command.commandId, f.agent.actor.id, JSON.stringify(command), JSON.stringify(receipt));

  f.restart();
  expect(await f.post(command)).toEqual({ status: 200, body: receipt });
  const mismatched = await f.post({ ...command, expected: { ...command.expected, c1: 'different' } });
  expect(mismatched.status).toBe(409);
  expect(mismatched.body.code).toBe('IDEMPOTENCY_MISMATCH');
  expect(f.state()).toEqual(before);
  expect(f.history()).toEqual(history);
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
