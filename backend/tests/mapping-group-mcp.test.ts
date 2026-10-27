import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { groupFixture, closeGroupFixtures } from './group-fixture.js';
import { groupHttp, protocolResource } from './group-protocol-fixture.js';
import type { CompactPage } from '../src/mapping/compact-contracts.js';
afterEach(closeGroupFixtures);

it('MCP SDK内存传输经真实本机HTTP读取Group归属固定快照，明确九视图和项目权限', async () => {
  const f = groupFixture(), a = f.card(), b = f.shape(), group = f.group([a.item.id, b.item.id]);
  expect(f.state().groups![0]!.memberItemIds).toEqual([a.item.id, b.item.id]);
  const http = groupHttp(f); let server: ReturnType<typeof createMcpServer> | undefined, client: Client | undefined;
  try {
    await http.start();
    const token = f.mapping.access.issue('agent', ['p']);
    server = createMcpServer(httpTransport(http.origin, token)); client = new Client({ name: 'issue28-group-read', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
    const read = async (args: Record<string, unknown>) => {
      const result = await client!.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', ...args } });
      expect(result.isError).not.toBe(true); return (result.structuredContent as { response: CompactPage }).response;
    };
    const root = await read({ view: 'index' }); expect(root.revision).toBe(f.state().project.revision);
    const groups = await read({ view: 'group-index', snapshot: root.snapshot });
    const membership = await read({ view: 'containment', snapshot: root.snapshot });
    expect(groups).toMatchObject({ revision: root.revision, snapshot: root.snapshot, items: [{ id: group.id, memberCount: 2 }] });
    expect(membership.items).toEqual(f.state().containment);
    f.execute({ type: 'group.remove-member', expected: { group: group.versionId, containment: f.structure().containment[a.item.id] }, payload: { id: group.id, itemId: a.item.id } });
    expect(await read({ view: 'group-index', snapshot: root.snapshot })).toEqual(groups);
    expect(await read({ view: 'containment', snapshot: root.snapshot })).toEqual(membership);
    const tools = (await client.listTools()).tools;
    for (const name of ['forkwise_read_map', 'forkwise_observe_map']) {
      const tool = tools.find(t => t.name === name)!;
      expect(tool.description).toContain('九个视图'); expect(tool.description).toContain('group-index'); expect(tool.description).toContain('containment');
    }
    const forbidden = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'q', view: 'containment' } });
    expect(forbidden.isError).toBe(true); expect(JSON.stringify(forbidden)).toContain('PROJECT_FORBIDDEN');
    const invalid = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view: 'anything' } });
    expect(invalid.isError).toBe(true);
  } finally {
    if (client) { await client.close(); protocolResource('group-mcp-client-closed'); }
    if (server) { await server.close(); protocolResource('group-mcp-server-closed'); }
    await http.close();
  }
});
