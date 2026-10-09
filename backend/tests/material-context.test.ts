import { it, expect } from 'vitest';
import { z } from 'zod';
import { createApplication } from '../src/app.js';
import type { StructuredModel } from '../src/services/research-tasks.js';
import { human, statement } from './helpers.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';

function fixture(text: string, forge = false) {
  let captured: any,
    calls = 0;
  const model: StructuredModel = {
    async generate<S extends z.ZodType>(schema: S, _purpose: string, data: unknown) {
      calls++;
      captured = data;
      const m = captured.materials.find((m: any) => m.text.includes('NeedleTarget'));
      const quote = forge ? 'HiddenMarker' : 'NeedleTarget';
      const start = forge ? 0 : (m.start ?? 0) + m.text.indexOf(quote);
      const target = captured.targets[0];
      return {
        result: schema.parse({
          checks: [
            {
              target: { id: target.id, versionId: target.contentVersionId },
              relation: 'background',
              explanation: '合成片段提供背景，未确认观点成立',
              citations: [{ sourceVersionId: 'sv', start, end: start + quote.length, quote }],
              gaps: [],
            },
          ],
          gaps: [],
        }) as z.infer<S>,
        usage: { inputTokens: 5, cost: null },
      };
    },
  };
  const app = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    researchModel: model,
  });
  const p = app.write.createProject(human, 'passage-project', { name: '材料片段测试' });
  app.write.execute(p.id, human, 'passage-material', {
    expected: {},
    commands: [
      statement('target'),
      {
        op: 'source.create',
        id: 'source',
        data: { title: '合成材料', publisher: '', rights: 'authorized' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 'source',
        text,
        retrievedAt: '2020-01-01T00:00:00Z',
        publishedAt: null,
      },
    ],
  });
  const request = (queries = ['NeedleTarget']) =>
    app.researchTasks.request(p.id, human, crypto.randomUUID(), {
      kind: 'verify',
      sourceVersionIds: ['sv'],
      targetIds: ['target'],
      retrieval: { queries, maxCharacters: 20_000 },
    });
  return { app, p, request, captured: () => captured, calls: () => calls };
}

it('百万字符材料只向模型提供有界片段；引用仍指向原始全文，任务及精确范围可导出恢复', async () => {
  const text =
    'HiddenMarker' +
    'unrelated '.repeat(110_000) +
    'NeedleTarget 数据。' +
    ' unrelated'.repeat(3000);
  const f = fixture(text),
    restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const job = f.request();
    await f.app.researchTasks.run(f.p.id, job.id);
    const result = f.app.jobs.get(f.p.id, job.id);
    expect(result.state).toBe('succeeded');
    expect(
      f.captured().materials.reduce((n: number, m: any) => n + m.text.length, 0),
    ).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(f.captured())).not.toContain('HiddenMarker');
    const citation = (result.output as any).result.checks[0].citations[0];
    expect(citation.start).toBe(text.indexOf('NeedleTarget'));
    expect(text.slice(citation.start, citation.end)).toBe(citation.quote);
    expect((result.output as any).coverage).toMatchObject({
      mode: 'retrieved_passages',
      modelCalled: true,
      retrieval: { sources: [{ totalCharacters: text.length, complete: false }] },
    });
    new ArchiveService(restored.write, restored.search).import(
      human,
      'restore-passages',
      new AssetService(f.app.repo, f.app.write).export(f.p.id),
    );
    expect(restored.jobs.get(f.p.id, job.id).input).toEqual(result.input);
    expect(restored.repo.material(f.p.id, 'sv')).toBe(text);
  } finally {
    f.app.db.close();
    restored.db.close();
  }
});

it('原文中真实存在但没有送入模型的句子不能冒充本次已读证据', async () => {
  const f = fixture('HiddenMarker' + 'unrelated '.repeat(5000) + 'NeedleTarget', true);
  try {
    const before = f.app.repo.snapshot(f.p.id),
      job = f.request();
    await f.app.researchTasks.run(f.p.id, job.id);
    expect(f.app.jobs.get(f.p.id, job.id).error).toContain('INVALID_CITATION');
    expect(f.app.repo.snapshot(f.p.id)).toEqual(before);
  } finally {
    f.app.db.close();
  }
});

