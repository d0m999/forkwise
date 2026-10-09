// Shared synthetic external responses for service and real-browser workflow tests.
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecClient } from '@forkwise/public-data-core';
import { createApplication } from '../../src/app.js';
import { human } from '../helpers.js';
import type { StructuredModel } from '../../src/services/research-tasks.js';

export function initialResearchFixture(origin = 'http://127.0.0.1:8787') {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-initial-'));
  const calls = { reconstruct: 0, plan: 0, verify: 0, fetch: 0 };
  const hooks: {
    failFetch?: boolean;
    malformedPlan?: boolean;
    wrongAspect?: boolean;
    twoSources?: boolean;
    largeSource?: boolean;
    duringFetch?: () => Promise<void>;
    duringPlan?: () => Promise<void>;
    duringReconstruct?: () => Promise<void>;
    duringVerify?: () => Promise<void>;
    response?: (url: string) => Promise<Response | undefined>;
  } = {};
  const text = 'CIK 1 本季营收增长，明年利润可能翻倍。';
  const model: StructuredModel = {
    async generate<S extends z.ZodType>(schema: S, _purpose: string, raw: unknown) {
      const data = raw as any;
      let result: unknown;
      if (data.catalog) {
        calls.plan++;
        await hooks.duringPlan?.();
        result = {
          targets: hooks.malformedPlan
            ? []
            : data.targets.map((target: any) => ({
                target: { id: target.id, versionId: target.contentVersionId },
                classification:
                  target.kind === 'inference'
                    ? 'inference'
                    : target.data.text.includes('明年')
                      ? 'prediction'
                      : 'fact',
                period: target.data.text?.includes('明年') ? '下一财年' : '本财季',
                verificationEvent: target.data.text?.includes('明年') ? '下一财年年度报告' : null,
                verificationGoal: target.data.text?.includes('明年')
                  ? '核对全年利润是否翻倍'
                  : null,
                requests: [
                  { sourceId: 'sec-edgar', cik: '1', dataset: 'companyfacts' },
                  ...(hooks.twoSources
                    ? [{ sourceId: 'sec-edgar', cik: '1', dataset: 'submissions' }]
                    : []),
                ],
                gaps: [],
                queries: ['SyntheticMetric'],
              })),
          gaps: [],
        };
      } else if (data.kind === 'reconstruct') {
        calls.reconstruct++;
        await hooks.duringReconstruct?.();
        const material = data.materials[0],
          start = material.start ?? 0,
          citation = {
            sourceVersionId: material.id,
            start,
            end: start + material.text.length,
            quote: material.text,
          };
        result = {
          statements: [
            { key: 'a', text: '本季营收增长', origin: 'author', citations: [citation], gaps: [] },
            {
              key: 'b',
              text: '明年利润可能翻倍',
              origin: 'author',
              citations: [citation],
              gaps: [],
            },
          ],
          inferences: [
            {
              key: 'i',
              premiseKeys: ['a'],
              conclusionKey: 'b',
              reason: '营收可能带动利润',
              combination: 'independent',
              origin: 'ai',
              citations: [],
              gaps: [],
            },
          ],
          gaps: [],
        };
      } else {
        calls.verify++;
        await hooks.duringVerify?.();
        const material =
            data.materials.find((m: any) => m.structure?.role === 'label') ?? data.materials[0],
          quote = 'Synthetic';
        const start = (material.start ?? 0) + material.text.indexOf(quote);
        result = {
          checks: data.targets.map((target: any) => ({
            target: { id: target.id, versionId: target.contentVersionId },
            relation: 'background',
            explanation: '合成夹具，仅提供背景，不能确认预测结果',
            aspect: hooks.wrongAspect
              ? 'reported_fact'
              : target.kind === 'inference'
                ? 'inference_basis'
                : target.data.text.includes('明年')
                  ? 'current_basis'
                  : 'reported_fact',
            citations: [{ sourceVersionId: material.id, start, end: start + quote.length, quote }],
            gaps: [],
          })),
          gaps: [],
        };
      }
      return { result: schema.parse(result) as z.infer<S>, usage: { inputTokens: 10, cost: null } };
    },
  };
  const client = new SecClient({
    userAgent: 'Synthetic Test test@example.invalid',
    cacheDirectory: directory,
    request: async (url) => {
      calls.fetch++;
      await hooks.duringFetch?.();
      const response = await hooks.response?.(String(url));
      if (response) return response;
      if (hooks.failFetch && (!hooks.twoSources || String(url).includes('/submissions/')))
        return new Response('', { status: 403 });
      return new Response(
        JSON.stringify(
          String(url).includes('/submissions/')
            ? { cik: '0000000001', name: 'Synthetic', filings: { recent: {} } }
            : {
                cik: 1,
                entityName: 'Synthetic',
                ...(hooks.largeSource ? { padding: 'x'.repeat(1_100_000) } : {}),
                facts: {
                  'us-gaap': {
                    SyntheticMetric: {
                      label: 'Synthetic',
                      units: {
                        USD: [
                          {
                            start: '2025-01-01',
                            end: '2025-03-31',
                            val: 12,
                            filed: '2025-04-01',
                            accn: '0000000001-25-000001',
                            form: '10-Q',
                            fy: 2025,
                            fp: 'Q1',
                          },
                        ],
                      },
                    },
                  },
                },
              },
        ),
      );
    },
  });
  const app = createApplication({
    database: join(directory, 'test.sqlite'),
    origin,
    researchModel: model,
    publicDataClient: client,
  });
  const p = app.write.createProject(human, 'initial-project', { name: '首次研究合成测试' });
  app.write.execute(p.id, human, 'initial-material', {
    expected: {},
    commands: [
      {
        op: 'source.create',
        id: 's',
        data: { title: '原始观点', publisher: '', rights: 'authorized' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 's',
        text,
        retrievedAt: '2020-01-01T00:00:00Z',
        publishedAt: null,
      },
    ],
  });
  return {
    app,
    p,
    hooks,
    calls,
    model,
    client,
    directory,
    close() {
      app.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
