import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecClient } from '@forkwise/public-data-core';
import { createApplication } from '../src/app.js';
import { human } from './helpers.js';

it('独立来源核心经持久化任务和同一 GraphWriteService 导入；重复字节复用原版本，新材料不生成个人立场', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forkwise-public-'));
  const client = new SecClient({
    userAgent: 'Synthetic Test test@example.invalid',
    cacheDirectory: dir,
    request: async () =>
      new Response(JSON.stringify({ cik: 1, entityName: 'Synthetic', facts: {} })),
  });
  const app = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    publicDataClient: client,
  });
  try {
    const p = app.write.createProject(human, 'source-project', { name: '来源集成' });
    const input = { sourceId: 'sec-edgar', cik: '1', dataset: 'companyfacts', refresh: true };
    const job = app.publicData.request(p.id, human, 'source-request', input);
    await app.publicData.drain();
    expect(app.jobs.get(p.id, job.id).state).toBe('succeeded');
    const first = app.repo.snapshot(p.id);
    expect(first.objects.map((e) => e.kind).sort()).toEqual(['source', 'source_version']);
    expect(first.objects.find((e) => e.kind === 'source_version')?.data).toMatchObject({
      provenance: { provider: 'sec-edgar', adapterVersion: 'sec-json@0.1.0' },
    });
    const repeated = app.publicData.request(p.id, human, 'second-request', input);
    await app.publicData.run(p.id, repeated.id);
    expect(app.repo.snapshot(p.id)).toEqual(first);
    expect(app.jobs.get(p.id, repeated.id).state).toBe('succeeded');
    expect(app.publicData.request(p.id, human, 'source-request', input).id).toBe(job.id);
  } finally {
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('未配置联系人时明确失败，不伪造网络结果，也不影响研究内容', async () => {
  const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = app.write.createProject(human, 'source-project', { name: '未配置来源' });
    const job = app.publicData.request(p.id, human, 'source-request', {
      sourceId: 'sec-edgar',
      cik: '1',
      dataset: 'companyfacts',
      refresh: true,
    });
    await app.publicData.drain();
    expect(app.jobs.get(p.id, job.id).error).toContain('SEC_NOT_CONFIGURED');
    expect(app.repo.snapshot(p.id).objects).toEqual([]);
  } finally {
    app.db.close();
  }
});
