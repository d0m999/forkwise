import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { setup, statement, inference, human } from './helpers.js';
import { AssetService } from '../src/services/assets.js';
import { BackupService, researchFingerprint } from '../src/services/backup.js';

it('在线一致性备份可恢复到隔离目录，历史判断与材料逐项一致，不覆盖已有目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forkwise-backup-'));
  const t = setup(join(dir, 'original.sqlite'));
  try {
    t.write([
      statement('a'),
      statement('b'),
      inference('i', ['a'], 'b'),
      {
        op: 'source.create',
        id: 's',
        data: { title: '恢复测试', publisher: '', rights: 'authorized' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 's',
        text: '应保留的原文',
        retrievedAt: '2025-01-01T00:00:00Z',
        publishedAt: null,
      },
    ]);
    const assets = new AssetService(t.repo, t.service);
    assets.recordJudgment(t.project.id, human, 'judgment-key', '备份前判断');
    const backups = new BackupService(t.repo, join(dir, 'backups'));
    const snapshot = await backups.create();
    const before = researchFingerprint(t.db);
    expect(snapshot.fingerprint).toBe(before);
    t.write([{ op: 'statement.edit', id: 'a', scope: 'all', text: '备份后修改' }]);
    const restored = await backups.restoreIsolated(snapshot.id, join(dir, 'restored'));
    expect(restored.verified).toBe(true);
    const db = new Database(join(restored.directory, 'research.sqlite'), { readonly: true });
    try {
      expect(researchFingerprint(db)).toBe(before);
      expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    await expect(backups.restoreIsolated(snapshot.id, join(dir, 'restored'))).rejects.toThrow(
      '不能覆盖',
    );
    expect(t.get('a').data).toMatchObject({ text: '备份后修改' });
  } finally {
    t.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
