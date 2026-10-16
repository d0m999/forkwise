import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('完整关联顺序和标签名称颜色墓碑只从同一固定snapshot分页读取，旧snapshot不混新名字', () => {
  const m = openMapping(mkdtempSync(join(tmpdir(), 'forkwise-tags-snapshot-')));
  const a = m.access.authenticate(m.access.issue('human', ['*']));
  const run = (type: string, payload: object, expected: unknown = null) => m.execute({ commandId: crypto.randomUUID(), projectId: 'p', type, payload, expected }, a);
  try {
    run('project.create', { name: '项目' }); run('thought.create', { id: 'c', title: '完整标题', text: '完整正文', x: 10, y: 20 });
    for (const id of ['z', 'a', 'm']) run('tag.create', { id, name: id.repeat(30) });
    run('card.tags', { id: 'c', tagIds: ['z', 'a', 'm'] });
    const old = m.read({ type: 'map', view: 'index', projectId: 'p' }, a);
    expect(old.items[0]).toMatchObject({ cardTags: { tagIds: ['z', 'a', 'm'] } });
    const tagPage = m.read({ type: 'map', view: 'tags', projectId: 'p', snapshot: old.snapshot, budget: 850 }, a);
    expect(tagPage.nextCursor).not.toBeNull();
    const tag = m.read({ type: 'project', projectId: 'p' }, a).tags!.find(t => t.id === 'a')!;
    run('tag.update', { id: 'a', name: '新名称', color: '#d9e7f1' }, tag.versionId);
    const items = [...tagPage.items]; let next = tagPage.nextCursor;
    while (next) {
      const page = m.read({ type: 'map', view: 'tags', projectId: 'p', snapshot: old.snapshot, cursor: next, budget: 850 }, a);
      expect(page.revision).toBe(old.revision); expect(page.bytes).toBeLessThanOrEqual(850);
      items.push(...page.items); next = page.nextCursor;
    }
    expect(items).toMatchObject([{ id: 'a', name: 'a'.repeat(30), color: '#f1f0ec' }, { id: 'm' }, { id: 'z' }]);
    const current = m.read({ type: 'map', view: 'index', projectId: 'p' }, a);
    const latest = m.read({ type: 'map', view: 'tags', projectId: 'p', snapshot: current.snapshot }, a);
    expect(latest.items[0]).toMatchObject({ id: 'a', name: '新名称', color: '#d9e7f1' });
    expect(latest.snapshot).toBe(current.snapshot); expect(latest.revision).toBe(current.revision);
    const card = m.read({ type: 'project', projectId: 'p' }, a).cards[0]!;
    run('tag.delete', { id: 'a' }, { tag: (latest.items[0] as { versionId: string }).versionId, cardTags: { c: card.cardTags!.versionId } });
    expect(m.read({ type: 'map', view: 'tags', projectId: 'p' }, a).items[0]).toMatchObject({ id: 'a', name: '新名称', deleted: true });
  } finally { m.close(); }
});
