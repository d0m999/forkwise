import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApplication } from '../src/app.js';
import {
  readResearchOverview,
  readObjectResearchResults,
} from '../src/services/research-results.js';
import { human, statement, inference, expectedOf } from '../tests/helpers.js';
import { rebuildResearchResults } from '../src/repositories/research-results-index.js';
const directory = mkdtempSync(join(tmpdir(), 'forkwise-results-capacity-'));
const path = join(directory, 'research.sqlite');
const app = createApplication({ database: path, origin: 'http://127.0.0.1:8787' });
const project = app.write.createProject(human, 'capacity-results-project', {
  name: '查证历史合成容量样本',
});
const run = (fn: () => unknown) => {
  const durations = [];
  let result;
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    result = fn();
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  return {
    p50Ms: durations[5],
    p95Ms: durations[9],
    bytes: Buffer.byteLength(JSON.stringify(result)),
  };
};
try {
  app.write.execute(project.id, human, 'capacity-statements', {
    expected: {},
    commands: Array.from({ length: 100 }, (_, i) => statement(`s${i}`)),
  });
  app.write.execute(project.id, human, 'capacity-inferences', {
    expected: expectedOf(app.repo.snapshot(project.id).objects),
    commands: Array.from({ length: 99 }, (_, i) => inference(`i${i}`, [`s${i}`], `s${i + 1}`)),
  });
  const text = 'Synthetic preserved research material. '.repeat(2106);
  app.write.execute(project.id, human, 'capacity-material', {
    expected: {},
    commands: [
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
        retrievedAt: '2026-01-01T00:00:00Z',
        publishedAt: null,
      },
    ],
  });
  const objects = app.repo.snapshot(project.id).objects,
    allTargets = objects.filter((e) => e.kind === 'statement' || e.kind === 'inference');
  const results = [];
  let total = 0;
  for (const size of [10, 100, 500]) {
    const writeStart = performance.now();
    while (total < size) {
      const targets = Array.from(
        { length: 10 },
        (_, n) => allTargets[(total * 10 + n) % allTargets.length]!,
      );
      const endpointIds = new Set(
        targets.flatMap((t) =>
          t.kind === 'inference' ? [...t.data.premiseIds, t.data.conclusionId] : [],
        ),
      );
      const task = app.jobs.enqueue(
        project.id,
        'research.verify',
        {
          kind: 'verify',
          targets,
          context: objects.filter((e) => endpointIds.has(e.id)),
          materials: [{ id: 'sv', text, version: objects.find((e) => e.id === 'sv') }],
          sourceVersionIds: ['sv'],
        },
        `capacity-job-${total++}`,
      );
      const claimed = app.jobs.claim(project.id, task.id)!;
      app.jobs.finish(
        claimed,
        'succeeded',
        {
          stale: false,
          changes: null,
          result: {
            checks: targets.map((t) => ({
              target: { id: t.id, versionId: t.contentVersionId },
              relation: 'insufficient',
              explanation: '合成核对记录，仅用于测量本机读取规模。',
              aspect: t.kind === 'inference' ? 'inference_basis' : 'reported_fact',
              citations: [],
              gaps: ['合成证据缺口'],
            })),
            gaps: [],
          },
          coverage: {
            sourceVersionIds: ['sv'],
            mode: 'selected_materials',
            networkQueries: [],
            modelCalled: true,
          },
        },
        null,
      );
    }
    const addedJobsMs = performance.now() - writeStart;
    const rebuildStart = performance.now();
    rebuildResearchResults(app.db);
    const rebuildMs = performance.now() - rebuildStart;
    app.db.pragma('wal_checkpoint(TRUNCATE)');
    const result = {
      jobs: total,
      checks: total * 10,
      taskMaterialCharacters: text.length,
      databaseBytes: statSync(path).size,
      addedJobsMs,
      rebuildMs,
      overview: run(() => readResearchOverview(app.repo, project.id)),
      detail: run(() => readObjectResearchResults(app.repo, project.id, 'i1', { limit: 20 })),
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const report = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model,
    fixture: {
      statements: 100,
      inferences: 99,
      jobs: 'synthetic retained completed jobs; real SQLite/WAL and queue lifecycle; no model/SEC calls',
    },
    results,
    limits:
      'Same-process measurements, 10 samples per read. Excludes HTTP, browser rendering and real source/model quality; no production latency guarantee.',
  };
  mkdirSync('artifacts', { recursive: true });
  const label = process.argv[2] ?? 'current';
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid report label');
  writeFileSync(
    `artifacts/research-results-capacity-${label}.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  app.db.close();
  rmSync(directory, { recursive: true, force: true });
}
