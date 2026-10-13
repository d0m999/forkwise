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

it('只读 MCP observe 经真实 HTTP 复用固定变化批次，拒绝越项目及已撤销授权', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-observe-mcp-'));
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
      payload: { name: '地图' },
    },
    human,
  );
  for (const id of ['a', 'b'])
    mapping.execute(
      {
        commandId: id,
        projectId: 'p',
        type: 'thought.create',
        expected: null,
        payload: { id, title: id, text: '正文', x: 0, y: 0 },
      },
      human,
    );
  const token = mapping.access.issue('agent', ['p']);
  const server = createMcpServer(httpTransport(origin, token));
  const client = new Client({ name: 'observe-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'forkwise_observe_map');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const call = (args: Record<string, unknown>) =>
      client.callTool({ name: 'forkwise_observe_map', arguments: args });
    const result = await call({ projectId: 'p', afterRevision: 1, limit: 1, budget: 4096 });
    expect(result.isError).not.toBe(true);
    const page = (result.structuredContent as any).response;
    expect(page).toMatchObject({ revision: 3, nextRevision: 2, complete: false });
    const response = await fetch(
      origin +
        '/api/mapping/projects/p/changes?' +
        new URLSearchParams({ after: '1', limit: '1', budget: '4096', snapshot: page.snapshot }),
      { headers: { Authorization: 'Bearer ' + token } },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(raw)).toEqual(page);
    expect(Buffer.byteLength(raw)).toBe(page.bytes);
    const small = await fetch(origin + '/api/mapping/projects/p/changes?after=1&budget=1', {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(small.status).toBe(413);
    expect(await small.json()).toMatchObject({
      code: 'BUDGET_TOO_SMALL',
      details: { recovery: { view: 'index' } },
    });
    expect((await call({ projectId: 'other', afterRevision: 0 })).isError).toBe(true);
    mapping.access.revoke(mapping.access.authenticate(token).tokenHash);
    const revoked = await call({ projectId: 'p', afterRevision: 2, snapshot: page.snapshot });
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
