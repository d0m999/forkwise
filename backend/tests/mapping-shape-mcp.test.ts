import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { CompactPage, ShapeIndex, DetailChunk } from '../src/mapping/compact-contracts.js';

it('真实 MCP SDK 发现与调用形状索引和详情经 HTTP 固定同快照版本，项目及对象身份边界保持', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-shape-mcp-'));
  const mapping = openMapping(directory);
  let http: ReturnType<typeof serve> | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  let client: Client | undefined;
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: 'MCP Shape' } });
    const id = 'shape/固定? #1';
    const content = { shapeType: 'rectangle', shortText: 'MCP 固定短文字🧠 "引用"', fill: '#fef3c7', stroke: '#92400e', strokeWidth: 2 };
    run({ type: 'shape.create', expected: null, payload: { id, content, pose: { x: -40, y: 70, width: 180, height: 100 } } });
    const original = state().shapes![0]!;
    run({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '未授权项目' } });
    run({ projectId: 'q', type: 'shape.create', expected: null, payload: { id: 'q-only', content: { shapeType: 'triangle', shortText: '不应泄露的另一项目文字' }, pose: { x: 0, y: 0, width: 100, height: 100 } } });
    let app: ReturnType<typeof createWorkspaceApp>;
    http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => { http!.once('listening', resolve); http!.once('error', reject); });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    const token = mapping.access.issue('agent', ['p']);
    server = createMcpServer(httpTransport(origin, token));
    client = new Client({ name: 'issue23-shape-sdk', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    const tool = (await client.listTools()).tools.find(value => value.name === 'forkwise_read_map');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema).toMatchObject({ type: 'object', properties: {
      view: { enum: expect.arrayContaining(['shape-index', 'shape-detail']) }, shapeId: { type: 'string' },
    } });
    const read = (arguments_: Record<string, unknown>) => client!.callTool({ name: 'forkwise_read_map', arguments: arguments_ });
    const rootResult = await read({ projectId: 'p', view: 'index', budget: 4096 });
    expect(rootResult.isError).not.toBe(true);
    const root = (rootResult.structuredContent as { response: CompactPage }).response;
    run({ type: 'shape.edit', expected: original.versionId, payload: { id, content: { ...content, shortText: '后来的内容' } } });
    run({ type: 'shape.move', expected: original.item.versionId, payload: { id, x: 500, y: 600 } });
    const indexResult = await read({ projectId: 'p', view: 'shape-index', snapshot: root.snapshot, budget: 4096 });
    expect(indexResult.isError).not.toBe(true);
    const index = (indexResult.structuredContent as { response: CompactPage<ShapeIndex> }).response;
    expect(index).toMatchObject({ snapshot: root.snapshot, revision: 2, scope: { types: ['shape'] },
      items: [{ id, versionId: original.versionId, item: original.item, content: { availability: 'not_fetched' } }] });
    expect(index).toEqual(mapping.read({ type: 'map', view: 'shape-index', projectId: 'p', snapshot: root.snapshot, budget: 4096 }, human));
    const detailResult = await read({ projectId: 'p', view: 'shape-detail', shapeId: id, snapshot: root.snapshot, budget: 4096 });
    expect(detailResult.isError).not.toBe(true);
    const detail = (detailResult.structuredContent as { response: CompactPage<DetailChunk> }).response;
    expect(detail).toMatchObject({ snapshot: root.snapshot, revision: 2, fidelity: 'lossless_json_chunks',
      target: { shapeId: id, versionId: original.versionId }, availability: 'available', nextCursor: null });
    expect(JSON.parse(detail.items.map(value => value.jsonText).join(''))).toEqual({ id, versionId: original.versionId, content });
    const response = await fetch(origin + '/api/mapping/projects/p/map?' + new URLSearchParams({ view: 'shape-detail', shapeId: id, snapshot: root.snapshot, budget: '4096' }), { headers: { Authorization: 'Bearer ' + token } });
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(raw)).toEqual(detail);
    expect(Buffer.byteLength(raw, 'utf8')).toBe(detail.bytes);
    for (const page of [index, detail]) {
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
      expect(page.bytes).toBeLessThanOrEqual(4096);
    }
    const forbidden = await read({ projectId: 'q', view: 'shape-index' });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden)).toContain('PROJECT_FORBIDDEN');
    const otherId = await read({ projectId: 'p', view: 'shape-detail', shapeId: 'q-only', snapshot: root.snapshot });
    expect(otherId.isError).not.toBe(true);
    expect((otherId.structuredContent as { response: CompactPage }).response).toMatchObject({ availability: 'not_found', items: [] });
    expect(JSON.stringify(otherId)).not.toContain('不应泄露的另一项目文字');
  } finally {
    await client?.close();
    await server?.close();
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
