import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { z } from 'zod';
import { createApplication } from '../src/app.js';
import type { StructuredModel } from '../src/services/research-tasks.js';
import { human, statement } from './helpers.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';

// Synthetic issuer and figures only; this is a source-layout/contract check.
const raw = JSON.stringify({
  cik: 1,
  entityName: '合成公司😀',
  padding: 'x'.repeat(60_000),
  facts: {
    'us-gaap': {
      SyntheticRevenue: {
        label: 'Synthetic revenue',
        description: '合成口径',
        units: {
          USD: [12, 14].map((val, i) => ({
            start: '2025-01-01',
            end: '2025-03-31',
            val,
            filed: `2025-0${i + 4}-01`,
            accn: `0000000001-25-00000${i + 1}`,
            fp: 'Q1',
            fy: 2025,
          })),
        },
      },
    },
  },
});
function fixture(text = raw) {
  let captured: any,
    calls = 0;
  const model: StructuredModel = {
    async generate<S extends z.ZodType>(schema: S, _purpose: string, data: unknown) {
      calls++;
      captured = data;
      const m = captured.materials.find((m: any) => m.structure?.role === 'fact'),
        target = captured.targets[0];
      return {
        result: schema.parse({
          checks: [
            {
              target: { id: target.id, versionId: target.contentVersionId },
              relation: 'background',
              explanation: '合成披露仅作背景，尚未确认比较口径',
              citations: [{ sourceVersionId: 'sv', start: m.start, end: m.end, quote: m.text }],
              gaps: ['单季或累计未确认'],
            },
          ],
          gaps: [],
        }) as z.infer<S>,
        usage: null,
      };
    },
  };
  const app = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    researchModel: model,
  });
  const p = app.write.createProject(human, 'financial-project', { name: '合成财务记录' });
  app.write.execute(p.id, human, 'financial-material', {
    expected: {},
    commands: [
      statement('target'),
      {
        op: 'source.create',
        id: 'source',
        data: { title: '合成 SEC 布局', publisher: 'SEC', rights: 'public' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 'source',
        text,
        retrievedAt: '2026-01-01T00:00:00Z',
        publishedAt: null,
        provenance: {
          provider: 'sec-edgar',
          adapterVersion: 'synthetic-test@1',
          snapshotHash: createHash('sha256').update(text).digest('hex'),
          requestUrl: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json',
        },
      },
    ],
  });
  const request = (queries = ['Synthetic revenue']) =>
    app.researchTasks.request(p.id, human, crypto.randomUUID(), {
      kind: 'verify',
      targetIds: ['target'],
      sourceVersionIds: ['sv'],
      retrieval: { queries, maxCharacters: 20_000 },
    });
  return { app, p, request, model, captured: () => captured, calls: () => calls };
}

it('后端任务使用完整财务记录和父级口径；存档恢复后仍逐一核对原文位置', async () => {
  const f = fixture(),
    restored = createApplication({
      database: ':memory:',
      origin: 'http://127.0.0.1:8787',
      researchModel: f.model,
    });
  try {
    const job = f.request(),
      scope = job.input as any;
    expect(scope.retrieval.sources[0].structure.records).toHaveLength(2);
    expect(scope.materials.filter((m: any) => m.structure.role === 'fact')).toHaveLength(2);
    expect(scope.materials.some((m: any) => m.text.includes('x'.repeat(100)))).toBe(false);
    expect(scope.retrieval.sources[0].structure.records[0].gaps.join('')).toContain('单季或累计');
    new ArchiveService(restored.write, restored.search).import(
      human,
      'restore-financial',
      new AssetService(f.app.repo, f.app.write).export(f.p.id),
    );
    expect(restored.jobs.get(f.p.id, job.id).state).toBe('interrupted');
    restored.jobs.retry(f.p.id, job.id);
    await restored.researchTasks.run(f.p.id, job.id);
    const result = restored.jobs.get(f.p.id, job.id);
    expect(result.state).toBe('succeeded');
    expect(result.input).toEqual(job.input);
    expect(f.calls()).toBe(1);
    const citation = (result.output as any).result.checks[0].citations[0];
    expect(citation.start).toBeGreaterThan(60_000);
    expect(raw.slice(citation.start, citation.end)).toBe(citation.quote);
    expect(f.captured().materials.find((m: any) => m.structure.role === 'unit').text).toBe('"USD"');
    expect(
      restored.repo.snapshot(f.p.id).objects.find((e) => e.id === 'target')?.data,
    ).toMatchObject({ stance: { value: 'pending' } });
  } finally {
    f.app.db.close();
    restored.db.close();
  }
});

it('篡改单位路径、移除单位上下文或修改材料版本后不调用模型，不生成依据', async () => {
  for (const mutate of [
    (scope: any) => {
      scope.materials.find((m: any) => m.structure.role === 'unit').structure.pointer += '/forged';
    },
    (scope: any) => {
      scope.materials = scope.materials.filter((m: any) => m.structure.role !== 'unit');
    },
    (scope: any) => {
      scope.materials[0].version.data.provenance.requestUrl =
        'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000002.json';
    },
  ]) {
    const f = fixture();
    try {
      const before = f.app.repo.snapshot(f.p.id),
        job = f.request(),
        scope = structuredClone(job.input);
      mutate(scope);
      f.app.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(scope), job.id);
      await f.app.researchTasks.run(f.p.id, job.id);
      expect(f.app.jobs.get(f.p.id, job.id).error).toContain('MATERIAL_SCOPE_MISMATCH');
      expect(f.calls()).toBe(0);
      expect(f.app.repo.snapshot(f.p.id)).toEqual(before);
    } finally {
      f.app.db.close();
    }
  }
});

it('无匹配的财务材料明确不足，无需配置模型也不填零', async () => {
  const f = fixture();
  try {
    const job = f.request(['NoSuchMetric']);
    await f.app.researchTasks.run(f.p.id, job.id);
    expect(f.calls()).toBe(0);
    expect(f.app.jobs.get(f.p.id, job.id)).toMatchObject({
      state: 'succeeded',
      output: {
        coverage: {
          modelCalled: false,
          retrieval: { sources: [{ structure: { matchedRecords: 0, records: [] } }] },
        },
        result: { checks: [{ relation: 'insufficient' }] },
      },
    });
  } finally {
    f.app.db.close();
  }
});

it('错误主体与歧义 JSON 在排队前拒绝，原始材料保留且不退回普通片段', () => {
  for (const bad of [
    raw.replace('"cik":1', '"cik":2'),
    raw.replace('"cik":1', '"cik":1,"cik":1'),
  ]) {
    const f = fixture(bad);
    try {
      expect(() => f.request()).toThrow(/CIK|重复键/);
      expect(f.app.jobs.list(f.p.id)).toHaveLength(0);
      expect(f.app.repo.material(f.p.id, 'sv')).toBe(bad);
    } finally {
      f.app.db.close();
    }
  }
});
