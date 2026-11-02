import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { groupFixture, closeGroupFixtures } from './group-fixture.js';
import { groupHttp, protocolResource } from './group-protocol-fixture.js';
import { captureContainerEndpoints } from '../src/mapping/container-endpoints.js';
import type { CompactPage, ConnectorIndex, DetailChunk } from '../src/mapping/compact-contracts.js';
import type { ObservePage } from '../src/mapping/observe-contracts.js';

afterEach(closeGroupFixtures);

it('真实HTTP创建和解组与只读MCP compact/detail/observe同revision，端点保留类型和冻结事实', async () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), group = f.group([a.item.id, b.item.id]);
  const http = groupHttp(f), human = f.mapping.access.issue('human', ['p']), agent = f.mapping.access.issue('agent', ['p']);
  let server: ReturnType<typeof createMcpServer> | undefined, client: Client | undefined;
  try {
    await http.start();
    const execute = (command: Record<string, unknown>) => fetch(http.origin + '/api/mapping/execute', { method: 'POST',
      headers: { Origin: http.origin, Authorization: `Bearer ${human}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: crypto.randomUUID(), projectId: 'p', ...command }) });
    const created = await execute({ type: 'connector.create', expected: null, payload: { id: 'wire', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'free', point: { x: 900, y: 50 } } } });
    expect(created.status).toBe(200);
    const line = f.state().connectors![0]!, fullResponse = await http.get('/api/mapping/projects/p', human);
    expect(fullResponse.status).toBe(200); expect(await fullResponse.json()).toEqual(JSON.parse(JSON.stringify(f.state())));
    server = createMcpServer(httpTransport(http.origin, agent)); client = new Client({ name: 'issue30-container-read', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
    const tools = (await client.listTools()).tools;
    for (const name of ['forkwise_read_map', 'forkwise_observe_map'])
      expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    expect(tools.some(tool => tool.name === 'forkwise_execute_connector_command')).toBe(false);
    expect(tools.filter(tool => /connector|group|frame|container/.test(tool.name) && !tool.annotations?.readOnlyHint)).toEqual([]);
    const read = async (args: Record<string, unknown>) => {
      const response = await client!.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', budget: 65536, ...args } });
      expect(response.isError).not.toBe(true); return (response.structuredContent as { response: CompactPage }).response;
    };
    const root = await read({ view: 'index' });
    const index = await read({ view: 'connector-index', snapshot: root.snapshot }) as CompactPage<ConnectorIndex>;
    const detail = await read({ view: 'connector-detail', connectorId: line.id, snapshot: root.snapshot }) as CompactPage<DetailChunk>;
    expect(root.revision).toBe(f.state().project.revision);
    expect(index.revision).toBe(root.revision); expect(detail.revision).toBe(root.revision);
    expect(index.items[0]).toMatchObject({ start: line.start, end: line.end, versionId: line.versionId });
    expect(JSON.parse(detail.items.map(chunk => chunk.jsonText).join(''))).toEqual(line);
    const wireDetail = await http.get('/api/mapping/projects/p/map?' + new URLSearchParams({ view: 'connector-detail', connectorId: line.id, snapshot: root.snapshot, budget: '65536' }), agent);
    expect(wireDetail.status).toBe(200); expect(await wireDetail.json()).toEqual(detail);
    const removed = await execute({ type: 'group.ungroup', expected: { ...f.structure(), endpoints: captureContainerEndpoints(f.state(), [`group:${group.itemId}`]) }, payload: { id: group.id } });
    expect(removed.status).toBe(200); expect((await removed.json()).deletedIds).not.toContain(line.id);
    const fresh = await read({ view: 'connector-index' }) as CompactPage<ConnectorIndex>;
    expect(fresh.revision).toBe(root.revision + 1);
    expect(fresh.items[0]!.start).toEqual({ kind: 'free', point: { x: 410, y: 50 } });
    const observed = await client.callTool({ name: 'forkwise_observe_map', arguments: {
      projectId: 'p', afterRevision: root.revision, baseSnapshot: root.snapshot, budget: 65536,
    } });
    expect(observed.isError).not.toBe(true);
    const changes = (observed.structuredContent as { response: ObservePage }).response;
    expect(changes).toMatchObject({ status: 'OK', afterRevision: root.revision,
      revision: root.revision + 1, nextRevision: root.revision + 1, complete: true });
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]!.revision).toBe(fresh.revision);
    expect(changes.changes[0]!.domains).toEqual(expect.arrayContaining([
      { domain: 'group', id: group.id }, { domain: 'connector', id: line.id },
    ]));
    expect(changes.changes[0]!.connectorChanges).toEqual([{ before: line,
      after: expect.objectContaining({ id: line.id, start: { kind: 'free', point: { x: 410, y: 50 } }, end: line.end }),
    }]);
    expect(await read({ view: 'connector-detail', connectorId: line.id, snapshot: root.snapshot })).toEqual(detail);
    const forbidden = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'q', view: 'connector-index' } });
    expect(forbidden.isError).toBe(true);
  } finally {
    if (client) { await client.close(); protocolResource('group-mcp-client-closed'); }
    if (server) { await server.close(); protocolResource('group-mcp-server-closed'); }
    await http.close();
  }
});
