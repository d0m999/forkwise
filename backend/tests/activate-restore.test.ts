import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app.js';
import {
  previewRestore,
  activateRestore,
  recoverActivation,
} from '../src/services/activate-restore.js';
import { researchFingerprint } from '../src/services/backup.js';
import { human, statement } from './helpers.js';

it('隔离恢复经过预览后可离线切换；运行中的服务拒绝替换，切换前状态另存受管理备份', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-activate-'));
  const options = { database: join(directory, 'research.sqlite'), origin: 'http://127.0.0.1:8787' };
  const app = createApplication(options);
  try {
    const p = app.write.createProject(human, 'activation-project', { name: '恢复切换' });
    app.write.execute(p.id, human, 'activation-first', {
      expected: {},
      commands: [statement('a', '备份前')],
    });
    const backup = await app.maintenance!.backup(human, 'activation-backup');
    const restored = await app.maintenance!.restore(human, 'activation-isolate', backup.id);
    app.write.execute(p.id, human, 'activation-second', {
      expected: { a: 1 },
      commands: [{ op: 'statement.edit', id: 'a', text: '备份后', scope: 'all' }],
    });
    expect(previewRestore(directory, restored.directory).counts.entities).toBe(1);
    writeFileSync(join(directory, 'server.pid'), String(process.pid));
    await expect(activateRestore(directory, restored.directory)).rejects.toThrow('先停止');
    rmSync(join(directory, 'server.pid'));
    app.db.close();
    const result = await activateRestore(directory, restored.directory);
    expect(result.activated).toBe(true);
    expect(result.previousStateBackupId).not.toBe(backup.id);
    const reopened = createApplication(options);
    try {
      expect(reopened.repo.snapshot(p.id).objects[0]?.data).toMatchObject({ text: '备份前' });
      expect(reopened.maintenance!.backups.list()).toHaveLength(2);
    } finally {
      reopened.db.close();
    }
  } finally {
    if (app.db.open) app.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('切换在旧库改名后中断，启动依据已落盘日志继续完成并保留研究历史', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-activation-crash-'));
  const options = { database: join(directory, 'research.sqlite'), origin: 'http://127.0.0.1:8787' },
    app = createApplication(options);
  try {
    const p = app.write.createProject(human, 'crash-project', { name: '中断恢复' });
    app.write.execute(p.id, human, 'crash-statement', {
      expected: {},
      commands: [statement('a', '可恢复状态')],
    });
    app.db.pragma('wal_checkpoint(TRUNCATE)');
    const fingerprint = researchFingerprint(app.db, 2);
    app.db.close();
    const suffix = '00000000-0000-0000-0000-000000000000',
      stage = `restore-stage-${suffix}.sqlite`,
      previous = `restore-previous-${suffix}.sqlite`;
    copyFileSync(options.database, join(directory, stage));
    renameSync(options.database, join(directory, previous));
    writeFileSync(
      join(directory, 'restore-activation.json'),
      JSON.stringify({ stage, previous, fingerprint, fingerprintVersion: 2 }),
    );
    expect(recoverActivation(directory)).toBe(true);
    expect(existsSync(join(directory, 'restore-activation.json'))).toBe(false);
    const recovered = createApplication(options);
    try {
      expect(recovered.repo.snapshot(p.id).objects[0]?.data).toMatchObject({ text: '可恢复状态' });
    } finally {
      recovered.db.close();
    }
  } finally {
    if (app.db.open) app.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
