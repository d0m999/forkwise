import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { human, agent, setup } from './helpers.js';
import type { Bodies, Entity } from '../src/contracts/entities.js';
import { JobRepository } from '../src/repositories/jobs.js';
import { EvaluationService, type AgentEvaluator } from '../src/services/evaluation.js';
import { GraphWriteService } from '../src/services/graph-write.js';
import { evaluateNumeric } from '../src/domain/numeric-evaluation.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { createApplication } from '../src/app.js';

const rule: NonNullable<Bodies['condition']['rule']> = {
  subject: '测试公司',
  metric: '测试增长率',
  operator: 'gte',
  threshold: 10,
  unit: '%',
  currency: '',
  scope: '合并',
  periodKind: 'single',
  periods: [{ start: '2025-01-01', end: '2025-03-31' }],
};
function fixture(
  mode: 'numeric' | 'qualitative' | 'mixed' = 'numeric',
  evaluator?: AgentEvaluator,
) {
  const t = setup();
  const jobs = new JobRepository(t.db);
  const evaluations = new EvaluationService(t.repo, jobs, () => ['测试增长率'], evaluator);
  const service = new GraphWriteService(t.repo, jobs.clock, (c, changed) =>
    evaluations.autoEnqueue(c, changed),
  );
  t.write([
    {
      op: 'source.create',
      id: 's',
      data: { title: '虚构测试来源', publisher: '测试', rights: 'authorized' },
    },
    {
      op: 'source.import',
      id: 'sv',
      sourceId: 's',
      text: '增长率为12%',
      retrievedAt: '2025-04-01T00:00:00Z',
      publishedAt: null,
    },
    {
      op: 'evidence.create',
      id: 'e',
      data: {
        citation: { sourceVersionId: 'sv', start: 0, end: 7, quote: '增长率为12%' },
        fact: {
          subject: rule.subject,
          metric: rule.metric,
          value: 12,
          rawValue: '12%',
          unit: '%',
          currency: '',
          scope: '合并',
          periodKind: 'single',
          period: rule.periods[0]!,
        },
      },
    },
    {
      op: 'condition.create',
      id: 'c',
      data: {
        description: '测试条件',
        mode,
        ...(mode === 'mixed' ? { mixedCombination: 'joint_required' as const } : {}),
        targetIds: [],
        ...(mode !== 'qualitative' ? { rule } : {}),
      },
    },
  ]);
  return { ...t, jobs, evaluations, service };
}
describe('条件评估、保存与任务故障', () => {
  it('混合条件的数值部分由代码计算，AI 满足意见不能覆盖不满足的阈值', async () => {
    let received: unknown;
    const t = fixture('mixed', {
      async evaluate(input) {
        received = input;
        return {
          assessment: {
            verdict: 'satisfied',
            reason: '合成渠道材料支持定性要求',
            evidenceIds: [],
            citations: [],
            missing: [],
            tentative: false,
          },
          usage: null,
        };
      },
    });
    try {
      const old = t.get('c') as Entity<'condition'>;
      t.write([
        {
          op: 'condition.edit',
          id: 'c',
          scope: 'all',
          data: { ...old.data, rule: { ...rule, threshold: 15 } },
        },
      ]);
      const c = t.get('c');
      const job = t.evaluations.request(t.project.id, c.id, ['e'], c.contentVersionId);
      expect(t.jobs.summaries(t.project.id)[0]).toMatchObject({
        condition: { id: c.id, versionId: c.contentVersionId },
      });
      expect(t.jobs.summaries(t.project.id)[0]).not.toHaveProperty('input');
      expect((await t.evaluations.run(t.project.id, job.id)).state).toBe('succeeded');
      expect(received).toMatchObject({ numericAssessment: { verdict: 'not_satisfied' } });
      const result = t.repo
        .snapshot(t.project.id)
        .objects.find((e) => e.kind === 'evaluation') as Entity<'evaluation'>;
      expect(result.data.verdict).toBe('not_satisfied');
      expect(result.data).toMatchObject({
        components: {
          numeric: { verdict: 'not_satisfied', evidenceIds: ['e'] },
          qualitative: { verdict: 'satisfied' },
        },
      });
      expect(result.data.evaluator).toBe('ai');
      const incomplete = t.evaluations.request(t.project.id, c.id, [], c.contentVersionId);
      await t.evaluations.run(t.project.id, incomplete.id);
      const last = t.repo
        .snapshot(t.project.id)
        .objects.filter((e) => e.kind === 'evaluation')
        .at(-1) as Entity<'evaluation'>;
      expect(last.data.verdict).toBe('unknown');
      expect(last.data.components?.qualitative.verdict).toBe('satisfied');
      const restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
      try {
        const archive = new AssetService(t.repo, t.service).export(t.project.id);
        new ArchiveService(restored.write, restored.search).import(human, randomUUID(), archive);
        expect(
          restored.repo.snapshot(t.project.id).objects.find((e) => e.id === result.id)?.data,
        ).toEqual(result.data);
        const markdown = new AssetService(t.repo, t.service).summary(t.project.id);
        expect(markdown).toContain('确定性数值结果');
        expect(markdown).toContain('合成渠道材料支持定性要求');
      } finally {
        restored.db.close();
      }
    } finally {
      t.db.close();
    }
  });
  it('修改阈值自动入队，新结果待本人确认，旧规则评估保留', async () => {
    const t = fixture();
    try {
      const c = t.get('c') as Entity<'condition'>;
      const old = t.evaluations.request(t.project.id, c.id, ['e'], c.contentVersionId);
      await t.evaluations.run(t.project.id, old.id);
      const saved = t.service.execute(t.project.id, human, randomUUID(), {
        expected: { c: 1 },
        commands: [
          {
            op: 'condition.edit',
            id: 'c',
            scope: 'all',
            data: { ...c.data, rule: { ...rule, threshold: 15 } },
          },
        ],
      });
      expect(saved.upserted[0]?.data).toMatchObject({ rule: { threshold: 15 } });
      await t.evaluations.drain();
      const rows = t.repo.snapshot(t.project.id).objects.filter((e) => e.kind === 'evaluation');
      expect(rows.map((e) => e.data.verdict)).toEqual(['satisfied', 'not_satisfied']);
      expect(rows.every((e) => e.data.evaluator === 'rule')).toBe(true);
      expect(new Set(rows.map((e) => e.data.condition.versionId)).size).toBe(2);
    } finally {
      t.db.close();
    }
  });
  it('模型未配置时任务失败，条件保持已保存并可重试', async () => {
    const t = fixture('qualitative');
    try {
      const c = t.get('c');
      const job = t.evaluations.request(t.project.id, c.id, ['e'], c.contentVersionId);
      const result = await t.evaluations.run(t.project.id, job.id);
      expect(result.state).toBe('failed');
      expect(result.error).toContain('PROVIDER_NOT_CONFIGURED');
      expect(t.get('c')).toEqual(c);
      expect(t.jobs.retry(t.project.id, job.id).state).toBe('queued');
      expect(t.repo.snapshot(t.project.id).objects.filter((e) => e.kind === 'evaluation')).toEqual(
        [],
      );
    } finally {
      t.db.close();
    }
  });
  it('取消任务后晚到的 Agent 结果不得入库', async () => {
    let resolve!: (v: Awaited<ReturnType<AgentEvaluator['evaluate']>>) => void;
    const evaluator: AgentEvaluator = {
      evaluate: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    const t = fixture('qualitative', evaluator);
    try {
      const c = t.get('c');
      const job = t.evaluations.request(t.project.id, c.id, ['e'], c.contentVersionId);
      const promise = t.evaluations.run(t.project.id, job.id);
      t.evaluations.cancel(t.project.id, job.id);
      resolve({
        assessment: {
          verdict: 'unknown',
          reason: '资料不足',
          evidenceIds: ['e'],
          citations: [],
          missing: ['后续材料'],
          tentative: false,
        },
        usage: null,
      });
      expect((await promise).state).toBe('cancelled');
      expect(t.repo.snapshot(t.project.id).objects.filter((e) => e.kind === 'evaluation')).toEqual(
        [],
      );
    } finally {
      t.db.close();
    }
  });
  it('进程中断保持 interrupted，重复请求复用任务，本人显式重试', () => {
    const t = fixture();
    try {
      const c = t.get('c');
      const job = t.evaluations.request(t.project.id, c.id, ['e'], c.contentVersionId);
      expect(t.evaluations.request(t.project.id, c.id, ['e'], c.contentVersionId).id).toBe(job.id);
      t.jobs.claim(t.project.id, job.id);
      expect(t.jobs.recover()).toBe(1);
      expect(t.jobs.get(t.project.id, job.id).state).toBe('interrupted');
      expect(t.jobs.retry(t.project.id, job.id).state).toBe('queued');
    } finally {
      t.db.close();
    }
  });
  it('未知、不可比、未满足分别处理，未配置白名单不计算', () => {
    const t = fixture();
    try {
      const e = t.get('e') as Entity<'evidence'>;
      expect(evaluateNumeric(rule, [], '2026-01-01', ['测试增长率']).verdict).toBe('unknown');
      expect(evaluateNumeric(rule, [e], '2026-01-01', []).verdict).toBe('unknown');
      expect(
        evaluateNumeric({ ...rule, unit: '万元' }, [e], '2026-01-01', ['测试增长率']).verdict,
      ).toBe('not_comparable');
      expect(
        evaluateNumeric({ ...rule, threshold: 20 }, [e], '2026-01-01', ['测试增长率']).verdict,
      ).toBe('not_satisfied');
      expect(evaluateNumeric(rule, [e], '2025-02-01', ['测试增长率']).verdict).toBe(
        'awaiting_observation',
      );
    } finally {
      t.db.close();
    }
  });
  it('伪造引用和 Agent 人工确认被拒绝，旧规则不能确认成新规则', () => {
    const t = fixture();
    try {
      const c = t.get('c');
      expect(() =>
        t.write([
          {
            op: 'evidence.create',
            id: 'fake',
            data: {
              citation: { sourceVersionId: 'sv', start: 0, end: 7, quote: '完全不同的材料' },
            },
          },
        ]),
      ).toThrow('不能定位');
      const confirmation = {
        op: 'evaluation.confirm' as const,
        id: 'ev',
        condition: { id: 'c', versionId: c.contentVersionId },
        verdict: 'satisfied' as const,
        reason: '本人核对',
        evidenceIds: ['e'],
        citations: [],
      };
      expect(() => t.write([confirmation], t.versions(), agent)).toThrow('本人');
      t.write([
        {
          op: 'condition.edit',
          id: 'c',
          scope: 'all',
          data: { ...(c as Entity<'condition'>).data, description: '新标准' },
        },
      ]);
      expect(() => t.write([confirmation])).toThrow('规则已改变');
    } finally {
      t.db.close();
    }
  });
});
