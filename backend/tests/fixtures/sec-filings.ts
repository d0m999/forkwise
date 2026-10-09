import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecClient } from '@forkwise/public-data-core';
import { createApplication } from '../../src/app.js';
import type { StructuredModel } from '../../src/services/research-tasks.js';
import { human } from '../helpers.js';
export const accessionNumber = '0000000099-25-000001';
const index = {
  cik: 1,
  name: 'Synthetic',
  filings: {
    recent: {
      accessionNumber: [accessionNumber],
      primaryDocument: ['report.htm'],
      form: ['10-Q'],
      filingDate: ['2025-04-01'],
      reportDate: ['2025-03-31'],
    },
    files: [],
  },
};
export const html =
  '<!doctype html><html><body><p>Synthetic revenue: 12.</p><script>doNotRun()</script></body></html>';
export async function filingFixture(
  origin = 'http://127.0.0.1:8787',
  researchModel?: StructuredModel,
) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-filing-'));
  const calls: string[] = [];
  const hooks: { fetch?: () => Promise<Response> } = {};
  const client = new SecClient({
    userAgent: 'Synthetic test@example.invalid',
    cacheDirectory: join(directory, 'cache'),
    request: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/submissions/')) return Response.json(index);
      return hooks.fetch
        ? hooks.fetch()
        : new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  const app = createApplication({
    database: join(directory, 'test.sqlite'),
    origin,
    publicDataClient: client,
    ...(researchModel ? { researchModel } : {}),
  });
  const project = app.write.createProject(human, 'filing-project', { name: '合成申报正文' });
  const task = app.publicData.request(project.id, human, 'filing-index', {
    sourceId: 'sec-edgar',
    cik: '1',
    dataset: 'submissions',
    refresh: true,
  });
  await app.publicData.run(project.id, task.id);
  const indexVersionId = (app.jobs.get(project.id, task.id).output as any)
    .sourceVersionId as string;
  return {
    app,
    project,
    calls,
    hooks,
    directory,
    request: { indexSourceVersionId: indexVersionId, accessionNumber },
    close() {
      app.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
