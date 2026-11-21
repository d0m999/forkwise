import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createApplication } from '../src/app.js';
import { statement } from './helpers.js';

const origin = 'http://127.0.0.1:8787';
function fixture(
  models: Pick<
    Parameters<typeof createApplication>[0],
    'researchModel' | 'agent' | 'visionModel'
  > = {},
) {
  const t = createApplication({ database: ':memory:', origin, ...models });
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
  it('无需会话的存活检查只返回服务状态', async () => {
    const t = fixture();
    try {
      const response = await t.app.request(origin + '/health');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 'OK', data: { status: 'ok' }, message: '' });
    } finally {
      t.db.close();
    }
  });
  it('旧研究模型能力要求会话并按实际配置逐项返回', async () => {
    const unused = async () => {
      throw new Error('读取能力不应调用模型');
    };
    const configurations = [
      { models: {}, expected: { research: false, evaluation: false, vision: false } },
      {
        models: { researchModel: { generate: unused }, visionModel: { generate: unused } },
        expected: { research: true, evaluation: false, vision: true },
      },
      {
        models: { agent: { evaluate: unused } },
        expected: { research: false, evaluation: true, vision: false },
      },
    ];
    for (const { models, expected } of configurations) {
      const t = fixture(models);
      try {
        const path = '/api/v1/model-capabilities';
        const unauthenticated = await t.app.request(origin + path);
        expect(unauthenticated.status).toBe(401);
        expect((await unauthenticated.json()).code).toBe('UNAUTHORIZED');
        const response = await t.request(path);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ code: 'OK', data: expected, message: '' });
      } finally {
        t.db.close();
      }
    }
  });
  it('运行时 OpenAPI 与提交的 YAML 都声明会话和三个布尔能力', async () => {
    const t = fixture();
    try {
      const runtime = await (await t.request('/api/v1/openapi.json')).json();
      const published = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
      for (const spec of [runtime, published]) {
        const get = spec.paths['/api/v1/model-capabilities']?.get;
        expect(get).toBeDefined();
        expect(get.security ?? spec.security).toEqual([{ LocalSession: [] }]);
        expect(get.responses[401]).toBeDefined();
        const schema = get.responses[200].content['application/json'].schema;
        expect(schema.properties.data).toMatchObject({
          type: 'object',
          properties: {
            research: { type: 'boolean' },
            evaluation: { type: 'boolean' },
            vision: { type: 'boolean' },
          },
          required: ['research', 'evaluation', 'vision'],
        });
      }
    } finally {
      t.db.close();
    }
  });
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
