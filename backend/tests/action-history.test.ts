import { ArchiveSchema } from '../src/contracts/assets.js';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { setup, human, statement, inference } from './helpers.js';
import { readLayout } from '../src/repositories/layout.js';

test('一次撤销恢复删除前的主张、连带推导、立场与布局，重做保留审计和递增版本', () => {
  const s = setup();
  try {
    s.write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
    s.write([{ op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '已核对依据' } }]);
    s.service.execute(s.project.id, human, randomUUID(), {
      expected: {},
      commands: [],
      layout: {
        expectedVersion: 0,
        data: {
          positions: { a: { x: 120, y: 90 }, i: { x: 460, y: 90 } },
          drawings: [],
        },
      },
    });
    const original = s.get('a');
    s.write([{ op: 'object.delete', id: 'a' }]);
    expect(s.get('a')).toBeUndefined();
    expect(s.get('i')).toBeUndefined();
    const travel = (direction: 'undo' | 'redo') =>
      s.service.travel(s.project.id, human, randomUUID(), {
        direction,
        expectedRevision: s.repo.project(s.project.id).revision,
        expectedHistoryVersion: s.service.history(s.project.id).version,
        expectedLayoutVersion: readLayout(s.repo, s.project.id).version,
      });
    const restored = travel('undo');
    expect(restored.upserted.map((e) => e.id).sort()).toEqual(['a', 'i']);
    expect(s.get('a').data).toEqual(original.data);
    expect(s.get('a').contentVersionId).toBe(original.contentVersionId);
    expect(s.get('a').version).toBe(4);
    expect(readLayout(s.repo, s.project.id).data.positions).toEqual({
      a: { x: 120, y: 90 },
      i: { x: 460, y: 90 },
    });
    expect(travel('redo').deletedIds.sort()).toEqual(['a', 'i']);
    expect(s.repo.history(s.project.id, 'a')).toHaveLength(5);
    expect(s.service.history(s.project.id).redo).toBeNull();
  } finally {
    s.db.close();
  }
});

test('连续撤销和重做、导入材料例外、无变化保存与新分支都遵守同一历史顺序', () => {
  const s = setup();
  try {
    const travel = (direction: 'undo' | 'redo', key = randomUUID()) =>
      s.service.travel(s.project.id, human, key, {
        direction,
        expectedRevision: s.repo.project(s.project.id).revision,
        expectedHistoryVersion: s.service.history(s.project.id).version,
        expectedLayoutVersion: readLayout(s.repo, s.project.id).version,
      });
    s.write([statement('a')]);
    s.write([{ op: 'statement.edit', id: 'a', text: '改写后', scope: 'all' }]);
    const status = s.service.history(s.project.id);
    s.write([{ op: 'statement.edit', id: 'a', text: '改写后', scope: 'all' }]);
    s.write([
      {
        op: 'source.create',
        id: 's',
        data: { title: '保存材料', publisher: '作者', rights: 'public' },
      },
      {
        op: 'source.import',
        id: 'v',
        sourceId: 's',
        text: '材料继续保留',
        retrievedAt: '2026-10-01T00:00:00Z',
        publishedAt: null,
      },
    ]);
    expect(s.service.history(s.project.id)).toEqual(status);
    travel('undo');
    expect(s.get('a').data).toMatchObject({ text: 'a' });
    travel('undo');
    expect(s.get('a')).toBeUndefined();
    expect(s.repo.material(s.project.id, 'v')).toBe('材料继续保留');
    travel('redo');
    expect(s.get('a').data).toMatchObject({ text: 'a' });
    travel('redo');
    expect(s.get('a').data).toMatchObject({ text: '改写后' });
    travel('undo');
    s.write([{ op: 'statement.edit', id: 'a', text: '另一分支', scope: 'all' }]);
    expect(s.service.history(s.project.id).redo).toBeNull();
    expect(s.repo.history(s.project.id, 'a')).toHaveLength(8);
  } finally {
    s.db.close();
  }
});

