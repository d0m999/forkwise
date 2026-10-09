import { it, expect } from 'vitest';
import { expectedVersions } from '../web/operation-versions.js';
import { applyChangeSet, applySync } from '../web/api-client.js';
import { setup, statement, inference } from './helpers.ts';

it('前端只携带关联版本，无关并发编辑可保存；变化不连续时不部分应用', () => {
  const t = setup();
  try {
    t.write([statement('a'), statement('b'), statement('c'), inference('i', ['a'], 'b')]);
    const old = t.repo.snapshot(t.project.id);
    const commands = [{ op: 'statement.edit', id: 'a', text: '新的 A', scope: 'all' }];
    const expected = expectedVersions(old.objects, commands);
    expect(expected).toEqual({ a: 1, i: 1 });
    t.write([{ op: 'statement.edit', id: 'c', text: '无关的 C', scope: 'all' }]);
    const result = t.write(commands, expected);
    expect(() => applyChangeSet(old, result)).toThrow('不连续');
    expect(old.objects.find((e) => e.id === 'a').data.text).toBe('a');
    expect(t.get('a').data.text).toBe('新的 A');
    expect(t.get('c').data.text).toBe('无关的 C');
  } finally {
    t.db.close();
  }
});
it('级联删除携带全部受影响对象版本，局部派生只固定所选推导', () => {
  const t = setup();
  try {
    t.write([
      statement('a'),
      statement('b'),
      statement('c'),
      inference('i', ['a'], 'b'),
      inference('j', ['a'], 'c'),
      { op: 'note.create', id: 'n', targetId: 'i', text: '推导笔记' },
      {
        op: 'condition.create',
        id: 'cond',
        data: { description: '定性条件', mode: 'qualitative', targetIds: ['i', 'j'] },
      },
    ]);
    const objects = t.repo.snapshot(t.project.id).objects;
    expect(
      expectedVersions(objects, [{ op: 'statement.derive', id: 'a', inferenceIds: ['i'] }]),
    ).toEqual({ a: 1, i: 1 });
    const commands = [{ op: 'object.delete', id: 'a' }];
    const expected = expectedVersions(objects, commands);
    expect(Object.keys(expected).sort()).toEqual(['a', 'cond', 'i', 'j', 'n']);
    expect(t.write(commands, expected).deletedIds.sort()).toEqual(['a', 'i', 'j', 'n']);
    expect(t.get('cond').data.targetIds).toEqual([]);
  } finally {
    t.db.close();
  }
});

it('同步整批校验，后半段断档不能使旧快照被部分修改', () => {
  const t = setup();
  try {
    const initial = t.repo.snapshot(t.project.id);
    const first = t.write([statement('a')]);
    const second = t.write([statement('b')]);
    expect(() =>
      applySync(initial, {
        projectId: t.project.id,
        revision: 3,
        changes: [first, { ...second, revisionBefore: 2 }],
        needsSnapshot: false,
      }),
    ).toThrow('不连续');
    expect(initial.objects).toEqual([]);
    expect(initial.project.revision).toBe(0);
    const next = applySync(initial, {
      projectId: t.project.id,
      revision: 2,
      changes: [first, second],
      needsSnapshot: false,
    });
    expect(next.objects.map((e) => e.id)).toEqual(['a', 'b']);
    expect(next.project.revision).toBe(2);
    expect(() =>
      applySync(initial, {
        projectId: t.project.id,
        revision: 2,
        changes: [first],
        needsSnapshot: false,
      }),
    ).toThrow('不完整');
  } finally {
    t.db.close();
  }
});
