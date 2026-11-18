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
import type { CommitOptions } from '../src/mapping/mapping.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-agent-layout-idem-'));
  let failure: 'versions' | 'history' | 'receipt' | null = null;
  const options: CommitOptions = {
    checkpoint: (phase) => {
      if (failure === phase) throw new Error(`injected-${phase}`);
    },
  };
  let mapping = openMapping(directory, options);
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
  execute({ type: 'project.create', expected: null, payload: { name: '幂等' } });
  execute({
    type: 'thought.create',
    expected: null,
    payload: { id: 'c1', title: 'c1', text: '', x: 10, y: 20 },
  });
  const scope: LayoutDelegation = {
    projectId: 'p',
    operations: ['pose.move'],
    objectKinds: ['card'],
    objectIds: '*',
    fields: ['x', 'y'],
  };
  const token = mapping.access.issue(
    'agent',
    ['p'],
    60_000,
    randomUUID().replace(/-/g, 'd'),
    ['p'],
    [scope],
  );
  const otherToken = mapping.access.issue(
    'agent',
    ['p'],
    60_000,
    randomUUID().replace(/-/g, 'e'),
    ['p'],
    [scope],
  );
  const agent = () => mapping.access.authenticate(token);
  const otherAgent = () => mapping.access.authenticate(otherToken);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  const card = () => state().cards[0]!;
  const mcp = createMcpServer(httpTransport(origin, token));
  const [left, right] = InMemoryTransport.createLinkedPair();
  await mcp.connect(right);
  const client = new Client({ name: 'agent-layout-idem', version: '1.0.0' });
  await client.connect(left);
  cleanups.push(() => void client.close());
  cleanups.push(() => void mcp.close());
  return {
    get mapping() {
      return mapping;
    },
    state,
    history,
    card,
    agent,
    otherAgent,
    setFailure: (phase: typeof failure) => {
      failure = phase;
    },
    async mcpMove(args: Record<string, unknown>) {
      return client.callTool({ name: 'forkwise_move_card', arguments: args }) as Promise<{
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: { response?: any };
      }>;
    },
    restart() {
      mapping.close();
      mapping = openMapping(directory, options);
      app = createWorkspaceApp(mapping, origin, () => new Response(''));
    },
  };
}

const moveBody = (commandId: string, expected: string, x = 200, y = 300) => ({
  commandId,
  projectId: 'p',
  type: 'pose.move',
  expected,
  payload: { id: 'c1', x, y },
});

it('AC4 同一成功请求重试返回原回执，revision 与历史只增加一次，重启后仍成立', async () => {
  const f = await fixture();
  const original = f.card();
  const commandId = randomUUID();
  const body = moveBody(commandId, original.item.versionId);
  const receipt = f.mapping.execute(body, f.agent());
  const revision = f.state().project.revision;
  const undo = f.history().undo.length;

  const replay = f.mapping.execute(body, f.agent());
  expect(replay).toEqual(receipt);
  expect(f.state().project.revision).toBe(revision);
  expect(f.history().undo).toHaveLength(undo);
  expect(f.card().item.versionId).not.toBe(original.item.versionId);

  f.restart();
  const afterRestart = f.mapping.execute(moveBody(commandId, original.item.versionId), f.agent());
  expect(afterRestart).toEqual(receipt);
  expect(f.state().project.revision).toBe(revision);
  expect(f.history().undo).toHaveLength(undo);
});

it('AC4 同 commandId 不同 body、不同 actor 一律拒绝，不返回别人的回执', async () => {
  const f = await fixture();
  const original = f.card();
  const commandId = randomUUID();
  const receipt = f.mapping.execute(moveBody(commandId, original.item.versionId), f.agent());
  const revision = f.state().project.revision;

  expect(() =>
    f.mapping.execute(moveBody(commandId, original.item.versionId, 999, 888), f.agent()),
  ).toThrow(/命令编号已用于不同请求/);
  expect(() =>
    f.mapping.execute(moveBody(commandId, original.item.versionId), f.otherAgent()),
  ).toThrow(/命令编号已用于不同请求/);
  expect(f.state().project.revision).toBe(revision);
  expect(receipt.revision).toBe(revision);
});

it('AC4 事务各阶段失败均回滚，失败不占用 commandId，重试成功后只写一次', async () => {
  const f = await fixture();
  const original = f.card();
  const undo = f.history().undo.length;
  let step = 0;
  let undoCount = undo;

  for (const phase of ['versions', 'history', 'receipt'] as const) {
    step += 1;
    const commandId = randomUUID();
    const before = f.state();
    f.setFailure(phase);
    expect(() =>
      f.mapping.execute(moveBody(commandId, before.cards[0]!.item.versionId), f.agent()),
    ).toThrow(new RegExp(`injected-${phase}`));
    f.setFailure(null);
    expect(f.state()).toEqual(before);
    expect(f.history().undo).toHaveLength(undoCount);

    const receipt = f.mapping.execute(
      moveBody(commandId, before.cards[0]!.item.versionId, 200 + step * 10, 300 + step * 10),
      f.agent(),
    );
    expect(receipt.revision).toBe(before.project.revision + 1);
    expect(f.card().item.pose).toMatchObject({ x: 200 + step * 10, y: 300 + step * 10 });
    undoCount += 1;
    expect(f.history().undo).toHaveLength(undoCount);
    f.restart();
  }
  expect(original.id).toBe('c1');
});

it('AC4 已提交但 ACK 未知时用原 commandId 与 body 重放取回原回执，不重复写入', async () => {
  const f = await fixture();
  const original = f.card();
  const commandId = randomUUID();
  const body = moveBody(commandId, original.item.versionId);
  const receipt = f.mapping.execute(body, f.agent());
  const revision = f.state().project.revision;
  const undo = f.history().undo.length;

  const replay = await f.mcpMove({
    projectId: 'p',
    commandId,
    cardId: 'c1',
    expected: original.item.versionId,
    x: 200,
    y: 300,
  });
  expect(replay.isError).not.toBe(true);
  expect(replay.structuredContent!.response).toEqual(receipt);
  expect(f.state().project.revision).toBe(revision);
  expect(f.history().undo).toHaveLength(undo);
});
