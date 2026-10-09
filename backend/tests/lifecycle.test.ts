import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createApplication } from '../src/app.js';
import { MaintenanceService } from '../src/services/maintenance.js';
import { GraphWriteService } from '../src/services/graph-write.js';
import { ProjectLifecycle } from '../src/services/project-lifecycle.js';
import { human, agent, statement } from './helpers.js';

it('软删除阻断访问，窗口内可恢复，保留期届满清除主库、SQLite/JSON 备份与隔离恢复副本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forkwise-retention-'));
  const app = createApplication({
    database: join(dir, 'research.sqlite'),
    origin: 'http://127.0.0.1:8787',
  });
  let now = '2026-01-01T00:00:00.000Z';
  const write = new GraphWriteService(
    app.repo,
    () => now,
    (c, changed) => app.search.index(changed, c.texts),
  );
  const maintenance = new MaintenanceService(write, dir);
  const lifecycle = maintenance.lifecycle;
  try {
    const p = write.createProject(human, 'make-project', { name: '清理测试' });
    write.execute(p.id, human, 'make-objects', {
      expected: {},
      commands: [statement('a', '绝不能留在清除后的副本')],
    });
    const backup = await maintenance.backup(human, 'make-backup');
    const recovered = await maintenance.restore(human, 'restore-copy', backup.id);
    const deleted = lifecycle.trash(human, p.id, 'trash-first', 1, p.name);
    expect(deleted.purgeAfter).toBe('2026-01-31T00:00:00.000Z');
    expect(() => app.repo.snapshot(p.id)).toThrow('不存在');
    expect(lifecycle.restore(human, p.id, 'restore-project').revision).toBe(3);
    lifecycle.trash(human, p.id, 'trash-final', 3, p.name);
    expect(await maintenance.purgeDue()).toEqual([]);
    now = '2026-02-01T00:00:00.000Z';
    expect(() => lifecycle.restore(human, p.id, 'too-late-restore')).toThrow('窗口已结束');
    const result = await maintenance.purgeDue();
    expect(result[0]?.state).toBe('complete');
    for (const file of [
      join(dir, 'research.sqlite'),
      join(dir, 'backups', backup.id + '.sqlite'),
      join(recovered.directory, 'research.sqlite'),
    ]) {
      const db = new Database(file, { readonly: true });
      try {
        expect(db.prepare('SELECT * FROM projects').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM versions').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM search_chunks').all()).toEqual([]);
        expect(
          db.prepare("SELECT * FROM search_fts WHERE search_fts MATCH '绝不能'").all(),
        ).toEqual([]);
      } finally {
        db.close();
      }
      expect(readFileSync(file).includes(Buffer.from('绝不能留在清除后的副本'))).toBe(false);
    }
    expect(
      JSON.parse(readFileSync(join(dir, 'backups', backup.id + '.projects.json'), 'utf8')),
    ).toEqual([]);
    expect(await maintenance.purgeDue()).toEqual([]);
  } finally {
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('Agent 不能删除项目或改变保留期；错误确认不删除，修改保留期不缩短已有恢复窗口', () => {
  const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = app.write.createProject(human, 'create-project', { name: '保留窗口' });
    const l = new ProjectLifecycle(app.write);
    expect(() => l.trash(agent, p.id, 'agent-delete', 0, p.name)).toThrow('本人');
    expect(() => l.trash(human, p.id, 'bad-confirm', 0, '错误名字')).toThrow('不一致');
    const before = l.trash(human, p.id, 'human-delete', 0, p.name);
    l.configure(human, 'set-retention', 1);
    expect(l.deletion(p.id).purgeAfter).toBe(before.purgeAfter);
    expect(l.retentionDays()).toBe(1);
  } finally {
    app.db.close();
  }
});
