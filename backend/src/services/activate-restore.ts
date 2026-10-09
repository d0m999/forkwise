import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { requireThat } from '../domain/errors.js';
import { BackupService, researchFingerprint } from './backup.js';
import { ResearchRepository } from '../repositories/research.js';
import { openDatabase } from '../repositories/database.js';

const journalName = 'restore-activation.json';
function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function checked(db: Database.Database) {
  requireThat(
    db.pragma('integrity_check', { simple: true }) === 'ok' &&
      (db.pragma('foreign_key_check') as unknown[]).length === 0,
    'RESTORE_INVALID',
    '恢复数据库未通过完整性或引用检查',
  );
}
export function previewRestore(directory: string, restoreDirectory: string) {
  const root = resolve(directory),
    target = resolve(restoreDirectory),
    registry = join(root, 'backups', 'restores.json');
  requireThat(existsSync(registry), 'RESTORE_NOT_REGISTERED', '没有已校验的本机恢复副本');
  const entry = (
    JSON.parse(readFileSync(registry, 'utf8')) as {
      directory: string;
      fingerprint: string;
      fingerprintVersion?: number;
    }[]
  ).find((r) => resolve(r.directory) === target);
  requireThat(entry, 'RESTORE_NOT_REGISTERED', '请选择本应用已经隔离恢复并校验的目录');
  const path = join(target, 'research.sqlite');
  requireThat(existsSync(path), 'RESTORE_MISSING', '恢复副本文件不存在', 404);
  const db = new Database(path, { readonly: true });
  try {
    checked(db);
    const fingerprint = researchFingerprint(db, entry.fingerprintVersion ?? 1);
    requireThat(
      fingerprint === entry.fingerprint,
      'RESTORE_CHANGED',
      '恢复副本在校验后已改变，请重新生成隔离副本',
      409,
    );
    const projects = db.prepare('SELECT id,name FROM projects WHERE deleted_at IS NULL').all();
    const counts = Object.fromEntries(
      ['entities', 'versions', 'materials', 'file_assets', 'judgments'].map((table) => [
        table,
        db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)
          ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
          : 0,
      ]),
    );
    return {
      directory: target,
      fingerprint,
      fingerprintVersion: entry.fingerprintVersion ?? 1,
      projects,
      counts,
    };
  } finally {
    db.close();
  }
}
/** Startup recovery, called only after acquiring the data-directory process lock. */
export function recoverActivation(directory: string): boolean {
  const path = join(directory, journalName);
  if (!existsSync(path)) return false;
  const journal = JSON.parse(readFileSync(path, 'utf8')) as {
    stage: string;
    previous: string;
    fingerprint: string;
    fingerprintVersion?: number;
  };
  requireThat(
    /^restore-stage-[a-f0-9-]{36}\.sqlite$/.test(journal.stage) &&
      /^restore-previous-[a-f0-9-]{36}\.sqlite$/.test(journal.previous),
    'INVALID_RESTORE_JOURNAL',
    '恢复切换记录无效，保留现场',
  );
  const main = join(directory, 'research.sqlite'),
    stage = join(directory, journal.stage),
    previous = join(directory, journal.previous);
  const matches = (file: string) => {
    if (!existsSync(file)) return false;
    const db = new Database(file, { readonly: true });
    try {
      checked(db);
      return researchFingerprint(db, journal.fingerprintVersion ?? 1) === journal.fingerprint;
    } finally {
      db.close();
    }
  };
  if (matches(main)) {
    if (existsSync(stage)) unlinkSync(stage);
    if (existsSync(previous)) unlinkSync(previous);
    unlinkSync(path);
    return true;
  }
  if (matches(stage)) {
    if (existsSync(main)) {
      requireThat(!existsSync(previous), 'RESTORE_AMBIGUOUS', '恢复现场存在两份旧库，停止以免覆盖');
      renameSync(main, previous);
    }
    syncFile(directory);
    renameSync(stage, main);
    syncFile(directory);
    requireThat(matches(main), 'RESTORE_MISMATCH', '切换后的数据库指纹不一致，保留旧库');
    if (existsSync(previous)) unlinkSync(previous);
    unlinkSync(path);
    syncFile(directory);
    return true;
  }
  if (!existsSync(main) && existsSync(previous)) {
    renameSync(previous, main);
    unlinkSync(path);
    throw new Error('恢复副本未就绪，已回到切换前数据库');
  }
  throw new Error('恢复切换无法自动确定结果，已保留全部现场文件');
}
export async function activateRestore(directory: string, restoreDirectory: string) {
  const root = resolve(directory),
    lock = join(root, 'server.pid');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    requireThat(
      Number.isSafeInteger(pid) && pid > 0,
      'INVALID_PROCESS_LOCK',
      '进程锁无效，不能开始替换',
      409,
    );
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    requireThat(!alive, 'SERVER_RUNNING', '请先停止使用此数据目录的服务，再确认切换恢复副本', 409);
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    recoverActivation(root);
    const preview = previewRestore(root, restoreDirectory);
    const main = join(root, 'research.sqlite');
    const current = openDatabase(main);
    let backup;
    try {
      backup = await new BackupService(
        new ResearchRepository(current),
        join(root, 'backups'),
      ).create();
      const checkpoint = current.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      requireThat(
        checkpoint[0]?.busy === 0,
        'DATABASE_IN_USE',
        '数据库仍有活动事务，请关闭其他使用此数据目录的程序',
        409,
      );
    } finally {
      current.close();
    }
    requireThat(
      !existsSync(main + '-wal') && !existsSync(main + '-shm'),
      'DATABASE_IN_USE',
      '数据库仍有其他连接，尚未执行恢复切换',
      409,
    );
    const id = randomUUID(),
      stageName = `restore-stage-${id}.sqlite`,
      previous = `restore-previous-${id}.sqlite`,
      stage = join(root, stageName);
    const source = new Database(join(preview.directory, 'research.sqlite'), { readonly: true });
    try {
      await source.backup(stage);
    } finally {
      source.close();
    }
    syncFile(stage);
    syncFile(root);
    const journal = join(root, journalName);
    writeFileSync(
      journal,
      JSON.stringify({
        stage: stageName,
        previous,
        fingerprint: preview.fingerprint,
        fingerprintVersion: preview.fingerprintVersion,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    syncFile(journal);
    syncFile(root);
    recoverActivation(root);
    return {
      ...preview,
      activated: true,
      previousStateBackupId: backup.id,
      message: '恢复副本已切换；重新启动本机服务后进入该研究状态，Agent 授权需重新签发',
    };
  } finally {
    if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
  }
}
