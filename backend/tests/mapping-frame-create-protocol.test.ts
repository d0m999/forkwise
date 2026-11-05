import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';
import { groupHttp } from './group-protocol-fixture.js';
import { captureSpatial, frameDrawMembers } from '../src/mapping/frame-spatial.js';
import { createFrameCommand } from './nested-frame-fixture.js';

afterEach(closeGroupFixtures);
it('绘制分区的公共seam拒绝漏收root并无半写，显式空选区不会吸入旁项', () => {
  const f = groupFixture(), shape = f.shape(), state = f.state(), history = f.history();
  const pose = { x: 0, y: 0, width: 400, height: 400 };
  const omitted = createFrameCommand(state, [], pose);
  expect(() => f.execute(omitted)).toThrowError(expect.objectContaining({ code: 'EXPECTED_DOMAINS' }));
  expect(f.state()).toEqual(state); expect(f.history()).toEqual(history);
  const selectedEmpty = { ...omitted, payload: { ...omitted.payload, parentId: null }, placement: { expected: captureSpatial(state, { itemIds: [] }) } };
  f.execute(selectedEmpty);
  expect(f.state().frames![0]!.memberItemIds).toEqual([]);
  expect(f.state().containment!.some(v => v.id === shape.item.id)).toBe(false);
});

it('真实HTTP拒绝漏收绘制命令，合法完整plan由只读MCP同revision读回', async () => {
  const f = groupFixture(), shape = f.shape(), state = f.state(), http = groupHttp(f);
  const human = f.mapping.access.issue('human', ['p']), agent = f.mapping.access.issue('agent', ['p']);
  let server: ReturnType<typeof createMcpServer> | undefined, client: Client | undefined;
  try {
    await http.start();
    const execute = (command: unknown) => fetch(http.origin + '/api/mapping/execute', { method: 'POST',
      headers: { Origin: http.origin, Authorization: `Bearer ${human}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    const pose = { x: 0, y: 0, width: 400, height: 400 };
    const bad = await execute(createFrameCommand(state, [], pose));
    expect(bad.status).toBe(400); expect(await bad.json()).toMatchObject({ code: 'EXPECTED_DOMAINS' }); expect(f.state()).toEqual(state);
    const complete = createFrameCommand(state, frameDrawMembers(state, pose), pose), good = await execute(complete);
    expect(good.status).toBe(200); const receipt = await good.json() as { revision: number };
    server = createMcpServer(httpTransport(http.origin, agent)); client = new Client({ name: 'issue43-frame-plan-read', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
    const read = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view: 'frame-index' } });
    expect(read.isError).not.toBe(true);
    expect((read.structuredContent as { response: unknown }).response).toMatchObject({ revision: receipt.revision,
      items: [{ id: complete.payload.id, memberCount: 1 }] });
    expect(f.state().containment!.find(v => v.id === shape.item.id)?.parent).toEqual({ kind: 'frame', id: complete.payload.id });
    expect((await client.listTools()).tools.filter(v => /frame/.test(v.name) && !v.annotations?.readOnlyHint)).toEqual([]);
  } finally { if (client) await client.close(); if (server) await server.close(); await http.close(); }
});

it.each(['canvas.duplicate', 'canvas.paste'] as const)('%s的归属历史经真实HTTP和只读MCP往返保持无悬挂边', async type => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: 0, y: 0, width: 800, height: 600 }));
  const shape = f.shape(), http = groupHttp(f), human = f.mapping.access.issue('human', ['p']), agent = f.mapping.access.issue('agent', ['p']);
  let server: ReturnType<typeof createMcpServer> | undefined, client: Client | undefined;
  try {
    await http.start();
    const execute = async (command: unknown) => {
      const response = await fetch(http.origin + '/api/mapping/execute', { method: 'POST', headers: { Origin: http.origin, Authorization: `Bearer ${human}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      expect(response.status).toBe(200); return response.json();
    };
    const command = type === 'canvas.duplicate' ? { type, expected: { cards: {}, texts: {}, shapes: { [shape.id]: { content: shape.versionId, pose: shape.item.versionId } }, images: {}, strokes: {}, connectors: {}, anchors: {} },
      payload: { objects: [{ kind: 'shape', id: shape.id, copyId: 'copy' }], connectors: [] } }
      : { type, expected: null, payload: { translation: { x: 24, y: 24 }, connectors: [], objects: [{ kind: 'shape', copyId: 'copy', stack: 1, content: shape.content, pose: shape.item.pose }] } };
    await execute({ commandId: type, projectId: 'p', ...command });
    const copy = f.state().shapes!.find(v => v.id === 'copy')!;
    server = createMcpServer(httpTransport(http.origin, agent)); client = new Client({ name: 'issue43-history-read', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
    for (const direction of ['history.undo', 'history.redo'] as const) {
      await execute({ commandId: direction, projectId: 'p', type: direction, expected: f.state().project.revision, payload: {} });
      const expected = f.state();
      for (const view of ['frame-index', 'group-index', 'containment', 'shape-index'] as const) {
        const response = await http.get('/api/mapping/projects/p/map?view=' + view, human); expect(response.status).toBe(200);
        const value = await response.json() as { revision: number; items: { id: string }[] };
        const read = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view } });
        expect(read.isError).not.toBe(true); expect((read.structuredContent as { response: unknown }).response).toMatchObject({ revision: expected.project.revision, items: value.items });
        if (view === 'containment') expect(value.items.some(v => v.id === copy.item.id)).toBe(direction === 'history.redo');
      }
    }
    const final = f.state(); f.reopen(); expect(f.state()).toEqual(final);
  } finally { if (client) await client.close(); if (server) await server.close(); await http.close(); }
});
