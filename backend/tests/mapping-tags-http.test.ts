import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

it('标签和完整关联版本经真实HTTP/MCP同snapshot往返；授权、过期、幂等及Agent undo/noop均守同边界', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-tags-http-'));
  let time = 100;
  const m = openMapping(directory, { compact: { clock: () => time, snapshotTtlMs: 50 } });
  const humanToken = m.access.issue('human', ['*']), human = m.access.authenticate(humanToken);
  const agentToken = m.access.issue('agent', ['p'], undefined, undefined, ['p']), readOnly = m.access.issue('agent', ['p']);
  const expired = m.access.issue('agent', ['p'], -1);
  const run = (type: string, payload: object, expected: unknown = null, projectId = 'p') => m.execute({ commandId: crypto.randomUUID(), projectId, type, expected, payload }, human);
  let app: ReturnType<typeof createWorkspaceApp>;
  const http = serve({ hostname: '127.0.0.1', port: 0, fetch: r => app.fetch(r) });
  await new Promise<void>(resolve => http.once('listening', resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  app = createWorkspaceApp(m, origin, () => new Response(''));
  const mcp = createMcpServer(httpTransport(origin, agentToken)), client = new Client({ name: 'issue18-tags', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(b); await client.connect(a);
  const get = (path: string, token = agentToken) => fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } });
  const post = (command: object, token = agentToken) => fetch(origin + '/api/mapping/execute', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  const state = () => m.read({ type: 'project', projectId: 'p' }, human);
  try {
    run('project.create', { name: '项目' }); run('project.create', { name: '其他项目' }, null, 'q');
    run('thought.create', { id: 'c', title: '完整标题', text: '完整正文：中文🧭\n第二行', x: 10, y: 20 });
    run('tag.create', { id: 't', name: 'AI' }); run('card.tags', { id: 'c', tagIds: ['t'] });
    const first = state(), tag = first.tags![0]!, card = first.cards[0]!;
    const tagVersion = await get(`/api/mapping/projects/p/versions/tag/t/${tag.versionId}`);
    expect(tagVersion.status).toBe(200); expect(await tagVersion.json()).toEqual(tag);
    expect(await (await get(`/api/mapping/projects/p/versions/cardTags/cardTags:c/${card.cardTags!.versionId}`)).json()).toEqual(card.cardTags);
    const index = await (await get('/api/mapping/projects/p/map?view=index')).json();
    const tags = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view: 'tags', snapshot: index.snapshot } });
    expect(tags.isError).not.toBe(true); const tagPage = (tags.structuredContent as any).response;
    expect(tagPage.items).toEqual(first.tags); expect(tagPage.revision).toBe(index.revision);
    const agentIndex = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view: 'index', snapshot: index.snapshot } });
    expect((agentIndex.structuredContent as any).response).toEqual(index);
    expect(index.items[0].cardTags).toEqual(card.cardTags);
    let cursor: string | undefined, json = '';
    do {
      const response = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view: 'detail', cardId: 'c', snapshot: index.snapshot, ...(cursor ? { cursor } : {}) } });
      expect(response.isError).not.toBe(true); const page = (response.structuredContent as any).response;
      expect(page.revision).toBe(index.revision); json += page.items.map((c: any) => c.jsonText).join(''); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(JSON.parse(json)).toEqual(card.body);
    const command = { commandId: 'tag-http-edit', projectId: 'p', type: 'tag.update', expected: tag.versionId, payload: { id: 't', name: 'Ai', color: '#d9e7f1' } };
    expect((await post(command, readOnly)).status).toBe(403);
    const response = await client.callTool({ name: 'forkwise_execute_tag_command', arguments: { command } });
    expect(response.isError).not.toBe(true); const receipt = (response.structuredContent as any).response;
    expect(receipt.revision).toBe(first.project.revision + 1);
    expect(await (await post(command)).json()).toEqual(receipt);
    expect((await post({ ...command, payload: { ...command.payload, name: 'Other' } })).status).toBe(409);
    expect((await post({ ...command, commandId: 'stale' })).status).toBe(409);
    expect((await post({ ...command, commandId: 'actor-spoof', actor: { id: 'local-owner', type: 'human' } })).status).toBe(400);
    expect((await post({ ...command, commandId: 'cross-project', projectId: 'q' })).status).toBe(403);
    expect((await get('/api/mapping/projects/q/map?view=tags')).status).toBe(403);
    expect((await get('/api/mapping/projects/p/map?view=tags', expired)).status).toBe(401);
    const updated = state(), currentTag = updated.tags![0]!;
    const noop = { ...command, commandId: 'noop', expected: currentTag.versionId };
    expect((await post(noop, readOnly)).status).toBe(403);
    expect((await post(noop)).status).toBe(200); expect(state()).toEqual(updated);
    expect((await post({ commandId: 'agent-undo', projectId: 'p', type: 'history.undo', expected: updated.project.revision, payload: {} })).status).toBe(403);
    const principal = m.access.authenticate(agentToken);
    expect(() => m.execute(noop, { ...principal, actor: human.actor })).toThrow(/可信会话/);
    time = 151;
    expect((await get(`/api/mapping/projects/p/map?view=tags&snapshot=${index.snapshot}`)).status).toBe(409);
    m.access.revoke(principal.tokenHash);
    expect((await post(command)).status).toBe(401); expect(state()).toEqual(updated);
    const beforeReopen = state(); m.close();
    const reopened = openMapping(directory);
    try { expect(reopened.read({ type: 'project', projectId: 'p' }, reopened.access.authenticate(humanToken))).toEqual(beforeReopen); }
    finally { reopened.close(); }
  } finally {
    await client.close(); await mcp.close(); if ('closeAllConnections' in http) http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    try { m.close(); } catch { /* The successful reopen path already closed it. */ }
  }
});
