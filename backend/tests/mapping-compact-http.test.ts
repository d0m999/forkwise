import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';

it('真实 HTTP 使用同一 Mapping 的固定快照、完整响应预算及当前授权', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-compact-http-'));
  let mapping = openMapping(directory);
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = createWorkspaceApp(mapping, origin, () => new Response(''));
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    mapping.execute(
      {
        commandId: 'p',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: 'HTTP 地图' },
      },
      human,
    );
    mapping.execute(
      {
        commandId: 'c',
        projectId: 'p',
        type: 'thought.create',
        expected: null,
        payload: { id: 'c', title: '真实卡片', text: '原文🧠', x: 20, y: 30 },
      },
      human,
    );
    const token = mapping.access.issue('agent', ['p']);
    const denied = mapping.access.issue('agent', ['other']);
    const read = (query: Record<string, string>, authorization = token) =>
      fetch(origin + '/api/mapping/projects/p/map?' + new URLSearchParams(query), {
        headers: { Authorization: 'Bearer ' + authorization },
      });
    const response = await read({ view: 'index', budget: '4096' });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const index = JSON.parse(raw);
    expect(Buffer.byteLength(raw)).toBe(index.bytes);
    expect(index.bytes).toBeLessThanOrEqual(4096);
    expect(index).toMatchObject({
      revision: 2,
      items: [{ id: 'c', body: { availability: 'not_fetched' } }],
    });
    const original = mapping.read({ type: 'project', projectId: 'p' }, human).cards[0]!;
    mapping.execute(
      {
        commandId: 'edit',
        projectId: 'p',
        type: 'body.edit',
        expected: original.body.versionId,
        payload: { id: 'c', text: '新文' },
      },
      human,
    );
    const query = { view: 'detail', cardId: 'c', snapshot: index.snapshot };
    const detail = await (await read(query)).json();
    expect(JSON.parse(detail.items.map((i: { jsonText: string }) => i.jsonText).join(''))).toEqual(
      original.body,
    );
    expect((await read(query, denied)).status).toBe(403);
    const small = await read({ view: 'index', budget: '8' });
    expect(small.status).toBe(413);
    expect(await small.json()).toMatchObject({
      code: 'BUDGET_TOO_SMALL',
      details: { budgetUnit: 'utf8_bytes' },
    });
    expect((await read({ view: 'detail', cardId: 'c' })).status).toBe(400);
    mapping.close();
    mapping = openMapping(directory);
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    const expired = await read(query);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ code: 'SNAPSHOT_EXPIRED' });
    mapping.access.revoke(mapping.access.authenticate(token).tokenHash);
    expect((await read(query)).status).toBe(401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
