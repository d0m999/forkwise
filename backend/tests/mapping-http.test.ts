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
    const agent = mapping.access.issue('agent', ['p'], 60000, undefined, ['p']);
    const other = mapping.access.issue('agent', ['other'], 60000, undefined, ['other']);
    const edit = {
      commandId: 'edit',
      projectId: 'p',
      type: 'body.edit',
      expected: original.body.versionId,
      payload: { id: 'c', text: '授权正文' },
    };
    expect(
      (await post(agent, { ...edit, actor: { type: 'human', id: 'local-owner' } })).status,
    ).toBe(400);
    expect((await post('forged', edit)).status).toBe(401);
    expect((await post(other, edit)).status).toBe(403);
    expect((await post(other, { ...edit, projectId: 'other' })).status).toBe(404);
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
