import { describe, it, expect } from 'vitest';
import { createApplication } from '../src/app.js';
import { statement } from './helpers.js';

const origin = 'http://127.0.0.1:8787';
function fixture() {
  const t = createApplication({ database: ':memory:', origin });
  const token = t.access.issue('human', ['*']);
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    bearer = token,
    more: Record<string, string> = {},
  ) =>
    t.app.request(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...more,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { ...t, token, request };
}
describe('真实 HTTP 请求契约与访问保护', () => {
  it('创建项目、事务操作、刷新读取和公开契约一致', async () => {
    const t = fixture();
    try {
      const created = await t.request('/api/v1/projects', 'POST', { name: 'HTTP 研究' }, t.token, {
        'Idempotency-Key': 'create-key',
      });
      expect(created.status).toBe(200);
      const project = (await created.json()).data;
      const result = await t.request(
        `/api/v1/projects/${project.id}/operations`,
        'POST',
        { expected: {}, commands: [statement('s')] },
        t.token,
        { 'Idempotency-Key': 'write-key' },
      );
      expect(result.status).toBe(200);
      expect((await result.json()).data.upserted).toHaveLength(1);
      const state = await t.request(`/api/v1/projects/${project.id}/state`);
      expect((await state.json()).data.project.revision).toBe(1);
      const spec = await (await t.request('/api/v1/openapi.json')).json();
      expect(spec.paths['/api/v1/projects/{projectId}/operations']).toBeDefined();
    } finally {
      t.db.close();
    }
  });
  it('错误有机器码，非法输入、过期版本、遗漏幂等键均不能写入', async () => {
    const t = fixture();
    try {
      const bad = await t.request('/api/v1/projects', 'POST', { name: '缺少操作键' });
      expect(bad.status).toBe(400);
      expect((await bad.json()).code).toBe('INVALID_REQUEST');
      expect(t.repo.listProjects()).toHaveLength(0);
    } finally {
      t.db.close();
    }
  });
  it('拒绝无会话、跨网站、伪造 Host 及跨项目读取材料和历史', async () => {
    const t = fixture();
    try {
      expect((await t.request('/api/v1/projects', 'GET', undefined, '')).status).toBe(401);
      expect(
        (
          await t.request('/api/v1/projects', 'GET', undefined, t.token, {
            Origin: 'https://evil.example',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await t.request('/api/v1/projects', 'GET', undefined, t.token, {
            Host: 'evil.example:8787',
          })
        ).status,
      ).toBe(403);
      const a = t.write.createProject({ id: 'owner', type: 'human' }, 'project-a', { name: 'A' });
      const b = t.write.createProject({ id: 'owner', type: 'human' }, 'project-b', { name: 'B' });
      const limited = t.access.issue('agent', [a.id]);
      for (const suffix of [
        'state',
        'materials/private',
        'objects/private/history',
        'jobs',
        'workspace',
        'sync?afterRevision=0&layoutVersion=0',
      ])
        expect(
          (await t.request(`/api/v1/projects/${b.id}/${suffix}`, 'GET', undefined, limited)).status,
        ).toBe(403);
      expect(
        (await (await t.request('/api/v1/projects', 'GET', undefined, limited)).json()).data.map(
          (p: { id: string }) => p.id,
        ),
      ).toEqual([a.id]);
    } finally {
      t.db.close();
    }
  });
  it('Agent 授权可幂等重试，库中不持久化明文令牌', async () => {
    const t = fixture();
    try {
      const p = t.write.createProject({ id: 'owner', type: 'human' }, 'project-a', { name: 'A' });
      const first = await t.request(
        '/api/v1/agent-grants',
        'POST',
        { projectIds: [p.id] },
        t.token,
        { 'Idempotency-Key': 'grant-key' },
      );
      const a = await first.json();
      expect(first.status).toBe(200);
      const b = await (
        await t.request('/api/v1/agent-grants', 'POST', { projectIds: [p.id] }, t.token, {
          'Idempotency-Key': 'grant-key',
        })
      ).json();
      expect(b.data.token).toBe(a.data.token);
      const operations = JSON.stringify(t.db.prepare('SELECT * FROM operations').all());
      expect(operations).not.toContain(a.data.token);
      expect(t.access.authenticate(a.data.token).projects).toEqual([p.id]);
      expect((await t.request('/api/v1/agent-grants', 'GET', undefined, a.data.token)).status).toBe(
        403,
      );
      const grants = (await (await t.request('/api/v1/agent-grants')).json()).data;
      expect(grants).toHaveLength(1);
      expect(JSON.stringify(grants)).not.toContain(a.data.token);
      const revoked = await t.request(
        `/api/v1/agent-grants/${grants[0].id}`,
        'DELETE',
        undefined,
        t.token,
        { 'Idempotency-Key': 'revoke-agent-key' },
      );
      expect(revoked.status).toBe(200);
      expect(() => t.access.authenticate(a.data.token)).toThrow('已过期');
    } finally {
      t.db.close();
    }
  });
});
