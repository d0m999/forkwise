import {
  submissionsFixture as fixture,
  submissionDocument as document,
} from './fixtures/submissions.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import { human } from './helpers.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';

it('SEC 申报检索按完整列式记录送入模型，原文绝对位置和目录局限沿证据保持', async () => {
  const f = fixture();
  try {
    const job = f.request(),
      scope = job.input as any;
    expect(scope.retrieval.sources[0].structure).toMatchObject({
      method: 'sec_submissions_v1',
      historyFileCount: 1,
      records: [{ row: 0 }, { row: 1 }],
    });
    expect(scope.materials.filter((m: any) => m.structure.role === 'filing')).toHaveLength(2);
    expect(JSON.stringify(scope).length).toBeLessThan(20_000);
    expect((await f.app.researchTasks.run(f.p.id, job.id)).state).toBe('succeeded');
    expect(f.prompt()).toContain('申报正文');
    expect(f.prompt()).toContain('recordPointer');
    const target = f.app.repo.snapshot(f.p.id).objects.find((e) => e.id === 'target');
    expect((target!.data as any).stance.value).toBe('pending');
    const citation = f.app.jobs.get(f.p.id, job.id).output as any;
    const c = citation.result.checks[0].citations[0];
    expect(c.start).toBeGreaterThan(1_100_000);
    expect(f.raw.slice(c.start, c.end)).toBe(c.quote);
    expect(citation.coverage.retrieval.gaps.join('')).toContain('历史索引');
  } finally {
    f.app.db.close();
  }
});
it('固定申报片段随资产往返，恢复后不重新检索、不改变原有覆盖或原文', async () => {
  const f = fixture(),
    restored = createApplication({
      database: ':memory:',
      origin: 'http://127.0.0.1:8787',
      researchModel: f.model,
    });
  try {
    const job = f.request();
    new ArchiveService(restored.write, restored.search).import(
      human,
      randomUUID(),
      new AssetService(f.app.repo, f.app.write).export(f.p.id),
    );
    restored.jobs.retry(f.p.id, job.id);
    const result = await restored.researchTasks.run(f.p.id, job.id);
    expect(result.state).toBe('succeeded');
    expect(result.input).toEqual(job.input);
    expect(restored.repo.material(f.p.id, 'sv')).toBe(f.raw);
    expect(f.calls()).toBe(1);
  } finally {
    f.app.db.close();
    restored.db.close();
  }
});
it('篡改行归属、缺少字段、移除结构标记或伪造申报文件入口时不调用模型', async () => {
  for (const corrupt of [
    (s: any) => {
      s.materials.find((m: any) => m.structure?.role === 'filing_field').structure.recordPointer =
        '/filings/recent/accessionNumber/1';
    },
    (s: any) => {
      s.materials.splice(
        s.materials.findIndex((m: any) => m.structure?.role === 'filing_field'),
        1,
      );
    },
    (s: any) => {
      s.materials.forEach((m: any) => delete m.structure);
      delete s.retrieval.sources[0].structure;
    },
    (s: any) => {
      s.retrieval.sources[0].structure.records[0].documentUrl = 'https://outside.invalid/forged';
    },
  ]) {
    const f = fixture();
    try {
      const job = f.request(),
        before = f.app.repo.snapshot(f.p.id),
        scope = structuredClone(job.input);
      corrupt(scope);
      f.app.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(scope), job.id);
      const result = await f.app.researchTasks.run(f.p.id, job.id);
      expect(result.error).toContain('MATERIAL_SCOPE_MISMATCH');
      expect(f.calls()).toBe(0);
      expect(f.app.repo.snapshot(f.p.id)).toEqual(before);
    } finally {
      f.app.db.close();
    }
  }
});
it('申报列错位在排队前拒绝；没有匹配只记录不足，不把目录当全文或生成零值', async () => {
  const bad = document();
  bad.filings.recent.reportDate.pop();
  const f = fixture(bad);
  try {
    expect(() => f.request()).toThrow('列');
    expect(f.app.jobs.list(f.p.id)).toHaveLength(0);
    expect(f.app.repo.material(f.p.id, 'sv')).toBe(f.raw);
  } finally {
    f.app.db.close();
  }
  const empty = fixture();
  try {
    const job = empty.request(['不存在的申报']);
    const result = await empty.app.researchTasks.run(empty.p.id, job.id);
    expect(result).toMatchObject({
      state: 'succeeded',
      output: {
        coverage: { modelCalled: false },
        result: { checks: [{ relation: 'insufficient' }] },
      },
    });
    expect(empty.calls()).toBe(0);
  } finally {
    empty.app.db.close();
  }
});
