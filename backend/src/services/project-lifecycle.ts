import type Database from 'better-sqlite3';
import { z } from 'zod';
import { Id, type Actor, type Project } from '../contracts/entities.js';
import { requireThat } from '../domain/errors.js';
import type { GraphWriteService } from './graph-write.js';

export class ProjectLifecycle {
  constructor(readonly write: GraphWriteService) {}
  retentionDays(): number {
    const row = this.write.repo.db
      .prepare("SELECT value FROM settings WHERE key='retention_days'")
      .get() as { value: string } | undefined;
    return row ? z.number().int().min(1).max(3650).parse(JSON.parse(row.value)) : 30;
  }
  configure(actor: Actor, key: string, days: number) {
    this.human(actor);
    z.number().int().min(1).max(3650).parse(days);
    return this.write.idempotent(
      actor,
      '__settings__',
      key,
      { op: 'retention.configure', days },
      () => {
        this.write.repo.db
          .prepare(
            "INSERT INTO settings(key,value) VALUES('retention_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(JSON.stringify(days));
        return { retentionDays: days };
      },
    );
  }
  rename(
    actor: Actor,
    projectId: string,
    key: string,
    expectedRevision: number,
    name: string,
    question: string,
  ) {
    this.human(actor);
    const input = z
      .object({
        name: z.string().trim().min(1).max(100_000),
        question: z.string().max(20_000),
        expectedRevision: z.number().int().nonnegative(),
      })
      .parse({ name, question, expectedRevision });
    return this.write.idempotent(actor, projectId, key, { op: 'project.rename', input }, () => {
      const project = this.write.repo.project(projectId);
      requireThat(
        project.revision === input.expectedRevision,
        'PROJECT_CONFLICT',
        '项目已变化，请重新读取后修改项目信息',
        409,
      );
      this.write.repo.db
        .prepare('UPDATE projects SET name=?,question=?,revision=revision+1 WHERE id=?')
        .run(input.name, input.question, projectId);
      return this.write.repo.project(projectId);
    });
  }
  trash(
    actor: Actor,
    projectId: string,
    key: string,
    expectedRevision: number,
    confirmName: string,
  ) {
    this.human(actor);
    return this.write.idempotent(
      actor,
      projectId,
      key,
      { op: 'project.trash', expectedRevision, confirmName },
      () => {
        const project = this.write.repo.project(projectId);
        requireThat(
          project.name === confirmName && project.revision === expectedRevision,
          'PROJECT_CONFLICT',
          '删除确认与当前项目不一致，请重新读取',
          409,
        );
        const now = this.write.clock();
        this.write.repo.db
          .prepare('UPDATE projects SET deleted_at=?,revision=revision+1 WHERE id=?')
          .run(now, projectId);
        this.write.repo.db
          .prepare(
            "UPDATE jobs SET state='cancelled',run_token=NULL,updated_at=? WHERE project_id=? AND state IN ('running','queued','interrupted')",
          )
          .run(now, projectId);
        const deadline = new Date(
          Date.parse(now) + this.retentionDays() * 86_400_000,
        ).toISOString();
        this.write.repo.db
          .prepare(
            'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          )
          .run(
            `deletion:${projectId}`,
            JSON.stringify({ deletedAt: now, purgeAfter: deadline, state: 'retained' }),
          );
        return { projectId, deletedAt: now, purgeAfter: deadline };
      },
    );
  }
  trashList() {
    const rows = this.write.repo.db
      .prepare('SELECT id,name,deleted_at AS deletedAt FROM projects WHERE deleted_at IS NOT NULL')
      .all() as { id: string; name: string; deletedAt: string }[];
    return rows.map((p) => {
      const record = this.deletion(p.id);
      return {
        ...p,
        ...record,
        remainingDays: Math.max(
          0,
          Math.ceil((Date.parse(record.purgeAfter) - Date.parse(this.write.clock())) / 86_400_000),
        ),
      };
    });
  }
  restore(actor: Actor, projectId: string, key: string) {
    this.human(actor);
    Id.parse(projectId);
    return this.write.idempotent(actor, projectId, key, { op: 'project.restore' }, () => {
      const deleted = this.write.repo.db
        .prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NOT NULL')
        .get(projectId);
      requireThat(deleted, 'PROJECT_NOT_FOUND', '已删除项目不存在', 404);
      const record = this.deletion(projectId);
      requireThat(
        record.state === 'retained' &&
          Date.parse(this.write.clock()) < Date.parse(record.purgeAfter),
        'RETENTION_EXPIRED',
        '恢复窗口已结束，不能承诺恢复已清理数据',
        409,
      );
      this.write.repo.db
        .prepare('UPDATE projects SET deleted_at=NULL,revision=revision+1 WHERE id=?')
        .run(projectId);
      this.write.repo.db.prepare('DELETE FROM settings WHERE key=?').run(`deletion:${projectId}`);
      return this.write.repo.project(projectId);
    });
  }
  deletion(projectId: string): { deletedAt: string; purgeAfter: string; state: string } {
    const row = this.write.repo.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get(`deletion:${projectId}`) as { value: string } | undefined;
    requireThat(row, 'DELETION_METADATA_MISSING', '删除恢复信息缺失，已停止清理', 409);
    return JSON.parse(row.value);
  }
  private human(actor: Actor) {
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '项目生命周期由本人确认', 403);
  }
}

/** Used on the primary database and every managed copy, inside its own transaction. */
export function eraseProject(db: Database.Database, id: string): void {
  db.pragma('foreign_keys=ON');
  db.pragma('secure_delete=ON');
  db.transaction(() => {
    db.prepare(
      'DELETE FROM embeddings WHERE chunk_id IN (SELECT rowid FROM search_chunks WHERE project_id=?)',
    ).run(id);
    for (const table of [
      'workflow_group_tasks',
      'workflow_groups',
      'search_chunks',
      'links',
      'materials',
      'parsed_artifacts',
      'file_assets',
      'versions',
      'entities',
      'jobs',
      'layouts',
      'judgments',
      'action_history',
    ])
      db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
    db.prepare(
      "DELETE FROM operations WHERE project_id=? OR json_extract(response,'$.project.id')=? OR json_extract(response,'$.id')=? OR EXISTS(SELECT 1 FROM json_each(response,'$.projectIds') WHERE value=?)",
    ).run(id, id, id, id);
    const sessions = db.prepare('SELECT token_hash,projects FROM sessions').all() as {
      token_hash: string;
      projects: string;
    }[];
    for (const session of sessions) {
      const scope = (JSON.parse(session.projects) as string[]).filter((p) => p !== id);
      if (!scope.length)
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
      else
        db.prepare('UPDATE sessions SET projects=? WHERE token_hash=?').run(
          JSON.stringify(scope),
          session.token_hash,
        );
    }
    db.prepare('DELETE FROM projects WHERE id=?').run(id);
    db.prepare('DELETE FROM settings WHERE key IN (?,?,?)').run(
      `import:${id}`,
      `deletion:${id}`,
      `project:${id}`,
    );
    db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild')");
  }).immediate();
  db.exec('VACUUM');
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
  requireThat(
    !checkpoint.some((r) => r.busy),
    'PURGE_CHECKPOINT_BUSY',
    '数据已移除，但 WAL 尚有读者；下次继续校验清理',
    409,
  );
  requireThat(
    !db.prepare('SELECT id FROM projects WHERE id=?').get(id) &&
      (db.pragma('foreign_key_check') as unknown[]).length === 0,
    'PURGE_VERIFICATION_FAILED',
    '清理后的引用或项目校验失败',
  );
}
