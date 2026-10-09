// Synthetic SEC column layout and model response; never a real issuer claim.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createApplication } from '../../src/app.js';
import type { StructuredModel } from '../../src/services/research-tasks.js';
import { human, statement } from '../helpers.js';
export const submissionDocument = () => ({
  cik: 1,
  name: '合成申报人😀',
  padding: 'x'.repeat(1_100_000),
  filings: {
    recent: {
      accessionNumber: ['0000000999-25-000001', '0000000999-25-000002'],
      filingDate: ['2025-04-01', '2025-05-01'],
      reportDate: ['2025-03-31', '2025-03-31'],
      form: ['10-Q', '10-Q/A'],
      primaryDocument: ['quarterly.htm', 'amendment.htm'],
    },
    files: [
      {
        name: 'CIK0000000001-submissions-001.json',
        filingFrom: '2020-01-01',
        filingTo: '2022-12-31',
        filingCount: 12,
      },
    ],
  },
});
export function submissionsFixture(value = submissionDocument(), origin = 'http://127.0.0.1:8787') {
  let calls = 0,
    captured: any,
    prompt = '';
  const raw = JSON.stringify(value),
    model: StructuredModel = {
      async generate<S extends z.ZodType>(schema: S, purpose: string, input: unknown) {
        calls++;
        captured = input;
        prompt = purpose;
        const m = captured.materials.find((m: any) => m.structure?.role === 'filing');
        return {
          result: schema.parse({
            checks: [
              {
                target: {
                  id: captured.targets[0].id,
                  versionId: captured.targets[0].contentVersionId,
                },
                relation: 'supports',
                explanation: '合成索引记载了此项申报；未读取正文',
                citations: [{ sourceVersionId: 'sv', start: m.start, end: m.end, quote: m.text }],
                gaps: ['未读取正文'],
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
    origin,
    researchModel: model,
  });
  const p = app.write.createProject(human, randomUUID(), { name: '申报上下文测试' });
  app.write.execute(p.id, human, randomUUID(), {
    expected: {},
    commands: [
      statement('target', '公司提交了季度申报'),
      {
        op: 'source.create',
        id: 'source',
        data: { title: '合成 SEC 申报索引', publisher: 'SEC', rights: 'public' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 'source',
        text: raw,
        retrievedAt: '2026-01-01T00:00:00Z',
        publishedAt: null,
        provenance: {
          provider: 'sec-edgar',
          adapterVersion: 'synthetic-test@1',
          snapshotHash: createHash('sha256').update(raw).digest('hex'),
          requestUrl: 'https://data.sec.gov/submissions/CIK0000000001.json',
        },
      },
    ],
  });
  const request = (queries = ['10-Q']) =>
    app.researchTasks.request(p.id, human, randomUUID(), {
      kind: 'verify',
      sourceVersionIds: ['sv'],
      targetIds: ['target'],
      retrieval: { queries, maxCharacters: 20_000 },
    });
  return {
    app,
    p,
    model,
    raw,
    request,
    captured: () => captured,
    calls: () => calls,
    prompt: () => prompt,
  };
}
