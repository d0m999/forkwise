import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('卡片创建恢复不能复用标签初始null版本，最近40统一历史也包含Agent标签操作', () => {
  const m = openMapping(mkdtempSync(join(tmpdir(), 'forkwise-tags-history-')));
  const a = m.access.authenticate(m.access.issue('human', ['*']));
  const run = (type: string, payload: object, expected: unknown = null) => m.execute({ commandId: crypto.randomUUID(), projectId: 'p', type, payload, expected }, a);
  const read = () => m.read({ type: 'project', projectId: 'p' }, a);
  const travel = (direction: string) => run(direction, {}, read().project.revision);
  try {
    run('project.create', { name: '项目' }); run('thought.create', { id: 'c', title: '标题', text: '正文', x: 0, y: 0 }); run('tag.create', { id: 't', name: 'Tag' }); run('card.tags', { id: 'c', tagIds: ['t'] });
    travel('history.undo'); const emptyVersion = read().cards[0]!.cardTags!.versionId;
    travel('history.undo'); travel('history.undo'); travel('history.redo');
    const restored = read().cards[0]!;
    expect(restored.cardTags?.tagIds).toEqual([]); expect(restored.cardTags!.versionId).not.toBe(emptyVersion);
    travel('history.redo');
    expect(() => run('card.tags', { id: 'c', tagIds: ['t'] })).toThrow(/已更新/);
    run('card.tags', { id: 'c', tagIds: ['t'] }, restored.cardTags!.versionId);
    const originalBody = read().cards[0]!.body;
    for (let i = 0; i < 45; i++) run('tag.update', { id: 't', name: `T${i}` }, read().tags!.find(t => t.id === 't')!.versionId);
    expect(m.read({ type: 'history', projectId: 'p' }, a).undo).toHaveLength(40);
    for (let i = 0; i < 40; i++) travel('history.undo');
    expect(read().tags!.find(t => t.id === 't')!.name).toBe('T4');
    expect(() => travel('history.undo')).toThrow(/没有可撤销/);
    const agent = m.access.authenticate(m.access.issue('agent', ['p'], undefined, undefined, ['p']));
    m.execute({ commandId: 'agent-label', projectId: 'p', type: 'tag.update', expected: read().tags![0]!.versionId, payload: { id: 't', name: 'Agent label' } }, agent);
    expect(m.read({ type: 'history', projectId: 'p' }, a).undo.at(-1)?.actor.type).toBe('agent');
    travel('history.undo'); expect(read().tags![0]!.name).toBe('T4'); expect(read().cards[0]!.body).toEqual(originalBody);
  } finally { m.close(); }
});

it('删除标签在存储提交检查点失败时整批回滚，原幂等键可安全重试', () => {
  let fail = false;
  const m = openMapping(mkdtempSync(join(tmpdir(), 'forkwise-tags-rollback-')), { checkpoint: phase => { if (fail && phase === 'versions') throw new Error('存储检查点失败'); } });
  const a = m.access.authenticate(m.access.issue('human', ['*']));
  const run = (type: string, payload: object, expected: unknown = null) => m.execute({ commandId: crypto.randomUUID(), projectId: 'p', type, payload, expected }, a);
  const read = () => m.read({ type: 'project', projectId: 'p' }, a);
  try {
    run('project.create', { name: '项目' }); run('thought.create', { id: 'c', title: '标题', text: '正文', x: 0, y: 0 }); run('tag.create', { id: 't', name: 'Tag' }); run('card.tags', { id: 'c', tagIds: ['t'] });
    const before = read(), history = m.read({ type: 'history', projectId: 'p' }, a);
    const command = { commandId: 'delete-retry', projectId: 'p', type: 'tag.delete', expected: { tag: before.tags![0]!.versionId, cardTags: { c: before.cards[0]!.cardTags!.versionId } }, payload: { id: 't' } };
    fail = true; expect(() => m.execute(command, a)).toThrow('存储检查点失败'); fail = false;
    expect(read()).toEqual(before); expect(m.read({ type: 'history', projectId: 'p' }, a)).toEqual(history);
    const receipt = m.execute(command, a); expect(m.execute(command, a)).toEqual(receipt);
    run('history.undo', {}, read().project.revision); expect(read().cards[0]!.cardTags!.tagIds).toEqual(['t']);
  } finally { m.close(); }
});
