import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
it('真实HTTP和MCP可读取同一不可变原件，项目越权/撤权拒绝，SVG下载有独立沙箱', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-http-')),
    host = openMapping(directory);
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = createWorkspaceApp(host, origin, () => new Response(''));
  const token = host.access.issue('human', ['*']),
    human = host.access.authenticate(token);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><text x="0" y="8">不索引SVG内文字</text></svg>',
  ).toString('base64');
  const agentToken = host.access.issue('agent', ['p']),
    wrongToken = host.access.issue('agent', ['other']);
  const mcp = createMcpServer(httpTransport(origin, agentToken)),
    wrongMcp = createMcpServer(httpTransport(origin, wrongToken));
  const client = new Client({ name: 'media-allowed', version: '1' }),
    wrongClient = new Client({ name: 'media-denied', version: '1' });
  try {
    host.execute(
      {
        commandId: 'p',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: '权限' },
      },
      human,
    );
    host.execute(
      {
        commandId: 'asset',
        projectId: 'p',
        type: 'asset.save',
        expected: null,
        payload: { id: 'asset', name: '原件.svg', mime: 'image/svg+xml', base64: svg },
      },
      human,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    await client.connect(a);
    const [c, d] = InMemoryTransport.createLinkedPair();
    await wrongMcp.connect(d);
    await wrongClient.connect(c);
    const result = await client.callTool({
      name: 'forkwise_read_asset',
      arguments: { projectId: 'p', id: 'asset' },
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as any).response).toMatchObject({
      id: 'asset',
      base64: svg,
      width: 20,
      height: 10,
    });
    const response = await fetch(`${origin}/api/mapping/projects/p/assets/asset/content`, {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'; sandbox",
    );
    expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(svg);
    expect(
      (
        await fetch(`${origin}/api/mapping/projects/p/assets/asset`, {
          headers: { Authorization: `Bearer ${wrongToken}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await wrongClient.callTool({
          name: 'forkwise_read_asset',
          arguments: { projectId: 'p', id: 'asset' },
        })
      ).isError,
    ).toBe(true);
    host.access.revoke(host.access.authenticate(agentToken).tokenHash);
    expect(
      (
        await client.callTool({
          name: 'forkwise_read_asset',
          arguments: { projectId: 'p', id: 'asset' },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await mcp.close();
    await wrongClient.close();
    await wrongMcp.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
