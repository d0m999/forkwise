import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('旧标签依据不能测量或删除新标签卡，卡片恢复分配新关联版本并保留标签与正文', () => {
  const m = openMapping(mkdtempSync(join(tmpdir(), 'forkwise-tags-guards-')));
  const a = m.access.authenticate(m.access.issue('human', ['*']));
  const run = (type: string, payload: object, expected: unknown = null) => m.execute({ commandId: crypto.randomUUID(), projectId: 'p', type, expected, payload }, a);
  const read = () => m.read({ type: 'project', projectId: 'p' }, a);
  try {
    run('project.create', { name: '项目' }); run('thought.create', { id: 'c', title: '卡片', text: '原文', x: 10, y: 20 }); run('tag.create', { id: 't', name: 'Tag' });
    const old = read().cards[0]!;
    const expected = { thought: old.versionId, body: old.body.versionId, pose: old.item.versionId, appearance: null };
    run('card.tags', { id: 'c', tagIds: ['t'] }); const tagged = read();
    expect(() => run('card.layout', { id: 'c', necessaryHeight: 88 }, expected)).toThrow(/依据已更新/);
    expect(read()).toEqual(tagged);
    expect(() => run('thought.delete', { id: 'c' }, expected)).toThrow(/依据已更新/);
    expect(read()).toEqual(tagged);
    const card = tagged.cards[0]!;
    run('thought.delete', { id: 'c' }, { ...expected, cardTags: card.cardTags!.versionId });
    expect(read().cards).toEqual([]);
    run('history.undo', {}, read().project.revision);
    const restored = read().cards[0]!;
    expect(restored.cardTags!.tagIds).toEqual(['t']); expect(restored.cardTags!.versionId).not.toBe(card.cardTags!.versionId);
    expect(restored.body.blocks).toEqual(card.body.blocks); expect(read().tags).toEqual(tagged.tags);
    expect(() => run('card.tags', { id: 'c', tagIds: [] }, card.cardTags!.versionId)).toThrow(/已更新/);
  } finally { m.close(); }
});
