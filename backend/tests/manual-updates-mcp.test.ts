import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { manualUpdateFixture as fixture } from './fixtures/manual-update.js';
it('MCP 通过相同受保护 HTTP 契约预览和提交更新，不能借此改变个人判断', async () => {
  const f = fixture();
  const { createMcpServer } = await import('../src/mcp-server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const token = f.app.access.issue('agent', [f.project.id]);
  const server = createMcpServer({
    async call(path, method = 'GET', body, key) {
      const r = await f.app.app.request('http://127.0.0.1:8787' + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.code + ': ' + data.message);
      return data;
    },
  });
  const client = new Client({ name: 'manual-update-test', version: '1' });
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const p = await client.callTool({
      name: 'forkwise_preview_update',
      arguments: { projectId: f.project.id, request: f.input },
    });
    expect(p.isError).not.toBe(true);
    const preview = (p.structuredContent as any).response.data;
    const result = await client.callTool({
      name: 'forkwise_submit_update',
      arguments: {
        projectId: f.project.id,
        idempotencyKey: randomUUID(),
        request: { ...f.input, previewHash: preview.previewHash },
      },
    });
    expect(result.isError).not.toBe(true);
    const list = await client.callTool({
      name: 'forkwise_read_updates',
      arguments: { projectId: f.project.id },
    });
    expect((list.structuredContent as any).response.data.items).toHaveLength(1);
    const eventKey = (list.structuredContent as any).response.data.items[0].eventKey;
    const jobs = await client.callTool({
      name: 'forkwise_read_update_tasks',
      arguments: { projectId: f.project.id, eventKey },
    });
    expect((jobs.structuredContent as any).response.data.items).toHaveLength(1);
    expect(
      f
        .state()
        .objects.filter((e) => e.kind === 'statement' || e.kind === 'inference')
        .every((e) => e.data.stance.value === 'pending'),
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: 'forkwise_preview_update',
          arguments: { projectId: 'forbidden', request: f.input },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
    f.app.db.close();
  }
});
