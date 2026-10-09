import { z } from 'zod';
import { initialResearchFixture } from './initial-research.js';

export function initialFilingsFixture(origin?: string) {
  const f = initialResearchFixture(origin);
  const network: string[] = [],
    verification: any[] = [];
  const hooks: {
    failBody?: boolean;
    duringBody?: () => Promise<void>;
    forms?: string[];
    includeHistory?: boolean;
    rows?: number;
    filter?: { filedFrom: string; filedThrough: string };
  } = {};
  const generate = f.model.generate.bind(f.model);
  f.model.generate = async <S extends z.ZodType>(
    schema: S,
    purpose: string,
    raw: unknown,
    signal?: AbortSignal,
  ) => {
    const data = raw as any;
    if (data.catalog) {
      f.calls.plan++;
      return {
        result: schema.parse({
          targets: data.targets.map((target: any) => ({
            target: { id: target.id, versionId: target.contentVersionId },
            classification:
              target.kind === 'inference'
                ? 'inference'
                : target.data.text.includes('明年')
                  ? 'prediction'
                  : 'fact',
            period: '本财季',
            verificationEvent: null,
            gaps: [],
            queries: ['Synthetic'],
            requests: [
              {
                sourceId: 'sec-edgar',
                cik: '1',
                dataset: 'submissions',
                filings: {
                  forms: hooks.forms ?? ['10-Q'],
                  ...(hooks.includeHistory ? { includeHistory: true } : {}),
                  filedFrom: '2025-04-01',
                  filedThrough: '2025-04-30',
                  ...hooks.filter,
                },
              },
            ],
          })),
          gaps: [],
        }) as z.infer<S>,
        usage: { cost: null },
      };
    }
    if (data.kind === 'verify') {
      verification.push(data);
      data.materials.sort(
        (a: any, b: any) =>
          Number(b.text.includes('Synthetic revenue')) -
          Number(a.text.includes('Synthetic revenue')),
      );
    }
    return generate(schema, purpose, data, signal!);
  };
  f.hooks.response = async (url) => {
    network.push(url);
    if (url.includes('/submissions/')) {
      const n = hooks.rows ?? 1;
      return Response.json({
        cik: 1,
        name: 'Synthetic',
        filings: {
          recent: {
            accessionNumber: Array.from(
              { length: n },
              (_, i) => `0000000099-25-${String(i + 1).padStart(6, '0')}`,
            ),
            primaryDocument: Array.from({ length: n }, (_, i) => `report${i + 1}.htm`),
            form: Array(n).fill('10-Q'),
            filingDate: Array(n).fill('2025-04-01'),
            reportDate: Array(n).fill('2025-03-31'),
          },
          files: [{ name: 'CIK0000000001-submissions-001.json' }],
        },
      });
    }
    await hooks.duringBody?.();
    return hooks.failBody
      ? new Response('', { status: 403 })
      : new Response(
          '<html><body><h1>Synthetic report</h1><p>Synthetic revenue: 12.</p></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
  };
  return { ...f, filingHooks: hooks, network, verification };
}
