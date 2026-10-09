import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApplication } from '../src/app.js';
import { syncProject } from '../src/services/sync.js';
import type { CommandInput } from '../src/contracts/commands.js';
const directory = mkdtempSync(join(tmpdir(), 'forkwise-capacity-'));
const app = createApplication({
  database: join(directory, 'research.sqlite'),
  origin: 'http://127.0.0.1:8787',
});
const actor = { id: 'benchmark', type: 'human' as const };
const project = app.write.createProject(actor, 'benchmark-create', {
  name: '合成容量样本（非实际投资研究）',
});
let sequence = 0;
const samples = (run: () => unknown, count = 30) => {
  const values = [];
  let value: unknown;
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    value = run();
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return {
    p50Ms: values[Math.floor(count * 0.5)],
    p95Ms: values[Math.floor(count * 0.95)],
    bytes: Buffer.byteLength(JSON.stringify(value)),
  };
};
try {
  const commands: CommandInput[] = [];
  for (let i = 0; i < 1000; i++)
    commands.push({
      op: 'statement.create',
      id: 's' + i,
      data: {
        text: `合成主张 ${i}：材料与推导范围需要逐项检查。`,
        origin: 'user',
        participation: 'personal',
        stance: { value: 'pending', reason: '' },
        citations: [],
      },
    });
  const start = performance.now();
  for (let i = 0; i < commands.length; i += 100)
    app.write.execute(project.id, actor, `benchmark_${sequence++}`, {
      expected: {},
      commands: commands.slice(i, i + 100),
    });
  for (let i = 0; i < 999; i += 100) {
    const edges: CommandInput[] = [];
    const expected: Record<string, number> = {};
    for (let j = i; j < Math.min(i + 100, 999); j++) {
      expected['s' + j] = 1;
      expected['s' + (j + 1)] = 1;
      edges.push({
        op: 'inference.create',
        id: 'i' + j,
        data: {
          premiseIds: ['s' + j],
          conclusionId: 's' + (j + 1),
          reason: '合成推导',
          combination: 'independent',
          origin: 'user',
          participation: 'personal',
          stance: { value: 'pending', reason: '' },
          citations: [],
        },
      });
    }
    app.write.execute(project.id, actor, `benchmark_${sequence++}`, { expected, commands: edges });
  }
  const createMs = performance.now() - start;
  const writes: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    app.write.execute(project.id, actor, `benchmark_${sequence++}`, {
      expected: { s500: i + 1, i499: 1, i500: 1 },
      commands: [{ op: 'statement.edit', id: 's500', text: `合成修改 ${i}`, scope: 'all' }],
    });
    writes.push(performance.now() - start);
  }
  writes.sort((a, b) => a - b);
  const revision = app.repo.project(project.id).revision;
  const result = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    cpu: cpus()[0]?.model,
    fixture: {
      statements: 1000,
      inferences: 999,
      source: 'synthetic',
      sqlite: 'temporary disk database; WAL',
    },
    createMs,
    edit: { p50Ms: writes[15], p95Ms: writes[28] },
    fullState: samples(() => app.repo.snapshot(project.id)),
    oneChange: samples(() => syncProject(app.repo, project.id, revision - 1, 0)),
    idle: samples(() => syncProject(app.repo, project.id, revision, 0)),
    limits:
      'Local process only; excludes HTTP, browser drawing, real financial documents and model latency. No acceptance target implied.',
  };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/backend-capacity.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  app.db.close();
  rmSync(directory, { recursive: true, force: true });
}
