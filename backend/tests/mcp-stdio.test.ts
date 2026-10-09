import { it, expect } from 'vitest';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApplication } from '../src/app.js';

it('独立 MCP 子进程通过 stdio 与真实本机 HTTP 往返，保持项目隔离和人工确认边界', async () => {
  // Origin is resolved after the OS allocates an ephemeral loopback port.
  let app: ReturnType<typeof createApplication>;
  const listener = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => app.app.fetch(request),
  });
  await new Promise<void>((r) => (listener.listening ? r() : listener.once('listening', r)));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const origin = `http://127.0.0.1:${address.port}`;
  app = createApplication({ database: ':memory:', origin });
  const project = app.write.createProject({ id: 'owner', type: 'human' }, 'stdio-project', {
    name: '协议隔离测试',
  });
  const token = app.access.issue('agent', [project.id]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', FORKWISE_URL: origin, FORKWISE_AGENT_TOKEN: token },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-validation', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('forkwise_save_layout');
    const result = await client.callTool({
      name: 'forkwise_read_project',
      arguments: { projectId: project.id },
    });
    expect(result.isError).not.toBe(true);
    const forbidden = await client.callTool({
      name: 'forkwise_read_project',
      arguments: { projectId: 'private-project' },
    });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden)).toContain('PROJECT_FORBIDDEN');
  } finally {
    await client.close();
    await new Promise<void>((r) => listener.close(() => r()));
    app.db.close();
  }
}, 15_000);
