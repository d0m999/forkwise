import { afterEach, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { closeCompactFixtures, compactFixture } from './compact-fixture.js';

afterEach(closeCompactFixtures);

const referencePath = (reference: string) => `/api/mapping/card-reference?${new URLSearchParams({ reference })}`;

it('正式 HTTP 和 stdio MCP 用同一条卡片引用读取已保存最新版，遵守项目限制和历史读取边界', async () => {
  const { mapping, human } = compactFixture();
  const projectId = '项目/研究+%2F';
  const cardId = '卡%2F/研究? #1';
  const reference = `forkwise:card/${encodeURIComponent(projectId)}/${encodeURIComponent(cardId)}`;
  const execute = (command: Record<string, unknown>) => mapping.execute({ projectId, ...command }, human);
  execute({ commandId: 'create-project', type: 'project.create', expected: null, payload: { name: '研究' } });
  for (const [id, text] of [[cardId, '原版正文'], ['another-card', '另一张同名卡的正文']] as const) {
    execute({ commandId: id, type: 'thought.create', expected: null, payload: { id, title: '同名卡', text, x: 10, y: 20 } });
  }
  const card = () => mapping.read({ type: 'project', projectId }, human).cards.find(item => item.id === cardId)!;
  const original = card();
  const authorized = mapping.access.issue('agent', [projectId]);
  const otherProject = mapping.access.issue('agent', ['p']);

  let app: ReturnType<typeof createWorkspaceApp>;
  const listener = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
  const client = new Client({ name: 'card-reference-stdio', version: '1.0.0' });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('listening', resolve);
      listener.once('error', reject);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const origin = `http://127.0.0.1:${address.port}`;
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    const get = (path: string, token?: string) => fetch(origin + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/mcp.ts'],
      cwd: process.cwd(),
      env: { FORKWISE_URL: origin, FORKWISE_AGENT_TOKEN: authorized },
      stderr: 'pipe',
    }));
    const tool = (await client.listTools()).tools.find(({ name }) => name === 'forkwise_read_card_reference');
    expect(tool).toMatchObject({ annotations: { readOnlyHint: true } });
    const read = (ref: string) => client.callTool({ name: 'forkwise_read_card_reference', arguments: { reference: ref } });
    const first = await read(reference);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toEqual({ response: { projectId, cardId, availability: 'available', card: original } });

    execute({ commandId: 'rename-card', type: 'thought.title', expected: original.versionId, payload: { id: cardId, title: '改名后的卡' } });
    execute({ commandId: 'move-card', type: 'pose.move', expected: original.item.versionId, payload: { id: cardId, x: 120, y: 140 } });
    execute({ commandId: 'edit-card-body', type: 'body.edit', expected: original.body.versionId, payload: { id: cardId, text: '新版正文' } });
    const updated = card();
    expect(updated).toMatchObject({ id: cardId, title: '改名后的卡', body: { blocks: [{ text: '新版正文' }] }, item: { pose: { x: 120, y: 140 } } });
    expect(updated.body.versionId).not.toBe(original.body.versionId);
    const http = await get(referencePath(reference), authorized);
    expect(http.status).toBe(200);
    expect(http.headers.get('Cache-Control')).toBe('no-store');
    const current = { projectId, cardId, availability: 'available', card: updated };
    expect(await http.json()).toEqual(current);
    const latest = await read(reference);
    expect(latest.isError).not.toBe(true);
    expect(latest.structuredContent).toEqual({ response: current });
    expect(JSON.stringify(latest)).not.toContain('原版正文');
    const old = await get(`/api/mapping/projects/${encodeURIComponent(projectId)}/versions/body/${encodeURIComponent(original.body.id)}/${encodeURIComponent(original.body.versionId)}`, authorized);
    expect(old.status).toBe(200);
    expect(await old.json()).toEqual(original.body);

    const unauthorized = await get(referencePath(reference));
    expect(unauthorized.status).toBe(401);
    const forbidden = await get(referencePath(reference), otherProject);
    expect(forbidden.status).toBe(403);
    const forbiddenBody = await forbidden.json();
    expect(forbiddenBody).toMatchObject({ code: 'PROJECT_FORBIDDEN' });
    expect(JSON.stringify(forbiddenBody)).not.toContain('新版正文');
    const wrongProject = await read('forkwise:card/p/unknown');
    expect(wrongProject.isError).toBe(true);
    expect(wrongProject.structuredContent).toMatchObject({ error: { code: 'PROJECT_FORBIDDEN', status: 403 } });

    execute({ commandId: 'delete-card', type: 'thought.delete', expected: {
      thought: updated.versionId, body: updated.body.versionId, pose: updated.item.versionId, appearance: null,
    }, payload: { id: cardId } });
    expect((await read(reference)).structuredContent).toEqual({ response: { projectId, cardId, availability: 'deleted' } });
    expect(await (await get(referencePath(reference), otherProject)).json()).toEqual(forbiddenBody);
    const missing = await read(`forkwise:card/${encodeURIComponent(projectId)}/unknown`);
    expect(missing.structuredContent).toEqual({ response: { projectId, cardId: 'unknown', availability: 'not_found' } });
  } finally {
    try {
      await client.close();
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
  }
}, 15_000);

it('拒绝不规范的卡片引用、重复参数和附加版本条件', async () => {
  const { mapping } = compactFixture();
  const origin = 'http://127.0.0.1:8790';
  const app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const token = mapping.access.issue('agent', ['p']);
  const valid = referencePath('forkwise:card/p/card');
  const paths = [
    '/api/mapping/card-reference',
    `${valid}&reference=forkwise:card/p/other`,
    `${valid}&versionId=old`,
    ...[
      'forkwise://projects/p/cards/card', 'forkwise:card//card', 'forkwise:card/p/',
      'forkwise:card/p/card/', 'forkwise:card/p/card#extra', 'forkwise:card/p/card?versionId=old',
      'forkwise:card/p/%', 'forkwise:card/p/%ED%A0%80', 'forkwise:card/p/%63ard',
      `forkwise:card/p/${'x'.repeat(161)}`,
    ].map(referencePath),
  ];
  for (const path of paths) {
    const result = await app.request(origin + path, { headers: { Authorization: `Bearer ${token}` } });
    expect(result.status, path).toBe(400);
    expect(await result.json()).toMatchObject({ code: 'INVALID_CARD_REFERENCE' });
  }
});
