import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';

it('真实 MCP SDK 经本机 HTTP 读取 Mapping 快照，撤销项目授权后不能继续展开', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-compact-mcp-'));
  const mapping = openMapping(directory);
  let app: ReturnType<typeof createWorkspaceApp>;
  const http = serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => app.fetch(r) });
  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve);
    http.once('error', reject);
  });
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  mapping.execute(
    {
      commandId: 'p',
      projectId: 'p',
      type: 'project.create',
      expected: null,
      payload: { name: 'MCP' },
    },
    human,
  );
  mapping.execute(
    {
      commandId: 'c',
      projectId: 'p',
      type: 'thought.create',
      expected: null,
      payload: { id: 'c', title: '身份', text: '正文', x: 0, y: 0 },
    },
    human,
  );
  const token = mapping.access.issue('agent', ['p']);
  const server = createMcpServer(httpTransport(origin, token));
  const client = new Client({ name: 'compact-map-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const read = (args: Record<string, unknown>) =>
      client.callTool({ name: 'forkwise_read_map', arguments: args });
    const result = await read({ projectId: 'p', view: 'index', budget: 4096 });
    expect(result.isError).not.toBe(true);
    const index = (result.structuredContent as { response: { snapshot: string } }).response;
    expect(index).toEqual(
      mapping.read(
        { type: 'map', view: 'index', projectId: 'p', snapshot: index.snapshot, budget: 4096 },
        human,
      ),
    );
    expect((await read({ projectId: 'other', view: 'index' })).isError).toBe(true);
    mapping.access.revoke(mapping.access.authenticate(token).tokenHash);
    const revoked = await read({
      projectId: 'p',
      view: 'detail',
      cardId: 'c',
      snapshot: index.snapshot,
    });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).toContain('UNAUTHORIZED');
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
