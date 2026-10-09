import {
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ResearchRepository } from '../repositories/research.js';
import { requireThat } from '../domain/errors.js';
import { ResearchRepository as Repository } from '../repositories/research.js';
import { GraphWriteService } from './graph-write.js';
import { AssetService } from './assets.js';
import { eraseProject } from './project-lifecycle.js';
import { redactRestrictedBackup } from './redact-backup.js';
import { openDatabase } from '../repositories/database.js';
import { rebuildResearchResults } from '../repositories/research-results-index.js';

export interface BackupManifest {
  id: string;
  createdAt: string;
  fingerprint: string;
  fingerprintVersion?: number;
}
export interface RestoreRecord {
  directory: string;
  fingerprint: string;
  verified: boolean;
  fingerprintVersion?: number;
}
export class BackupService {
  constructor(
    readonly repo: ResearchRepository,
    readonly directory: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  async create(id: string = randomUUID()): Promise<BackupManifest> {
    requireThat(/^[a-f0-9-]{36}$/.test(id), 'INVALID_BACKUP', '备份标识无效');
    const existing = this.list().find((b) => b.id === id);
    if (existing) return existing;
    const partial = join(this.directory, id + '.partial');
    const target = join(this.directory, id + '.sqlite');
    try {
      await this.repo.db.backup(partial);
      const backup = new Database(partial);
      let fingerprint: string;
      try {
        // Credentials and operation receipts are runtime state, not portable research assets.
        backup.pragma('secure_delete=ON');
        backup.exec('DELETE FROM sessions; DELETE FROM operations;');
        backup.transaction(() => redactRestrictedBackup(backup)).immediate();
        rebuildResearchResults(backup);
        backup.exec('VACUUM');
        backup.pragma('wal_checkpoint(TRUNCATE)');
        this.check(backup);
        fingerprint = researchFingerprint(backup);
        const repo = new Repository(backup);
        const assets = new AssetService(repo, new GraphWriteService(repo));
        const projects = repo.listProjects().map((p) => assets.export(p.id));
        writeFileSync(join(this.directory, id + '.projects.json'), JSON.stringify(projects), {
          mode: 0o600,
        });
      } finally {
        backup.close();
      }
      renameSync(partial, target);
      const manifest = {
        id,
        createdAt: new Date().toISOString(),
        fingerprint,
        fingerprintVersion: 4,
      };
      writeFileSync(join(this.directory, id + '.json'), JSON.stringify(manifest), { mode: 0o600 });
      return manifest;
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
  }
  list() {
    return readdirSync(this.directory)
      .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(join(this.directory, n), 'utf8')) as BackupManifest);
  }
  async restoreIsolated(id: string, targetDirectory: string) {
    requireThat(/^[a-f0-9-]{36}$/.test(id), 'INVALID_BACKUP', '备份标识无效');
    const sourcePath = join(this.directory, id + '.sqlite');
    const manifestPath = join(this.directory, id + '.json');
    requireThat(
      existsSync(sourcePath) && existsSync(manifestPath),
      'BACKUP_NOT_FOUND',
      '备份不存在',
      404,
    );
    const destination = resolve(targetDirectory);
    requireThat(
      !existsSync(destination),
      'RESTORE_TARGET_EXISTS',
      '恢复只能写入新的隔离目录，不能覆盖现有数据',
      409,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
    const source = new Database(sourcePath, { readonly: true });
    try {
      this.check(source);
      requireThat(
        researchFingerprint(source, manifest.fingerprintVersion ?? 1) === manifest.fingerprint,
        'BACKUP_CORRUPT',
        '备份校验不匹配，已停止恢复',
      );
      mkdirSync(destination, { mode: 0o700 });
      const path = join(destination, 'research.sqlite');
      await source.backup(path);
      // Upgrade and rebuild disposable read indexes from the verified canonical
      // tasks before reporting the isolated copy ready to use.
      const restored = openDatabase(path);
      try {
        this.check(restored);
        requireThat(
          researchFingerprint(restored, manifest.fingerprintVersion ?? 1) === manifest.fingerprint,
          'RESTORE_MISMATCH',
          '恢复后的研究内容不匹配',
        );
      } finally {
        restored.close();
      }
      const record = {
        directory: destination,
        fingerprint: manifest.fingerprint,
        fingerprintVersion: manifest.fingerprintVersion ?? 1,
        verified: true,
      };
      const registry = this.restores();
      registry.push(record);
      writeFileSync(join(this.directory, 'restores.json'), JSON.stringify(registry), {
        mode: 0o600,
      });
      return record;
    } finally {
      source.close();
    }
  }
  restores(): RestoreRecord[] {
    const path = join(this.directory, 'restores.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }
  purgeCopies(projectId: string) {
    const checked: string[] = [];
    for (const manifest of this.list()) {
      const path = join(this.directory, manifest.id + '.sqlite');
      requireThat(existsSync(path), 'BACKUP_NOT_FOUND', '受管理备份已移动，不能确认清理完成', 409);
      const copy = openDatabase(path);
      try {
        eraseProject(copy, projectId);
        this.check(copy);
        manifest.fingerprint = researchFingerprint(copy);
        manifest.fingerprintVersion = 4;
      } finally {
        copy.close();
      }
      const jsonPath = join(this.directory, manifest.id + '.projects.json');
      if (existsSync(jsonPath)) {
        const archives = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
          project: { id: string };
        }[];
        writeFileSync(
          jsonPath,
          JSON.stringify(archives.filter((p) => p.project.id !== projectId)),
          { mode: 0o600 },
        );
      }
      writeFileSync(join(this.directory, manifest.id + '.json'), JSON.stringify(manifest), {
        mode: 0o600,
      });
      checked.push(path);
    }
    const restores = this.restores();
    for (const restored of restores) {
      const path = join(restored.directory, 'research.sqlite');
      requireThat(
        existsSync(path),
        'RESTORE_COPY_MISSING',
        '受管理的恢复副本已移动，须核对其位置后才能确认清理完成',
        409,
      );
      const copy = openDatabase(path);
      try {
        eraseProject(copy, projectId);
        this.check(copy);
        restored.fingerprint = researchFingerprint(copy);
        restored.fingerprintVersion = 4;
      } finally {
        copy.close();
      }
      checked.push(path);
    }
    writeFileSync(join(this.directory, 'restores.json'), JSON.stringify(restores), { mode: 0o600 });
    return checked;
  }
  private check(db: Database.Database) {
    const references = db.pragma('foreign_key_check') as unknown[];
    requireThat(
      db.pragma('integrity_check', { simple: true }) === 'ok' && references.length === 0,
      'BACKUP_CORRUPT',
      '数据库完整性或引用校验失败',
    );
  }
}
export function researchFingerprint(db: Database.Database, version = 4): string {
  const hash = createHash('sha256');
  for (const table of [
    'projects',
    'entities',
    'versions',
    'links',
    'materials',
    'layouts',
    'judgments',
    'file_assets',
    'parsed_artifacts',
    ...(version >= 2 ? ['jobs'] : []),
    ...(version >= 3 ? ['action_history'] : []),
    ...(version >= 4 ? ['workflow_groups', 'workflow_group_tasks'] : []),
  ]) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    const rows = db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
    hash.update(table);
    for (const row of rows) hash.update(row + '\n');
  }
  return hash.digest('hex');
}
