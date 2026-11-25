import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';

it('HTTP 回环会话可以创建和重读项目，跨站、无会话及伪造 Host 拒绝写入', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-mapping-http-'));
  const mapping = openMapping(directory);
  const origin = 'http://127.0.0.1:8790';
  const app = createWorkspaceApp(mapping, origin, () => new Response('<!doctype html>工作台'));
  try {
    const home = await app.request(origin + '/', {
      headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
    });
    expect(home.status).toBe(200);
    expect(home.headers.get('set-cookie')).toBeNull();
    const bootstrap = (token: string) =>
      app.request(origin + '/api/session', {
        method: 'POST',
        headers: { Origin: origin, Authorization: `Bearer ${token}` },
      });
    expect(
      (
        await app.request(origin + '/api/mapping/projects', {
          headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
        })
      ).status,
    ).toBe(401);
    expect((await bootstrap('forged')).status).toBe(401);
    expect((await bootstrap(mapping.access.issue('agent', ['p']))).status).toBe(403);
    const session = await bootstrap(mapping.access.issue('human', ['*']));
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    expect(session.headers.get('set-cookie')).toContain('HttpOnly');
    expect(session.headers.get('set-cookie')).toContain('SameSite=Strict');
    const body = JSON.stringify({
      commandId: 'create',
      projectId: 'p',
      type: 'project.create',
      expected: null,
      payload: { name: '本机工作台' },
    });
    const post = (headers: Record<string, string>) =>
      app.request(origin + '/api/mapping/execute', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ Origin: origin })).status).toBe(401);
    expect((await post({ Cookie: cookie, Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await post({ Cookie: cookie, Origin: origin, Host: 'attacker.invalid' })).status).toBe(
      403,
    );
    expect(
      (await app.request(origin + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
    ).toBe(403);
    expect((await post({ Cookie: cookie, Origin: origin })).status).toBe(200);
    const read = await app.request(origin + '/api/mapping/projects/p', {
      headers: { Cookie: cookie },
    });
    expect(await read.json()).toMatchObject({
      project: { id: 'p', name: '本机工作台' },
      cards: [],
    });
    expect(read.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('画布引导偏好仅工作台所有者可写，保存独立于项目和撤销记录', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-guide-http-'));
  const mapping = openMapping(directory);
  const origin = 'http://127.0.0.1:8790';
  const app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const endpoint = origin + '/api/workspace/guide';
  try {
    const ownerToken = mapping.access.issue('human', ['*']);
    const owner = mapping.access.authenticate(ownerToken);
    const projectId = 'guide-project';
    mapping.execute({ commandId: 'create-guide-project', projectId, type: 'project.create', expected: null, payload: { name: '研究' } }, owner);
    const state = mapping.read({ type: 'project', projectId }, owner);
    const history = mapping.read({ type: 'history', projectId }, owner);
    const read = (token: string) => app.request(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    const write = (token: string | undefined, preference: unknown, requestOrigin = origin) => app.request(endpoint, {
      method: 'PUT', body: JSON.stringify({ preference }),
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    expect(await (await read(ownerToken)).json()).toEqual({ preference: null });
    expect((await write(undefined, 'completed')).status).toBe(401);
    expect((await write(ownerToken, 'completed', 'https://example.invalid')).status).toBe(403);
    for (const type of ['human', 'agent'] as const) {
      const projectToken = mapping.access.issue(type, [projectId]);
      expect((await read(projectToken)).status).toBe(403);
      expect((await write(projectToken, 'completed')).status).toBe(403);
    }
    expect((await write(ownerToken, 'unknown')).status).toBe(400);
    expect(await (await read(ownerToken)).json()).toEqual({ preference: null });
    expect((await write(ownerToken, 'skipped')).status).toBe(204);
    expect(await (await read(ownerToken)).json()).toEqual({ preference: 'skipped' });
    expect((await write(ownerToken, 'completed')).status).toBe(204);
    expect((await write(ownerToken, 'skipped')).status).toBe(204);
    expect(await (await read(ownerToken)).json()).toEqual({ preference: 'completed' });
    expect(mapping.read({ type: 'project', projectId }, owner)).toEqual(state);
    expect(mapping.read({ type: 'history', projectId }, owner)).toEqual(history);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('HTTP 可信项目编辑委托与 UI 共用 execute；请求自报 human、越权 ID 和重复身份明确拒绝', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-mapping-auth-'));
  const mapping = openMapping(directory);
  const { serve } = await import('@hono/node-server');
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = createWorkspaceApp(mapping, origin, () => new Response(''));
  try {
    const human = mapping.access.issue('human', ['*']);
    const post = (token: string, input: unknown) =>
      fetch(origin + '/api/mapping/execute', {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });
    for (const projectId of ['p', 'other'])
      expect(
        (
          await post(human, {
            commandId: 'create',
            projectId,
            type: 'project.create',
            expected: null,
            payload: { name: '研究' },
          })
        ).status,
      ).toBe(200);
    const create = {
      commandId: 'card',
      projectId: 'p',
      type: 'thought.create',
      expected: null,
      payload: { id: 'c', title: '', text: '原文', x: 0, y: 0 },
    };
    expect((await post(human, create)).status).toBe(200);
    expect((await post(human, { ...create, commandId: 'duplicate' })).status).toBe(409);
    const actor = mapping.access.authenticate(human);
    const original = mapping.read({ type: 'project', projectId: 'p' }, actor).cards[0]!;
    const blockId = original.body.blocks[0]!.id;
    const range = { start: 0, end: 2 };
    const agent = mapping.access.issue('agent', ['p'], 60000, undefined, [], undefined, [{
      projectId: 'p', operations: ['body.patch'], objectKinds: ['card'], cardId: 'c', blockId,
      bodyVersionId: original.body.versionId, range,
    }]);
    const other = mapping.access.issue('agent', ['other']);
    const edit = {
      commandId: 'edit',
      projectId: 'p',
      type: 'body.patch',
      expected: original.body.versionId,
      payload: { id: 'c', blockId, range, text: '授权正文' },
    };
    expect(
      (await post(agent, { ...edit, actor: { type: 'human', id: 'local-owner' } })).status,
    ).toBe(403);
    expect((await post('forged', edit)).status).toBe(401);
    expect((await post(other, edit)).status).toBe(403);
    expect((await post(other, { ...edit, projectId: 'other' })).status).toBe(403);
    expect((await post(agent, edit)).status).toBe(200);
    expect((await post(agent, { ...edit, commandId: 'stale' })).status).toBe(409);
    const receipt = await (await post(agent, edit)).json();
    expect(receipt).toMatchObject({ revision: 3 });
    const version = await fetch(
      `${origin}/api/mapping/projects/p/versions/body/${original.body.id}/${original.body.versionId}`,
      { headers: { Authorization: `Bearer ${agent}` } },
    );
    expect(version.status).toBe(200);
    expect(await version.json()).toEqual(original.body);
    mapping.access.revoke(mapping.access.authenticate(agent).tokenHash);
    expect((await post(agent, edit)).status).toBe(401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
