import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { connectorTransport, resource } from './connector-transport-fixture.js';
import type { CompactPage, DetailChunk, ConnectorIndex } from '../src/mapping/compact-contracts.js';
import type { ObservePage } from '../src/mapping/observe-contracts.js';

it('真实MCP与HTTP只读普通连线固定视图并保持项目和撤销授权边界', async () => {
  const f = lifecycleFixture(), http = connectorTransport(f);
  let server: ReturnType<typeof createMcpServer> | undefined, client: Client | undefined;
  try {
    const a = f.card('a'), b = f.card('b');
    const original = f.connector('线/特殊? #🧠', f.bound(a.item.id), f.bound(b.item.id, 'left'));
    f.run({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '未授权项目' } });
    f.run({ projectId: 'q', type: 'connector.create', expected: null, payload: { id: 'q-secret', start: f.free(1, 2), end: f.free(3, 4) } });
    await http.start();
    const token = f.mapping.access.issue('agent', ['p']);
    server = createMcpServer(httpTransport(http.origin, token)); client = new Client({ name: 'issue26-connectors', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
    const tools = (await client.listTools()).tools;
    const readTool = tools.find(tool => tool.name === 'forkwise_read_map'), observeTool = tools.find(tool => tool.name === 'forkwise_observe_map');
    expect(readTool?.annotations?.readOnlyHint).toBe(true); expect(observeTool?.annotations?.readOnlyHint).toBe(true);
    expect(readTool?.inputSchema).toMatchObject({ properties: { view: { enum: expect.arrayContaining(['connector-index', 'connector-detail']) }, connectorId: { type: 'string' } } });
    for (const tool of [readTool, observeTool]) expect(tool?.description).toContain('connector-index');
    expect(tools.some(tool => tool.name === 'forkwise_execute_connector_command')).toBe(false);
    const call = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: { projectId: 'p', ...args } });
    const read = async (args: Record<string, unknown>) => { const result = await call('forkwise_read_map', args); expect(result.isError).not.toBe(true); return (result.structuredContent as { response: CompactPage }).response; };
    const root = await read({ view: 'index', budget: 4096 });
    f.run({ type: 'connector.path', expected: original.versionId, payload: { id: original.id, path: 'curve' } });
    const index = await read({ view: 'connector-index', snapshot: root.snapshot, budget: 4096 }) as CompactPage<ConnectorIndex>;
    expect(index).toMatchObject({ snapshot: root.snapshot, revision: root.revision, items: [{ id: original.id, path: 'straight', start: original.start, end: original.end }] });
    const detail = await read({ view: 'connector-detail', connectorId: original.id, snapshot: root.snapshot, budget: 4096 }) as CompactPage<DetailChunk>;
    expect(JSON.parse(detail.items.map(value => value.jsonText).join(''))).toEqual(original);
    const response = await http.get('/api/mapping/projects/p/map?' + new URLSearchParams({ view: 'connector-detail', connectorId: original.id, snapshot: root.snapshot, budget: '4096' }), token);
    const raw = await response.text(); expect(response.status).toBe(200); expect(JSON.parse(raw)).toEqual(detail); expect(Buffer.byteLength(raw)).toBe(detail.bytes);
    for (const page of [index, detail]) { expect(Buffer.byteLength(JSON.stringify(page))).toBe(page.bytes); expect(page.bytes).toBeLessThanOrEqual(4096); }
    const observed = await call('forkwise_observe_map', { afterRevision: root.revision, baseSnapshot: root.snapshot, budget: 8192 });
    expect(observed.isError).not.toBe(true); const changes = (observed.structuredContent as { response: ObservePage }).response;
    expect(changes.changes[0]!.domains).toEqual([{ domain: 'connector', id: original.id }]);
    const missingSnapshot = await call('forkwise_read_map', { view: 'connector-detail', connectorId: original.id });
    expect(missingSnapshot.isError).toBe(true); expect(JSON.stringify(missingSnapshot)).toContain('INVALID_QUERY');
    const forbidden = await call('forkwise_read_map', { projectId: 'q', view: 'connector-index' }); expect(forbidden.isError).toBe(true); expect(JSON.stringify(forbidden)).toContain('PROJECT_FORBIDDEN');
    const foreign = await read({ view: 'connector-detail', connectorId: 'q-secret', snapshot: root.snapshot }); expect(foreign.availability).toBe('not_found'); expect(foreign.items).toEqual([]);
    expect((await http.get(`/api/mapping/projects/q/versions/connector/q-secret/anything`, token)).status).toBe(403);
    const state = f.state(), history = f.history();
    const write = await fetch(http.origin + '/api/mapping/execute', { method: 'POST', headers: { Origin: http.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: 'forbidden-write', projectId: 'p', type: 'connector.create', expected: null, payload: { id: 'not-created', start: f.free(0, 0), end: f.free(1, 1) } }) });
    expect(write.status).toBe(403); expect(await write.json()).toMatchObject({ code: 'EDIT_DELEGATION_REQUIRED' }); expect(f.state()).toEqual(state); expect(f.history()).toEqual(history);
    f.mapping.access.revoke(f.mapping.access.authenticate(token).tokenHash);
    const revoked = await call('forkwise_read_map', { view: 'connector-detail', connectorId: original.id, snapshot: root.snapshot }); expect(revoked.isError).toBe(true); expect(JSON.stringify(revoked)).toContain('UNAUTHORIZED');
    expect((await http.get(`/api/mapping/projects/p/versions/connector/${encodeURIComponent(original.id)}/${original.versionId}`, token)).status).toBe(401);
  } finally {
    if (client) { await client.close(); resource('sdk-client-closed', { kind: 'mcp-client' }); }
    if (server) { await server.close(); resource('sdk-server-closed', { kind: 'mcp-server' }); }
    await http.close(); f.close();
  }
});
