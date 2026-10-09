import { it, expect } from 'vitest';
import { initialResearchFixture } from './fixtures/initial-research.js';
import { human, statement } from './helpers.js';
import {
  readResearchOverview,
  readObjectResearchResults,
} from '../src/services/research-results.js';
import { rebuildResearchResults } from '../src/repositories/research-results-index.js';
import { BackupService, researchFingerprint } from '../src/services/backup.js';
import { openDatabase } from '../src/repositories/database.js';
import { ResearchRepository } from '../src/repositories/research.js';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { eraseProject } from '../src/services/project-lifecycle.js';

it('查证读取索引可以从原始任务重建，损坏的派生内容不会改变研究历史或个人判断', async () => {
  const f = initialResearchFixture();
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'index-rebuild-initial', {
      sourceVersionIds: ['sv'],
    });
    await f.app.initialResearch.run(f.p.id, job.id);
    const expected = readResearchOverview(f.app.repo, f.p.id);
    const target = expected.targets[0]!.target.id;
    const detail = readObjectResearchResults(f.app.repo, f.p.id, target, {});
    const fingerprint = researchFingerprint(f.app.db);
    // Simulate loss of a derived index, not deletion of the authoritative tasks.
    f.app.db.exec('DELETE FROM research_checks; DELETE FROM research_result_jobs;');
    expect(
      readResearchOverview(f.app.repo, f.p.id).targets.find((t) => t.target.id === target)?.checks
        .current,
    ).toBe(0);
    rebuildResearchResults(f.app.db);
    expect(readResearchOverview(f.app.repo, f.p.id)).toEqual(expected);
    expect(readObjectResearchResults(f.app.repo, f.p.id, target, {})).toEqual(detail);
    expect(researchFingerprint(f.app.db)).toBe(fingerprint);
    expect(f.app.jobs.get(f.p.id, job.id).state).toBe('succeeded');
  } finally {
    f.close();
  }
});

it('受限原文在备份索引中同样省略；隔离恢复重建被篡改的索引，项目清理移除全部派生副本', async () => {
  const f = initialResearchFixture();
  try {
    f.app.write.execute(f.p.id, human, 'index-restricted-material', {
      expected: {},
      commands: [
        statement('restricted_target'),
        {
          op: 'source.create',
          id: 'restricted',
          data: { title: '受限材料', publisher: '', rights: 'restricted' },
        },
        {
          op: 'source.import',
          id: 'restricted_version',
          sourceId: 'restricted',
          text: 'Synthetic',
          retrievedAt: '2020-01-01T00:00:00Z',
          publishedAt: null,
        },
      ],
    });
    const job = f.app.researchTasks.request(f.p.id, human, 'index-restricted-check', {
      kind: 'verify',
      sourceVersionIds: ['restricted_version'],
      targetIds: ['restricted_target'],
    });
    await f.app.researchTasks.run(f.p.id, job.id);
    const original = researchFingerprint(f.app.db);
    const backups = new BackupService(f.app.repo, join(f.directory, 'backups'));
    const snapshot = await backups.create();
    const backupPath = join(f.directory, 'backups', snapshot.id + '.sqlite');
    expect(readFileSync(backupPath).includes(Buffer.from('Synthetic'))).toBe(false);
    const copy = new Database(backupPath);
    copy
      .prepare(
        `UPDATE research_checks SET "check"=json_set("check",'$.citations[0].quote','错误的派生引用')`,
      )
      .run();
    expect(researchFingerprint(copy)).toBe(snapshot.fingerprint);
    copy.close();
    const restored = await backups.restoreIsolated(snapshot.id, join(f.directory, 'restore-index'));
    const restoredDb = new Database(join(restored.directory, 'research.sqlite'), {
      readonly: true,
    });
    try {
      expect(
        readObjectResearchResults(
          new ResearchRepository(restoredDb),
          f.p.id,
          'restricted_target',
          {},
        ).checks[0]?.check.citations[0],
      ).toMatchObject({ quote: '', unavailableReason: 'rights' });
    } finally {
      restoredDb.close();
    }
    expect(researchFingerprint(f.app.db)).toBe(original);
    expect(f.app.repo.material(f.p.id, 'restricted_version')).toBe('Synthetic');
    await backups.purgeCopies(f.p.id);
    eraseProject(f.app.db, f.p.id);
    for (const path of [
      join(f.directory, 'test.sqlite'),
      backupPath,
      join(restored.directory, 'research.sqlite'),
    ]) {
      const db = new Database(path, { readonly: true });
      try {
        expect(db.prepare('SELECT count(*) AS n FROM research_checks').get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT count(*) AS n FROM research_result_jobs').get()).toEqual({
          n: 0,
        });
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    }
  } finally {
    f.close();
  }
});

it('已有六次迁移的任务在升级及重开后可读取，索引重建不改原任务指纹', async () => {
  const f = initialResearchFixture();
  let reopened: Database.Database | undefined;
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'index-upgrade-initial', {
      sourceVersionIds: ['sv'],
    });
    await f.app.initialResearch.run(f.p.id, job.id);
    const expected = readResearchOverview(f.app.repo, f.p.id);
    const fingerprint = researchFingerprint(f.app.db);
    // Recreate the previous released schema while retaining its real task rows.
    f.app.db.exec(`DROP TRIGGER research_results_insert; DROP TRIGGER research_results_update;
      DROP TRIGGER research_results_delete; DROP VIEW research_check_source;
      DROP VIEW research_result_job_source; DROP TABLE research_checks; DROP TABLE research_result_jobs;
      DELETE FROM __drizzle_migrations WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations);`);
    f.app.db.close();
    reopened = openDatabase(join(f.directory, 'test.sqlite'));
    expect(readResearchOverview(new ResearchRepository(reopened), f.p.id)).toEqual(expected);
    expect(researchFingerprint(reopened)).toBe(fingerprint);
    reopened.exec("UPDATE research_checks SET explanation_preview='错误的派生缓存'");
    reopened.close();
    reopened = openDatabase(join(f.directory, 'test.sqlite'));
    expect(readResearchOverview(new ResearchRepository(reopened), f.p.id)).toEqual(expected);
    expect(researchFingerprint(reopened)).toBe(fingerprint);
  } finally {
    reopened?.close();
    f.close();
  }
});

it('索引落盘失败与任务结果及候选整批回滚，显式重试后只保存一份当前记录', async () => {
  const f = initialResearchFixture();
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'index-failure-initial', {
      sourceVersionIds: ['sv'],
    });
    f.app.db.exec(
      "CREATE TRIGGER fail_results_index BEFORE INSERT ON research_checks BEGIN SELECT RAISE(ABORT,'synthetic index disk failure'); END;",
    );
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('partial');
    expect(f.app.repo.snapshot(f.p.id).objects.filter((e) => e.kind === 'evidence_link')).toEqual(
      [],
    );
    expect(
      readResearchOverview(f.app.repo, f.p.id).targets.every((t) => t.checks.current === 0),
    ).toBe(true);
    f.app.db.exec('DROP TRIGGER fail_results_index');
    f.app.jobs.retry(f.p.id, job.id);
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('succeeded');
    const overview = readResearchOverview(f.app.repo, f.p.id);
    expect(overview.targets).toHaveLength(3);
    expect(
      overview.targets.every((t) => t.checks.current === 1 && t.evidence.candidate === 1),
    ).toBe(true);
  } finally {
    f.close();
  }
});
