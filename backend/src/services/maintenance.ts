import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor } from '../contracts/entities.js';
import type { GraphWriteService } from './graph-write.js';
import { ProjectLifecycle, eraseProject } from './project-lifecycle.js';
import { BackupService } from './backup.js';
import { requireThat } from '../domain/errors.js';
import { digest } from './graph-write.js';

export class MaintenanceService {
  readonly backups: BackupService;
  readonly lifecycle: ProjectLifecycle;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly write: GraphWriteService,
    readonly directory: string,
  ) {
    this.backups = new BackupService(write.repo, join(directory, 'backups'));
    this.lifecycle = new ProjectLifecycle(write);
  }
  private exclusive<T>(run: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }
  async idle(): Promise<void> {
    await this.tail;
  }
  async backup(actor: Actor, key: string) {
    return this.operation(actor, key, { op: 'backup.create' }, (id) => this.backups.create(id));
  }
  async restore(actor: Actor, key: string, backupId: string) {
    return this.operation(actor, key, { op: 'backup.restore', backupId }, async (id) => {
      const parent = join(this.directory, 'restores');
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const target = join(parent, id);
      const recovered = this.backups.restores().find((r) => r.directory === target);
      if (recovered) return recovered;
      requireThat(
        !existsSync(target),
        'RESTORE_INCOMPLETE',
        '上次恢复未完成，请保留该隔离目录供检查；可用新操作键恢复到另一个目录',
        409,
      );
      return this.backups.restoreIsolated(backupId, target);
    });
  }
  async purgeDue() {
    return this.exclusive(() => {
      const due = this.lifecycle
        .trashList()
        .filter((p) => Date.parse(p.purgeAfter) <= Date.parse(this.write.clock()));
      const pending = this.write.repo.db
        .prepare("SELECT key,value FROM settings WHERE key LIKE 'purge:%'")
        .all() as { key: string; value: string }[];
      const ids = new Set([
        ...due.map((p) => p.id),
        ...pending
          .filter((p) => JSON.parse(p.value).state !== 'complete')
          .map((p) => p.key.slice(6)),
      ]);
      const results: { projectId: string; state: string; copies?: string[]; error?: string }[] = [];
      for (const id of ids) {
        const save = (data: unknown) =>
          this.write.repo.db
            .prepare(
              'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            )
            .run(`purge:${id}`, JSON.stringify(data));
        save({ state: 'running', startedAt: this.write.clock() });
        try {
          const copies = this.backups.purgeCopies(id);
          eraseProject(this.write.repo.db, id);
          const result = {
            projectId: id,
            state: 'complete',
            copies,
            completedAt: this.write.clock(),
          };
          save(result);
          results.push(result);
        } catch {
          const result = {
            projectId: id,
            state: 'failed',
            error: '清理未全部完成，请核对本机副本和占用后重试；不能视为已清除',
            updatedAt: this.write.clock(),
          };
          save(result);
          results.push(result);
        }
      }
      return results;
    });
  }
  private operation<T>(actor: Actor, key: string, input: unknown, run: (id: string) => Promise<T>) {
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '本机备份与恢复由本人操作', 403);
    requireThat(/^[A-Za-z0-9_-]{8,128}$/.test(key), 'INVALID_IDEMPOTENCY_KEY', '操作键无效', 400);
    return this.exclusive(async () => {
      const db = this.write.repo.db;
      const scope = `maintenance:${actor.id}:${key}`;
      const row = db.prepare('SELECT value FROM settings WHERE key=?').get(scope) as
        | { value: string }
        | undefined;
      if (row) {
        const prior = JSON.parse(row.value) as { hash: string; result?: T };
        requireThat(
          prior.hash === digest(input),
          'IDEMPOTENCY_CONFLICT',
          '同一操作键不能用于不同维护操作',
          409,
        );
        if (prior.result) return prior.result;
      }
      db.prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(scope, JSON.stringify({ hash: digest(input) }));
      const hex = createHash('sha256').update(scope).digest('hex');
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      const result = await run(id);
      db.prepare('UPDATE settings SET value=? WHERE key=?').run(
        JSON.stringify({ hash: digest(input), result }),
        scope,
      );
      return result;
    });
  }
}
