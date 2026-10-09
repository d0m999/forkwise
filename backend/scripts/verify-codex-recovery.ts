import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { BackupService, researchFingerprint } from '../src/services/backup.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
const evidence = JSON.parse(readFileSync('artifacts/codex-live-acceptance.json', 'utf8'));
if (!evidence.passed) throw new Error('真实 Codex 尚未通过，不能生成恢复成功证据');
const app = createApplication({
  database: join(evidence.directory, 'research.sqlite'),
  origin: 'http://127.0.0.1:8897',
});
let recovered: ReturnType<typeof createApplication> | undefined,
  roundtrip: ReturnType<typeof createApplication> | undefined;
try {
  const fingerprint = researchFingerprint(app.db),
    backups = new BackupService(app.repo, join(evidence.directory, 'backups'));
  const backup = await backups.create(),
    restore = await backups.restoreIsolated(
      backup.id,
      join(evidence.directory, 'verified-restore-' + randomUUID()),
    );
  recovered = createApplication({
    database: join(restore.directory, 'research.sqlite'),
    origin: 'http://127.0.0.1:8897',
  });
  const exported = new AssetService(app.repo, app.write).export(evidence.projectId);
  roundtrip = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8897' });
  new ArchiveService(roundtrip.write, roundtrip.search).import(
    { id: 'local-owner', type: 'human' },
    randomUUID(),
    exported,
  );
  const after = new AssetService(roundtrip.repo, roundtrip.write).export(evidence.projectId);
  const checks = {
    sqliteFingerprint: researchFingerprint(recovered.db) === fingerprint,
    backupFingerprint: backup.fingerprint === fingerprint,
    sessionsRemoved: recovered.access.grants().length === 0,
    objects: JSON.stringify(exported.objects) === JSON.stringify(after.objects),
    files: JSON.stringify(exported.files) === JSON.stringify(after.files),
    layout: JSON.stringify(exported.layout) === JSON.stringify(after.layout),
    tasks: JSON.stringify(exported.tasks) === JSON.stringify(after.tasks),
    history: JSON.stringify(exported.actionHistory) === JSON.stringify(after.actionHistory),
  };
  if (Object.values(checks).some((v) => !v))
    throw new Error('恢复比较不一致：' + JSON.stringify(checks));
  writeFileSync(
    'artifacts/codex-live-recovery.json',
    JSON.stringify(
      {
        tier: '真实 Codex 写入后的冷开库、SQLite 隔离恢复与 JSON 往返',
        projectId: evidence.projectId,
        originalDirectory: evidence.directory,
        restoredDirectory: restore.directory,
        fingerprint,
        backupId: backup.id,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, restoredDirectory: restore.directory }));
} finally {
  app.db.close();
  recovered?.db.close();
  roundtrip?.db.close();
}
