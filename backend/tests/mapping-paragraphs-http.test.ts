import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CompactPage, DetailChunk } from '../src/mapping/compact-contracts.js';

it('段落完整Body经实际HTTP保存，HTTP与MCP固定同snapshot往返且撤权拒绝原请求和旧快照', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-paragraph-http-'));
  let host: ReturnType<typeof openMapping> | undefined, http: ReturnType<typeof serve> | undefined;
  let client: Client | undefined, mcp: ReturnType<typeof createMcpServer> | undefined;
  try {
    host = openMapping(directory);
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) => host!.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    run({ type: 'project.create', expected: null, payload: { name: '段落HTTP' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'a', title: '原卡', text: '完整旧原文', x: 10, y: 20 } });
    const original = host.read({ type: 'project', projectId: 'p' }, human).cards[0]!;
    let app: ReturnType<typeof createWorkspaceApp>;
    http = serve({ hostname: '127.0.0.1', port: 0, fetch: r => app.fetch(r) });
    await new Promise<void>(resolve => http!.once('listening', resolve));
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    app = createWorkspaceApp(host, origin, () => new Response(''));
    const token = host.access.issue('agent', ['p'], undefined, undefined, ['p']);
    const readOnly = host.access.issue('agent', ['p']);
    const blocks = [{ ...original.body.blocks[0]!, inlineId: 'http-inline', text: '完整中文🚀\n软换行' }, { id: 'http-second', type: 'text', inlineId: 'http-second-inline', text: '第二段完整原文' }, { id: 'http-empty', type: 'text', inlineId: 'http-empty-inline', text: '' }];
    const command = { commandId: 'http-original', projectId: 'p', type: 'body.edit', expected: original.body.versionId, payload: { id: 'a', blocks } };
    const post = (c: unknown, credential = token) => fetch(origin + '/api/mapping/execute', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
    expect((await post(command, readOnly)).status).toBe(403);
    const saved = await post(command); expect(saved.status).toBe(200);
    const receipt = await saved.json();
    mcp = createMcpServer(httpTransport(origin, token)); client = new Client({ name: 'paragraph-sdk', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await mcp.connect(b); await client.connect(a);
    const index = host.read({ type: 'map', projectId: 'p', view: 'index' }, human);
    const detail = await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view: 'detail', cardId: 'a', snapshot: index.snapshot } });
    expect(detail.isError).not.toBe(true);
    const body = (detail.structuredContent as unknown as { response: CompactPage<DetailChunk> }).response;
    const actual = JSON.parse(body.items.map(c => c.jsonText).join(''));
    expect(actual.blocks).toEqual(blocks); expect(body.revision).toBe(index.revision);
    const response = await fetch(origin + `/api/mapping/projects/p/map?view=detail&cardId=a&snapshot=${index.snapshot}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await response.json()).toEqual(body);
    expect(await (await post(command)).json()).toEqual(receipt);
    expect((await post({ ...command, commandId: 'agent-undo', type: 'history.undo', expected: index.revision, payload: { actionId: command.commandId } })).status).toBe(403);
    host.access.revoke(host.access.authenticate(token).tokenHash);
    expect((await post(command)).status).toBe(401);
    expect((await client.callTool({ name: 'forkwise_read_map', arguments: { projectId: 'p', view: 'detail', cardId: 'a', snapshot: index.snapshot } })).isError).toBe(true);
  } finally {
    try { await client?.close(); } finally { try { await mcp?.close(); } finally {
      try { if (http) await new Promise<void>((resolve, reject) => { http!.close(e => e ? reject(e) : resolve()); if ('closeAllConnections' in http!) http!.closeAllConnections(); }); }
      finally { host?.close(); rmSync(directory, { recursive: true, force: true }); }
    } }
  }
});
