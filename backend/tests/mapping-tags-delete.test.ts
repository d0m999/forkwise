import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('删除标签复核版本和完整关联范围；一次撤销恢复身份颜色和每卡原位且重开仍可重做', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-tags-delete-'));
  let m = openMapping(directory);
  const token = m.access.issue('human', ['*']);
  let actor = m.access.authenticate(token);
  const run = (type: string, payload: object, expected: unknown = null) => m.execute({ commandId: crypto.randomUUID(), projectId: 'p', type, expected, payload }, actor);
  const read = () => m.read({ type: 'project', projectId: 'p' }, actor);
  try {
    run('project.create', { name: '项目' });
    for (const id of ['a', 'b', 'c']) run('thought.create', { id, title: id, text: '正文不变', x: 1, y: 2 });
    for (const id of ['one', 'two', 'three']) run('tag.create', { id, name: id });
    const one = read().tags!.find(t => t.id === 'one')!;
    run('tag.update', { id: 'one', name: '保留写法', color: '#e8dff0' }, one.versionId);
    for (const [id, tagIds] of [['a', ['two', 'one', 'three']], ['b', ['one', 'two']]] as const) run('card.tags', { id, tagIds });
    const before = read();
    const confirmation = { tag: before.tags!.find(t => t.id === 'one')!.versionId, cardTags: Object.fromEntries(before.cards.filter(c => c.cardTags?.tagIds.includes('one')).map(c => [c.id, c.cardTags!.versionId])) };
    const other = openMapping(directory);
    try {
      const a2 = other.access.authenticate(token);
      for (const [id, tagIds] of [['b', ['two']], ['c', ['one']]] as const) {
        const card = other.read({ type: 'project', projectId: 'p' }, a2).cards.find(c => c.id === id)!;
        other.execute({ commandId: crypto.randomUUID(), projectId: 'p', type: 'card.tags', expected: card.cardTags?.versionId ?? null, payload: { id, tagIds } }, a2);
      }
    } finally { other.close(); }
    const changed = read();
    expect(() => run('tag.delete', { id: 'one' }, confirmation)).toThrow(/重新确认/);
    expect(read()).toEqual(changed);
    const currentConfirmation = { tag: changed.tags!.find(t => t.id === 'one')!.versionId, cardTags: Object.fromEntries(changed.cards.filter(c => c.cardTags?.tagIds.includes('one')).map(c => [c.id, c.cardTags!.versionId])) };
    const receipt = run('tag.delete', { id: 'one' }, currentConfirmation);
    const deleted = read();
    expect(deleted.tags!.find(t => t.id === 'one')).toMatchObject({ id: 'one', name: '保留写法', color: '#e8dff0', deleted: true });
    expect(deleted.cards.map(c => c.cardTags!.tagIds)).toEqual([['two', 'three'], ['two'], []]);
    expect(m.read({ type: 'history', projectId: 'p' }, actor).undo.at(-1)?.id).toBe(receipt.commandId);
    run('history.undo', { actionId: receipt.commandId }, deleted.project.revision);
    const restored = read();
    expect(restored.cards.map(c => c.cardTags!.tagIds)).toEqual([['two', 'one', 'three'], ['two'], ['one']]);
    expect(restored.tags!.find(t => t.id === 'one')).toMatchObject({ name: '保留写法', color: '#e8dff0', deleted: false });
    expect(restored.cards.map(c => [c.body, c.item, c.title])).toEqual(changed.cards.map(c => [c.body, c.item, c.title]));
    const domains = m.observe({ projectId: 'p', afterRevision: receipt.revision - 1 }, actor).changes[0]!.domains;
    expect(domains.map(d => [d.domain, d.id])).toEqual([['tag', 'one'], ['cardTags', 'cardTags:a'], ['cardTags', 'cardTags:c']]);
    m.close(); m = openMapping(directory); actor = m.access.authenticate(token);
    run('history.redo', { actionId: receipt.commandId }, read().project.revision);
    expect(read().cards.map(c => c.cardTags!.tagIds)).toEqual([['two', 'three'], ['two'], []]);
  } finally { m.close(); }
});
