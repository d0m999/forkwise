import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { SecClient } from '@forkwise/public-data-core';
import { createApplication } from '../src/app.js';
import { readMaterialPage } from '../src/services/material-read.js';
import { BackupService, researchFingerprint } from '../src/services/backup.js';
import { AssetService } from '../src/services/assets.js';

const directory = resolve(process.env.FORKWISE_ACCEPTANCE_DIR ?? '.data/sec-live');
mkdirSync(directory, { recursive: true, mode: 0o700 });
mkdirSync('artifacts', { recursive: true });
const app = createApplication({
  database: join(directory, 'research.sqlite'),
  origin: 'http://127.0.0.1:8787',
  publicDataClient: new SecClient({
    userAgent: process.env.SEC_USER_AGENT!,
    cacheDirectory: join(directory, 'cache'),
  }),
});
const actor = { id: 'local-owner', type: 'human' as const },
  evidence: Record<string, unknown> = {
    tier: '真实 SEC 获取与快照引用；不代表财务指标或投资结论验收',
    startedAt: new Date().toISOString(),
  };
try {
  const project = app.write.createProject(actor, randomUUID(), { name: '真实 SEC 获取验收' });
  const job = app.publicData.request(project.id, actor, randomUUID(), {
    sourceId: 'sec-edgar',
    cik: '50863',
    dataset: 'submissions',
    refresh: true,
  });
  await app.publicData.run(project.id, job.id);
  const finished = app.jobs.get(project.id, job.id);
  evidence.state = finished.state;
  evidence.error = finished.error;
  if (finished.state !== 'succeeded') throw new Error(finished.error ?? 'SEC 获取未完成');
  const version = app.repo.snapshot(project.id).objects.find((e) => e.kind === 'source_version')!;
  if (version.kind !== 'source_version') throw new Error('missing material');
  const raw = app.repo.material(project.id, version.id),
    json = JSON.parse(raw),
    name = JSON.stringify(json.name),
    start = raw.indexOf(name);
  if (start < 0) throw new Error('原文主体锚点缺失');
  const citation = { sourceVersionId: version.id, start, end: start + name.length, quote: name };
  const changes = app.write.execute(project.id, actor, randomUUID(), {
    expected: {},
    commands: [
      {
        op: 'statement.create',
        id: 'sec_subject',
        data: {
          text: `SEC 索引主体：${json.name}`,
          origin: 'author',
          participation: 'reference',
          stance: { value: 'pending', reason: '' },
          citations: [citation],
        },
      },
    ],
  });
  const segment = readMaterialPage(app.repo, project.id, version.id, { start, limit: name.length });
  if (segment.text !== name) throw new Error('回查原文与引用不同');
  const search = app.search.search(project.id, 'INTEL');
  const backups = new BackupService(app.repo, join(directory, 'backups')),
    before = researchFingerprint(app.db),
    backup = await backups.create(),
    restore = await backups.restoreIsolated(backup.id, join(directory, 'restored-' + randomUUID()));
  const exported = new AssetService(app.repo, app.write).export(project.id);
  writeFileSync(join(directory, 'project.json'), JSON.stringify(exported), { mode: 0o600 });
  Object.assign(evidence, {
    projectId: project.id,
    jobId: job.id,
    sourceVersionId: version.id,
    source: version.data.provenance,
    sha256: createHash('sha256').update(raw).digest('hex'),
    characters: raw.length,
    citation,
    readbackHash: segment.hash,
    searchResults: search.results.length,
    revision: changes.revisionAfter,
    backupFingerprint: backup.fingerprint,
    restoreVerified: restore.verified,
    fingerprintMatches: before === backup.fingerprint,
    modelConfigured: false,
  });
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : '未知失败';
  process.exitCode = 1;
} finally {
  app.db.close();
  writeFileSync('artifacts/sec-live-acceptance.json', JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      state: evidence.state,
      failure: evidence.failure,
      restoreVerified: evidence.restoreVerified,
    }),
  );
}
