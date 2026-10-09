import { it, expect } from 'vitest';
import { setup, statement, human } from './helpers.js';
import { syncProject, readWorkspace } from '../src/services/sync.js';
import { AssetService } from '../src/services/assets.js';
import { JobRepository } from '../src/repositories/jobs.js';

it('连续同步包含跨调用者变化和删除，布局单独变化不影响图谱修订', () => {
  const t = setup();
  try {
    t.write([statement('a'), statement('b')]);
    t.write([{ op: 'statement.edit', id: 'a', text: 'Agent 修改', scope: 'all' }], t.versions(), {
      id: 'another-agent',
      type: 'agent',
    });
    const assets = new AssetService(t.repo, t.service);
    assets.saveLayout(t.project.id, human, 'sync-layout-only', {
      expectedVersion: 0,
      data: { positions: { a: { x: 1, y: 2 } }, drawings: [] },
    });
    t.write([{ op: 'object.delete', id: 'b' }]);
    const sync = syncProject(t.repo, t.project.id, 1, 0);
    expect(sync.needsSnapshot).toBe(false);
    expect(sync.changes.map((c) => [c.revisionBefore, c.revisionAfter])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(sync.changes[0]!.upserted[0]!.data).toMatchObject({ text: 'Agent 修改' });
    expect(sync.changes[1]!.deletedIds).toEqual(['b']);
    expect(sync.layout?.version).toBe(1);
    const idle = syncProject(t.repo, t.project.id, 3, 1);
    expect(idle).toMatchObject({ changes: [], layout: null, needsSnapshot: false });
    assets.saveLayout(t.project.id, human, 'sync-layout-second', {
      expectedVersion: 1,
      data: { positions: { a: { x: 3, y: 2 } }, drawings: [] },
    });
    expect(syncProject(t.repo, t.project.id, 3, 1)).toMatchObject({
      revision: 3,
      changes: [],
      layout: { version: 2 },
    });
    const workspace = readWorkspace(t.repo, t.project.id);
    expect(workspace.state.project.revision).toBe(3);
    expect(workspace.layout.version).toBe(2);
  } finally {
    t.db.close();
  }
});

it('收据缺失、元数据修订断档、恢复到较早修订时明确要求完整读取', () => {
  const t = setup();
  try {
    t.write([statement('a')]);
    t.write([statement('b')]);
    t.db
      .prepare(
        "DELETE FROM operations WHERE project_id=? AND json_extract(response,'$.revisionAfter')=1",
      )
      .run(t.project.id);
    expect(syncProject(t.repo, t.project.id, 0, 0)).toMatchObject({
      needsSnapshot: true,
      changes: [],
    });
    expect(syncProject(t.repo, t.project.id, 3, 0)).toMatchObject({
      needsSnapshot: true,
      changes: [],
    });
    t.db
      .prepare('UPDATE projects SET revision=revision+1,name=? WHERE id=?')
      .run('元数据已变', t.project.id);
    t.write([statement('c')]);
    expect(syncProject(t.repo, t.project.id, 2, 0)).toMatchObject({
      needsSnapshot: true,
      changes: [],
    });
  } finally {
    t.db.close();
  }
});

it('同步最多返回 100 批变化，使用表达式索引，不以不完整变化覆盖当前状态', () => {
  const t = setup();
  try {
    for (let i = 0; i < 101; i++) t.write([statement('s' + i)]);
    expect(syncProject(t.repo, t.project.id, 0, 0)).toMatchObject({
      needsSnapshot: true,
      changes: [],
    });
    const next = syncProject(t.repo, t.project.id, 1, 0);
    expect(next.needsSnapshot).toBe(false);
    expect(next.changes).toHaveLength(100);
    const plan = t.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT response FROM operations WHERE project_id=? AND json_type(response,'$.upserted')='array' AND json_extract(response,'$.revisionAfter')>json_extract(response,'$.revisionBefore') AND json_extract(response,'$.revisionAfter')>? ORDER BY json_extract(response,'$.revisionAfter') LIMIT 101",
      )
      .all(t.project.id, 0);
    expect(JSON.stringify(plan)).toContain('operation_sync_revision');
  } finally {
    t.db.close();
  }
});

it('任务列表只读取摘要，详情保持原输入、输出和用量', () => {
  const t = setup();
  try {
    const jobs = new JobRepository(t.db),
      input = { text: '长材料'.repeat(100000) };
    const job = jobs.enqueue(t.project.id, 'research.verify', input, 'large-task');
    const active = jobs.claim(t.project.id, job.id)!;
    jobs.finish(active, 'succeeded', { answer: '原结果' }, null, { tokens: 12 });
    const list = jobs.summaries(t.project.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: 'succeeded', usage: { tokens: 12 } });
    expect(list[0]).not.toHaveProperty('input');
    expect(list[0]).not.toHaveProperty('output');
    expect(list[0]).not.toHaveProperty('runToken');
    expect(JSON.stringify(list).length).toBeLessThan(1000);
    expect(jobs.get(t.project.id, job.id)).toMatchObject({ input, output: { answer: '原结果' } });
  } finally {
    t.db.close();
  }
});
