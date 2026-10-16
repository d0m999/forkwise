import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('共享改名改色拒绝撞名，单卡关联保序且统一历史只恢复自己的标签域', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-tags-edit-'));
  const m = openMapping(directory), a = m.access.authenticate(m.access.issue('human', ['*']));
  const run = (type: string, payload: object, expected: unknown = null) => m.execute({ commandId: crypto.randomUUID(), projectId: 'p', type, payload, expected }, a);
  const read = () => m.read({ type: 'project', projectId: 'p' }, a);
  const undo = () => run('history.undo', {}, read().project.revision);
  try {
    run('project.create', { name: '项目' });
    for (const id of ['c1', 'c2']) run('thought.create', { id, title: id, text: '完整正文', x: 0, y: 0 });
    run('tag.create', { id: 'ai', name: 'AI' }); run('tag.create', { id: 'macro', name: 'Macro' });
    for (const id of ['c1', 'c2']) run('card.tags', { id, tagIds: ['ai', 'macro'] });
    const before = read();
    const ai = before.tags!.find(t => t.id === 'ai')!;
    run('tag.update', { id: 'ai', name: 'Ai', color: '#d9e7f1' }, ai.versionId);
    const colored = read(), updated = colored.tags!.find(t => t.id === 'ai')!;
    expect(updated).toMatchObject({ name: 'Ai', color: '#d9e7f1' });
    expect(colored.cards).toEqual(before.cards);
    const unchanged = run('tag.update', { id: 'ai', color: '#d9e7f1' }, updated.versionId);
    expect(unchanged.changedIds).toEqual([]); expect(read()).toEqual(colored);
    expect(() => run('tag.update', { id: 'ai', name: 'macro' }, updated.versionId)).toThrow(/重复/);
    expect(() => run('tag.update', { id: 'ai', color: '#123456' }, updated.versionId)).toThrow();
    const c = colored.cards[0]!;
    run('card.tags', { id: 'c1', tagIds: ['macro', 'ai'] }, c.cardTags!.versionId);
    expect(read().cards.map(c => c.cardTags!.tagIds)).toEqual([['macro', 'ai'], ['ai', 'macro']]);
    undo(); expect(read().cards.map(c => c.cardTags!.tagIds)).toEqual([['ai', 'macro'], ['ai', 'macro']]);
    expect(read().tags).toEqual(colored.tags);
    undo(); expect(read().tags!.find(t => t.id === 'ai')).toMatchObject({ name: 'AI', color: '#f1f0ec' });
    expect(read().cards.map(c => c.body)).toEqual(before.cards.map(c => c.body));
    const events = m.observe({ projectId: 'p', afterRevision: colored.project.revision }, a).changes;
    expect(events.some(c => c.domains.some(d => d.domain === 'cardTags'))).toBe(true);
    expect(events.some(c => c.domains.some(d => d.domain === 'tag'))).toBe(true);
  } finally { m.close(); }
});
