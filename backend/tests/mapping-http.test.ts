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
    const cookie = home.headers.get('set-cookie')!.split(';')[0]!;
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