it('没有命中时明确资料不足且不调用模型，不能借用另一项目的同词材料', async () => {
  const f = fixture('当前材料没有相关段落');
  try {
    const p2 = f.app.write.createProject(human, 'foreign-project', { name: '另一个私有项目' });
    f.app.write.execute(p2.id, human, 'foreign-material', {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 'foreign',
          data: { title: '其他项目', publisher: '', rights: 'authorized' },
        },
        {
          op: 'source.import',
          id: 'foreign_sv',
          sourceId: 'foreign',
          text: 'NeedleTarget 不能跨项目选入',
          retrievedAt: '2020-01-01T00:00:00Z',
          publishedAt: null,
        },
      ],
    });
    const job = f.request();
    await f.app.researchTasks.run(f.p.id, job.id);
    expect(f.calls()).toBe(0);
    expect(f.app.jobs.get(f.p.id, job.id)).toMatchObject({
      state: 'succeeded',
      output: {
        result: { checks: [{ relation: 'insufficient', citations: [] }] },
        coverage: { modelCalled: false, retrieval: { selectedCharacters: 0 } },
      },
    });
    expect(f.app.repo.snapshot(f.p.id).objects.some((e) => e.kind === 'evidence')).toBe(false);
  } finally {
    f.app.db.close();
  }
});

it('匹配过多时覆盖记录明确候选和字符预算边界，不截断伪装成全文', () => {
  const f = fixture(('NeedleTarget ' + 'a'.repeat(1000)).repeat(600));
  try {
    const job = f.request(),
      scope = job.input as any;
    expect(scope.retrieval.selectedCharacters).toBeLessThanOrEqual(20_000);
    expect(scope.retrieval.sources[0]).toMatchObject({
      complete: false,
      candidateLimitReached: true,
      budgetLimited: true,
    });
    for (const material of scope.materials)
      expect(material.text).toBe(
        f.app.repo.material(f.p.id, 'sv').slice(material.start, material.end),
      );
  } finally {
    f.app.db.close();
  }
});

it('索引缺失时从固定原文恢复；片段边界保留 UTF-16 代理对且模型使用绝对偏移', async () => {
  const text = 'a'.repeat(899) + '😀' + 'a'.repeat(400) + 'NeedleTarget' + 'b'.repeat(2000),
    f = fixture(text);
  try {
    f.app.db.prepare('DELETE FROM search_chunks WHERE project_id=?').run(f.p.id);
    const job = f.request();
    await f.app.researchTasks.run(f.p.id, job.id);
    expect(f.app.jobs.get(f.p.id, job.id).state).toBe('succeeded');
    expect(f.captured().materials[0].start).toBe(899);
    expect(f.captured().materials[0].text.startsWith('😀')).toBe(true);
    expect((f.app.jobs.get(f.p.id, job.id).output as any).result.checks[0].citations[0].start).toBe(
      text.indexOf('NeedleTarget'),
    );
  } finally {
    f.app.db.close();
  }
});

it('任务片段被损坏后明确失败，不调用模型或使用重跑检索悄悄替换输入', async () => {
  const f = fixture('a'.repeat(5000) + 'NeedleTarget');
  try {
    const job = f.request(),
      changed = job.input as any;
    changed.materials[0].text = '篡改后的片段';
    f.app.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(changed), job.id);
    await f.app.researchTasks.run(f.p.id, job.id);
    expect(f.app.jobs.get(f.p.id, job.id).error).toContain('MATERIAL_SCOPE_MISMATCH');
    expect(f.calls()).toBe(0);
  } finally {
    f.app.db.close();
  }
});

it('旧的代理对断裂索引可从原文重建，只废弃对应旧片段的派生向量', () => {
  const text = 'a'.repeat(899) + '😀' + 'a'.repeat(400) + 'NeedleTarget' + 'b'.repeat(2000),
    f = fixture(text);
  try {
    const chunk = f.app.db
      .prepare("SELECT rowid FROM search_chunks WHERE entity_id='sv' AND offset=899")
      .get() as { rowid: number };
    const other = f.app.db
      .prepare("SELECT rowid FROM search_chunks WHERE entity_id='target'")
      .get() as { rowid: number };
    f.app.search.embed(f.p.id, chunk.rowid, 'synthetic:1', [1, 0]);
    f.app.search.embed(f.p.id, other.rowid, 'synthetic:1', [0, 1]);
    f.app.db
      .prepare('UPDATE search_chunks SET offset=900,text=? WHERE rowid=?')
      .run(text.slice(900, 1900), chunk.rowid);
    const job = f.request();
    expect((job.input as any).materials[0].text.startsWith('😀')).toBe(true);
    expect(f.app.db.prepare('SELECT chunk_id FROM embeddings ORDER BY chunk_id').all()).toEqual([
      { chunk_id: other.rowid },
    ]);
    expect(f.app.repo.material(f.p.id, 'sv')).toBe(text);
  } finally {
    f.app.db.close();
  }
});
