import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { openMapping } from '../src/mapping/storage.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CompactPage, CardIndex, DetailChunk } from '../src/mapping/compact-contracts.js';

it('外观版本真实HTTP可读，人和MCP同snapshot读完整正文/实际几何，写权限与原请求仍同路径', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-appearance-http-'));
  let mapping: ReturnType<typeof openMapping> | undefined;
  let http: ReturnType<typeof serve> | undefined,
    client: Client | undefined,
    server: ReturnType<typeof createMcpServer> | undefined;
  try {
    mapping = openMapping(directory);
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      mapping!.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    run({ type: 'project.create', expected: null, payload: { name: '同快照' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '标题', text: '完整原文\n第二行\n第三行', x: 10, y: 20 },
    });
    let app: ReturnType<typeof createWorkspaceApp>;
    http = serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => app.fetch(r) });
    await new Promise<void>((resolve) => http!.once('listening', resolve));
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    const token = mapping.access.issue('agent', ['p'], undefined, undefined, ['p']);
    const readOnly = mapping.access.issue('agent', ['p']);
    const state = () => mapping!.read({ type: 'project', projectId: 'p' }, human);
    const command = {
      commandId: 'original-style-http',
      projectId: 'p',
      type: 'card.appearance',
      expected: null,
      payload: { id: 'a', titleColor: '#f7e9bd', showPreview: true },
    };
    const post = (value: unknown, credential = token) =>
      fetch(origin + '/api/mapping/execute', {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(value),
      });
    const before = state();
    expect((await post(command, readOnly)).status).toBe(403);
    expect(state()).toEqual(before);
    const response = await post(command);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    const card = state().cards[0]!;
    const version = await fetch(
      origin +
        `/api/mapping/projects/p/versions/appearance/appearance:a/${card.appearance!.versionId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(version.status).toBe(200);
    expect(await version.json()).toEqual(card.appearance);
    const measured = await post({
      commandId: 'measured-http',
      projectId: 'p',
      type: 'card.layout',
      expected: {
        thought: card.versionId,
        body: card.body.versionId,
        pose: card.item.versionId,
        appearance: card.appearance!.versionId,
      },
      payload: { id: 'a', necessaryHeight: 58 },
    });
    expect(measured.status).toBe(200);
    server = createMcpServer(httpTransport(origin, token));
    client = new Client({ name: 'appearance-real-sdk', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const indexResult = await client.callTool({
      name: 'forkwise_read_map',
      arguments: { projectId: 'p', view: 'index' },
    });
    expect(indexResult.isError).not.toBe(true);
    const index = (indexResult.structuredContent as unknown as { response: CompactPage<CardIndex> })
      .response;
    expect(index).toEqual(
      mapping.read({ type: 'map', projectId: 'p', view: 'index', snapshot: index.snapshot }, human),
    );
    expect(index.items[0]!.item).toEqual(state().cards[0]!.item);
    expect(index.items[0]!.appearance).toEqual(card.appearance);
    const detailResult = await client.callTool({
      name: 'forkwise_read_map',
      arguments: { projectId: 'p', view: 'detail', cardId: 'a', snapshot: index.snapshot },
    });
    const detail = (
      detailResult.structuredContent as unknown as { response: CompactPage<DetailChunk> }
    ).response;
    expect(JSON.parse(detail.items.map((c) => c.jsonText).join(''))).toEqual(
      state().cards[0]!.body,
    );
    expect(detail.revision).toBe(index.revision);
    expect(JSON.parse(JSON.stringify(state()))).toEqual(state());
    const observed = await client.callTool({
      name: 'forkwise_observe_map',
      arguments: { projectId: 'p', afterRevision: before.project.revision },
    });
    expect(observed.isError).not.toBe(true);
    expect(
      (observed.structuredContent as { response: { changes: unknown[] } }).response.changes,
    ).toMatchObject([
      { domains: [{ domain: 'appearance', id: 'appearance:a' }] },
      { domains: [{ domain: 'pose', id: card.item.id }] },
    ]);
    expect(await (await post(command)).json()).toEqual(receipt);
    const saved = state();
    mapping.access.revoke(mapping.access.authenticate(token).tokenHash);
    expect((await post(command)).status).toBe(401);
    expect(
      (
        await client.callTool({
          name: 'forkwise_read_map',
          arguments: { projectId: 'p', view: 'index', snapshot: index.snapshot },
        })
      ).isError,
    ).toBe(true);
    expect(state()).toEqual(saved);
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          if (http)
            await new Promise<void>((resolve, reject) =>
              http!.close((e) => (e ? reject(e) : resolve())),
            );
        } finally {
          mapping?.close();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
});
