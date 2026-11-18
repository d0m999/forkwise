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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-agent-layout-history-'));
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
  execute({ type: 'project.create', expected: null, payload: { name: '交错历史' } });
  for (const id of ['c1', 'c2']) {
    execute({
      type: 'thought.create',
      expected: null,
      payload: { id, title: id, text: '', x: 10, y: 20 },
    });
  }
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
    randomUUID().replace(/-/g, 'f'),
    ['p'],
    [scope],
  );
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  const card = (id: string) => state().cards.find((item) => item.id === id)!;
  const mcp = createMcpServer(httpTransport(origin, token));
  const [left, right] = InMemoryTransport.createLinkedPair();
  await mcp.connect(right);
  const client = new Client({ name: 'agent-layout-history', version: '1.0.0' });
  await client.connect(left);
  cleanups.push(() => void client.close());
  cleanups.push(() => void mcp.close());
  const postAsAgent = async (body: unknown) => {
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
  return { mapping, human, execute, state, history, card, client, postAsAgent, token };
}

it('AC5 Agent 只读项目历史，直接撤销/重做被 HUMAN_REQUIRED 拒绝且无写入', async () => {
  const f = await fixture();
  const before = f.state();

  const read = (await f.client.callTool({
    name: 'forkwise_read_mapping_history',
    arguments: { projectId: 'p' },
  })) as { isError?: boolean; structuredContent?: { response?: any }; content: { text: string }[] };
  expect(read.isError).not.toBe(true);
  expect(read.structuredContent!.response).toMatchObject({
    revision: f.state().project.revision,
    undo: expect.any(Array),
    redo: expect.any(Array),
  });
  expect(read.structuredContent!.response.undo.length).toBe(f.history().undo.length);

  for (const type of ['history.undo', 'history.redo']) {
    const denied = await f.postAsAgent({
      commandId: randomUUID(),
      projectId: 'p',
      type,
      expected: before.project.revision,
      payload: {},
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('HUMAN_REQUIRED');
    expect(f.state()).toEqual(before);
  }
  const names = await f.client
    .listTools()
    .then((list) => list.tools.map((tool) => tool.name));
  expect(names.filter((name) => /undo|redo/.test(name))).toEqual([]);
});

it('AC5 人类 A → Agent B → 人类 C 的交错历史按项目顺序撤销，不跳过 Agent 动作', async () => {
  const f = await fixture();
  const c1 = f.card('c1');
  const c2 = f.card('c2');

  const a = f.execute({
    type: 'pose.move',
    expected: c1.item.versionId,
    payload: { id: 'c1', x: 100, y: 100 },
  });
  const afterA = f.card('c1');
  const b = (await f.client.callTool({
    name: 'forkwise_move_card',
    arguments: {
      projectId: 'p',
      commandId: randomUUID(),
      cardId: 'c2',
      expected: c2.item.versionId,
      x: 700,
      y: 500,
    },
  })) as { isError?: boolean; structuredContent?: { response?: any } };
  expect(b.isError).not.toBe(true);
  const afterB = f.card('c2');
  const c = f.execute({
    type: 'pose.move',
    expected: afterA.item.versionId,
    payload: { id: 'c1', x: 300, y: 300 },
  });
  const afterC = f.card('c1');

  expect(f.history().undo.slice(-3).map((action) => action.label)).toEqual([
    'pose.move',
    'pose.move',
    'pose.move',
  ]);
  expect(f.history().undo.slice(-3).map((action) => action.actor.type)).toEqual([
    'human',
    'agent',
    'human',
  ]);
  expect(a.revision).toBeLessThan(b.structuredContent!.response.revision);
  expect(b.structuredContent!.response.revision).toBeLessThan(c.revision);

  const undo = () =>
    f.execute({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  const first = undo();
  expect(f.card('c1').item.pose).toEqual(afterA.item.pose);
  expect(first.revision).toBe(c.revision + 1);

  const second = undo();
  expect(f.card('c2').item.pose).toEqual(c2.item.pose);
  expect(f.card('c1').item.pose).toEqual(afterA.item.pose);
  expect(second.revision).toBe(first.revision + 1);

  const third = undo();
  expect(f.card('c1').item.pose).toEqual(c1.item.pose);
  expect(third.revision).toBe(second.revision + 1);
  expect(f.history().redo).toHaveLength(3);

  const redo = () =>
    f.execute({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  redo();
  expect(f.card('c1').item.pose).toEqual(afterA.item.pose);
  redo();
  expect(f.card('c2').item.pose).toEqual(afterB.item.pose);
  redo();
  expect(f.card('c1').item.pose).toEqual(afterC.item.pose);
  expect(f.history().undo).toHaveLength(5);
  expect(f.history().redo).toHaveLength(0);
});
