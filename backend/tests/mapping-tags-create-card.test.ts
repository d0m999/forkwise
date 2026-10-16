import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('写字板创建或复用标签并添加当前卡是单次原子动作，撤销不删除复用标签且失败无半建标签', () => {
  const m = openMapping(mkdtempSync(join(tmpdir(), 'forkwise-tags-create-card-')));
  const a = m.access.authenticate(m.access.issue('human', ['*']));
  const run = (type: string, payload: object, expected: unknown = null) => m.execute({ commandId: crypto.randomUUID(), projectId: 'p', type, payload, expected }, a);
  const read = () => m.read({ type: 'project', projectId: 'p' }, a);
  const undo = () => run('history.undo', {}, read().project.revision);
  try {
    run('project.create', { name: '项目' }); for (const id of ['a', 'b']) run('thought.create', { id, title: id, text: '正文', x: 0, y: 0 });
    const first = read();
    const created = run('tag.create', { id: 't', name: 'AI', cardId: 'a' }, { cardTags: null });
    expect(read().cards[0]!.cardTags?.tagIds).toEqual(['t']); expect(read().cards[1]!.cardTags).toBeUndefined();
    expect(read().tags).toMatchObject([{ id: 't', name: 'AI', color: '#f1f0ec' }]);
    expect(read().project.revision).toBe(first.project.revision + 1);
    expect(m.read({ type: 'history', projectId: 'p' }, a).undo.at(-1)?.id).toBe(created.commandId);
    undo(); expect(read().cards[0]!.cardTags!.tagIds).toEqual([]); expect(read().tags![0]!.deleted).toBe(true);
    run('history.redo', {}, read().project.revision); expect(read().cards[0]!.cardTags!.tagIds).toEqual(['t']);
    const before = read();
    expect(() => run('tag.create', { id: 'failed', name: '未创建', cardId: 'a' }, { cardTags: null })).toThrow(/已更新/); expect(read()).toEqual(before);
    run('tag.create', { id: 'ignored', name: 'ai', cardId: 'b' }, { cardTags: null });
    expect(read().tags).toHaveLength(1); expect(read().tags![0]!.name).toBe('AI'); expect(read().cards[1]!.cardTags!.tagIds).toEqual(['t']);
    undo(); expect(read().cards[1]!.cardTags!.tagIds).toEqual([]); expect(read().cards[0]!.cardTags!.tagIds).toEqual(['t']); expect(read().tags![0]!.deleted).toBe(false);
    const card = read().cards[0]!, unchanged = read();
    expect(run('tag.create', { id: 'ignored2', name: 'Ai', cardId: 'a' }, { cardTags: card.cardTags!.versionId }).changedIds).toEqual([]);
    expect(read()).toEqual(unchanged);
  } finally { m.close(); }
});
