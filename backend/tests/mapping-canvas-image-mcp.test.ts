import { expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { imageFixture } from './canvas-image-fixture.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import type { CompactPage, DetailChunk, ImageIndex } from '../src/mapping/compact-contracts.js';

it('真实MCP与HTTP按同snapshot完整读取Image，资源和项目授权边界保持', async () => {
  const f = imageFixture();
  let http: ReturnType<typeof serve> | undefined, mcp: ReturnType<typeof createMcpServer> | undefined, client: Client | undefined;
  try {
    f.create('picture/特殊? #1', { x: 0.25, y: 0.125, width: 0.5, height: 0.5 });
    const original = f.read(), image = original.images![0]!;
    f.run({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '未授权项目' } });
    let app: ReturnType<typeof createWorkspaceApp>;
    http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => { http!.once('listening', resolve); http!.once('error', reject); });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    app = createWorkspaceApp(f.host, origin, () => new Response(''));
    const token = f.host.access.issue('agent', ['p']);
    mcp = createMcpServer(httpTransport(origin, token)); client = new Client({ name: 'issue24-image', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await mcp.connect(right); await client.connect(left);
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'forkwise_read_map');
    expect(tool?.inputSchema).toMatchObject({ properties: { view: { enum: expect.arrayContaining(['image-index', 'image-detail']) }, imageId: { type: 'string' } } });
    const read = (args: Record<string, unknown>) => client!.callTool({ name: 'forkwise_read_map', arguments: args });
    const rootResult = await read({ projectId: 'p', view: 'index', budget: 4096 });
    expect(rootResult.isError).not.toBe(true);
    const root = (rootResult.structuredContent as { response: CompactPage }).response;
    f.run({ type: 'image.rotate', expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, direction: 'right' } });
    const indexResult = await read({ projectId: 'p', view: 'image-index', snapshot: root.snapshot, budget: 4096 });
    expect(indexResult.isError).not.toBe(true);
    const index = (indexResult.structuredContent as { response: CompactPage<ImageIndex> }).response;
    expect(index).toMatchObject({ snapshot: root.snapshot, revision: original.project.revision, items: [{ id: image.id, item: image.item }] });
    const detailResult = await read({ projectId: 'p', view: 'image-detail', imageId: image.id, snapshot: root.snapshot, budget: 4096 });
    expect(detailResult.isError).not.toBe(true);
    const detail = (detailResult.structuredContent as { response: CompactPage<DetailChunk> }).response;
    expect(JSON.parse(detail.items.map(chunk => chunk.jsonText).join(''))).toEqual({ id: image.id, versionId: image.versionId, content: image.content });
    const response = await fetch(origin + '/api/mapping/projects/p/map?' + new URLSearchParams({ view: 'image-detail', imageId: image.id, snapshot: root.snapshot, budget: '4096' }), { headers: { Authorization: 'Bearer ' + token } });
    const raw = await response.text(); expect(response.status).toBe(200); expect(JSON.parse(raw)).toEqual(detail);
    expect(Buffer.byteLength(raw)).toBe(detail.bytes); expect(detail.bytes).toBeLessThanOrEqual(4096);
    const asset = await client.callTool({ name: 'forkwise_read_asset', arguments: { projectId: 'p', id: image.content.assetId } });
    expect((asset.structuredContent as { response: { base64: string } }).response.base64).toBe(f.base64);
    const forbidden = await read({ projectId: 'q', view: 'image-index' }); expect(forbidden.isError).toBe(true); expect(JSON.stringify(forbidden)).toContain('PROJECT_FORBIDDEN');
    f.host.access.revoke(f.host.access.authenticate(token).tokenHash);
    expect((await read({ projectId: 'p', view: 'image-index' })).isError).toBe(true);
  } finally {
    await client?.close(); await mcp?.close();
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    f.close();
  }
});