test('撤销请求按版本拒绝并发、同键重试只返回原结果，Agent 不能恢复本人判断', () => {
  const s = setup();
  try {
    s.write([statement('a')]);
    const input = {
      direction: 'undo',
      expectedRevision: 1,
      expectedHistoryVersion: s.service.history(s.project.id).version,
      expectedLayoutVersion: 0,
    };
    s.write([statement('b')]);
    expect(() => s.service.travel(s.project.id, human, randomUUID(), input)).toThrow(
      '研究或画布已变化',
    );
    const current = {
      ...input,
      expectedRevision: 2,
      expectedHistoryVersion: s.service.history(s.project.id).version,
    };
    expect(() =>
      s.service.travel(s.project.id, { id: 'external', type: 'agent' }, randomUUID(), current),
    ).toThrow('本人执行');
    const key = randomUUID(),
      first = s.service.travel(s.project.id, human, key, current);
    expect(s.service.travel(s.project.id, human, key, current)).toEqual(first);
    expect(s.service.operation(s.project.id, human, key)).toEqual(first);
    expect(s.repo.history(s.project.id, 'b')).toHaveLength(2);
  } finally {
    s.db.close();
  }
});

test('仅视口和草稿保存不进入历史，布局撤销保持当前草稿；最近 40 步和重做随资产恢复', async () => {
  const { AssetService } = await import('../src/services/assets.js');
  const { ArchiveService } = await import('../src/services/archive.js');
  const { SearchRepository } = await import('../src/repositories/search.js');
  const s = setup(),
    restored = setup();
  try {
    const assets = new AssetService(s.repo, s.service);
    s.write([statement('a')]);
    for (let i = 0; i < 42; i++)
      s.write([{ op: 'statement.edit', id: 'a', text: `修改 ${i}`, scope: 'all' }]);
    const save = (x: number, draft: string) =>
      assets.saveLayout(s.project.id, human, randomUUID(), {
        expectedVersion: readLayout(s.repo, s.project.id).version,
        data: {
          positions: { a: { x, y: 12 } },
          drawings: [],
          canvas: {
            scenes: {},
            annotations: { elements: [], files: {} },
            drafts: { mine: { text: draft } },
          },
        },
      });
    save(120, '旧草稿');
    const version = s.service.history(s.project.id).version;
    save(120, '当前未提交输入');
    expect(s.service.history(s.project.id).version).toBe(version);
    s.service.travel(s.project.id, human, randomUUID(), {
      direction: 'undo',
      expectedRevision: s.repo.project(s.project.id).revision,
      expectedHistoryVersion: version,
      expectedLayoutVersion: readLayout(s.repo, s.project.id).version,
    });
    expect(readLayout(s.repo, s.project.id).data.canvas?.drafts).toEqual({
      mine: { text: '当前未提交输入' },
    });
    const archive = assets.export(s.project.id);
    expect(archive.actionHistory.entries).toHaveLength(40);
    new ArchiveService(restored.service, new SearchRepository(restored.repo)).import(
      human,
      randomUUID(),
      archive,
    );
    expect(restored.service.history(s.project.id)).toEqual(s.service.history(s.project.id));
    const revision = restored.repo.project(s.project.id).revision;
    restored.service.travel(s.project.id, human, randomUUID(), {
      direction: 'redo',
      expectedRevision: revision,
      expectedHistoryVersion: version + 1,
      expectedLayoutVersion: readLayout(restored.repo, s.project.id).version,
    });
    expect(readLayout(restored.repo, s.project.id).data.positions.a).toEqual({ x: 120, y: 12 });
    const damaged = structuredClone(archive);
    damaged.actionHistory.entries[0]!.objects[0]!.after = 'missing_version';
    expect(() =>
      new ArchiveService(restored.service, new SearchRepository(restored.repo)).validate(
        ArchiveSchema.parse(damaged),
      ),
    ).toThrow('撤销历史');
  } finally {
    s.db.close();
    restored.db.close();
  }
});

test('撤销落盘中途失败不改变图谱、布局、游标或回执，重启后仍可重做', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-history-'));
  const path = join(directory, 'research.sqlite'),
    s = setup(path),
    id = s.project.id;
  let reopened: ReturnType<typeof setup> | undefined;
  try {
    s.write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
    s.write([{ op: 'object.delete', id: 'a' }]);
    const before = s.repo.snapshot(id),
      history = s.service.history(id),
      key = randomUUID();
    const request = {
      direction: 'undo',
      expectedRevision: before.project.revision,
      expectedHistoryVersion: history.version,
      expectedLayoutVersion: 0,
    };
    // SQLite failure injection after at least one entity has already been restored.
    s.db.exec(
      "CREATE TRIGGER interrupt_history BEFORE INSERT ON versions WHEN NEW.entity_id='i' AND NEW.version=3 BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END",
    );
    expect(() => s.service.travel(id, human, key, request)).toThrow('simulated disk');
    expect(s.repo.snapshot(id)).toEqual(before);
    expect(s.service.history(id)).toEqual(history);
    expect(() => s.service.operation(id, human, key)).toThrow('尚未找到');
    s.db.exec('DROP TRIGGER interrupt_history');
    s.service.travel(id, human, key, request);
    s.db.close();
    reopened = setup(path);
    expect(reopened.service.history(id).redo?.label).toBe('删除研究对象');
    reopened.service.travel(id, human, randomUUID(), {
      direction: 'redo',
      expectedRevision: reopened.repo.project(id).revision,
      expectedHistoryVersion: reopened.service.history(id).version,
      expectedLayoutVersion: 0,
    });
    expect(reopened.repo.snapshot(id).objects.map((e) => e.id)).toEqual(['b']);
  } finally {
    if (s.db.open) s.db.close();
    reopened?.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('撤销内容和规则编辑恢复旧证据适用性与人工评估，保持立场独立', async () => {
  const { verificationCurrent } = await import('../src/domain/verification.js');
  const s = setup();
  try {
    s.write([
      statement('a'),
      {
        op: 'condition.create',
        id: 'c',
        data: { description: '需求持续增长', mode: 'qualitative', targetIds: ['a'] },
      },
    ]);
    const claim = s.get('a'),
      rule = s.get('c');
    s.write([
      {
        op: 'verification.confirm',
        id: 'node',
        target: { id: 'a', versionId: claim.contentVersionId },
        context: [],
        details: { event: '披露下一期报告', goal: '核对需求增长', period: null, date: null },
      },
      {
        op: 'evaluation.confirm',
        id: 'evaluation',
        condition: { id: 'c', versionId: rule.contentVersionId },
        verdict: 'unknown',
        reason: '尚缺报告',
        evidenceIds: [],
        citations: [],
      },
      { op: 'stance.set', id: 'a', stance: { value: 'questioned', reason: '本人仍有疑问' } },
    ]);
    const before = s.repo.snapshot(s.project.id);
    s.write([
      { op: 'statement.edit', id: 'a', text: '需求下降', scope: 'all' },
      {
        op: 'condition.edit',
        id: 'c',
        scope: 'all',
        data: { description: '需求转弱', mode: 'qualitative', targetIds: ['a'] },
      },
    ]);
    const node = s.get('node');
    if (node.kind !== 'verification_node') throw Error('missing node');
    expect(
      verificationCurrent(
        new Map(s.repo.snapshot(s.project.id).objects.map((e) => [e.id, e])),
        node,
      ),
    ).toBe(false);
    s.service.travel(s.project.id, human, randomUUID(), {
      direction: 'undo',
      expectedRevision: s.repo.project(s.project.id).revision,
      expectedHistoryVersion: s.service.history(s.project.id).version,
      expectedLayoutVersion: 0,
    });
    const after = s.repo.snapshot(s.project.id);
    expect(verificationCurrent(new Map(after.objects.map((e) => [e.id, e])), node)).toBe(true);
    expect(s.get('c').contentVersionId).toBe(rule.contentVersionId);
    expect(s.get('evaluation')).toEqual(before.objects.find((e) => e.id === 'evaluation'));
    expect(s.get('a').data).toMatchObject({
      text: 'a',
      stance: { value: 'questioned', reason: '本人仍有疑问' },
    });
  } finally {
    s.db.close();
  }
});
