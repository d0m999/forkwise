import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';

it('根快照固定普通连线索引端点版本和创建序位', () => {
  const f = lifecycleFixture();
  try {
    const a = f.card('a'), b = f.card('b');
    const z = f.connector('z', f.bound(a.item.id, 'right'), f.bound(b.item.id, 'left'));
    const first = f.connector('a-line', f.free(-40, 60), f.bound(a.item.id, 'top'));
    const root = f.mapping.read({ type: 'map', projectId: 'p', view: 'index', budget: 4096 }, f.human);
    f.run({ type: 'connector.reconnect', expected: z.versionId, payload: { id: z.id, endpoint: 'end', value: f.free(300, 80) } });
    f.run({ type: 'connector.delete', expected: first.versionId, payload: { id: first.id } });
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    const query = { type: 'map' as const, projectId: 'p', view: 'connector-index' as const, snapshot: root.snapshot, budget: 4096 };
    const old = f.mapping.read(query, f.human);
    const index = (value: typeof z, order: number) => { const { kind: _, ...rest } = value; return { ...rest, type: 'connector', order }; };
    expect(old).toMatchObject({ snapshot: root.snapshot, revision: root.revision, totalItems: 2, scope: { types: ['connector'], relations: 'connectors', order: 'creation_ordinal' }, fidelity: 'connector-index', availability: 'available', coverage: { start: 0, end: 2, complete: true }, nextCursor: null });
    expect(old.items).toEqual([index(first, 1), index(z, 0)]);
    expect(root.scope).toEqual({ types: ['thought'], relations: 'not_implemented', order: 'creation_ordinal' });
    expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'index', snapshot: root.snapshot, budget: 4096 }, f.human)).toEqual(root);
    const fresh = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index', budget: 4096 }, f.human);
    const current = f.state().connectors!;
    expect(fresh.snapshot).not.toBe(root.snapshot); expect(fresh.revision).toBe(f.state().project.revision);
    expect(fresh.items).toEqual([index(current.find(value => value.id === first.id)!, 1), index(current.find(value => value.id === z.id)!, 0)]);
    for (const page of [root, old, fresh]) { expect(Buffer.byteLength(JSON.stringify(page))).toBe(page.bytes); expect(page.bytes).toBeLessThanOrEqual(4096); }
  } finally { f.close(); }
});


it('普通连线索引按完整字节预算分页且游标不得跨视图复用', () => {
  const f = lifecycleFixture();
  try {
    for (let index = 0; index < 12; index++) f.connector(`线😀"\\路径-${String(index).padStart(2, '0')}-` + '长身份'.repeat(25), f.free(index * 10, -index), f.free(200 + index, 80));
    const full = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index', budget: 65536 }, f.human);
    const budget = Math.ceil(full.bytes / 2), query = { type: 'map' as const, projectId: 'p', view: 'connector-index' as const, snapshot: full.snapshot, budget };
    let page = f.mapping.read(query, f.human), count = 0;
    const items: typeof full.items = [];
    expect(page.nextCursor).toEqual(expect.any(String));
    const cursor = page.nextCursor!;
    for (;;) {
      count++; expect(page.snapshot).toBe(full.snapshot); expect(page.revision).toBe(full.revision);
      expect(page.totalItems).toBe(12); expect(page.items.length).toBeGreaterThan(0);
      expect(page.coverage).toEqual({ start: items.length, end: items.length + page.items.length, complete: page.nextCursor === null });
      expect(Buffer.byteLength(JSON.stringify(page))).toBe(page.bytes); expect(page.bytes).toBeLessThanOrEqual(budget);
      items.push(...page.items); if (!page.nextCursor) break;
      page = f.mapping.read({ ...query, cursor: page.nextCursor }, f.human);
    }
    expect(count).toBeGreaterThan(1); expect(items).toEqual(full.items);
    expect(() => f.mapping.read({ ...query, view: 'index', cursor }, f.human)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    f.connector('new', f.free(0, 0), f.free(1, 1));
    const fresh = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index' }, f.human);
    expect(() => f.mapping.read({ ...query, snapshot: fresh.snapshot, cursor }, f.human)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    let requiredBytes = 0;
    try { f.mapping.read({ ...query, budget: 1 }, f.human); } catch (error) {
      expect(error).toMatchObject({ code: 'BUDGET_TOO_SMALL', details: { budgetUnit: 'utf8_bytes', requiredBytes: expect.any(Number) } });
      requiredBytes = (error as { details: { requiredBytes: number } }).details.requiredBytes;
    }
    expect(requiredBytes).toBeGreaterThan(1);
    expect(() => f.mapping.read({ ...query, budget: requiredBytes }, f.human)).toThrowError(expect.objectContaining({ code: 'ITEM_EXCEEDS_BUDGET' }));
  } finally { f.close(); }
});


it('普通连线索引及已知身份计入固定快照容量限制', () => {
  for (const deleted of [false, true]) {
    const f = lifecycleFixture({ compact: { maxSnapshotBytes: 3000 } });
    try {
      const root = f.mapping.read({ type: 'map', projectId: 'p', view: 'index' }, f.human);
      for (let index = 0; index < 40; index++) {
        const line = f.connector(`线-${index}-` + '身份'.repeat(30), f.free(index, -index), f.free(300, 200));
        if (deleted) f.run({ type: 'connector.delete', expected: line.versionId, payload: { id: line.id } });
      }
      expect(f.state().connectors).toHaveLength(deleted ? 0 : 40);
      expect(() => f.mapping.read({ type: 'map', projectId: 'p', view: 'index' }, f.human)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
      expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'index', snapshot: root.snapshot }, f.human)).toEqual(root);
    } finally { f.close(); }
  }
});


it('普通连线快照过期和同库重开后旧token明确失效', () => {
  let now = 1000000;
  const f = lifecycleFixture({ compact: { clock: () => now, snapshotTtlMs: 100 } });
  try {
    const line = f.connector('line', f.free(-20, 10), f.free(200, 80));
    const original = f.state();
    const root = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index' }, f.human);
    now = root.expiresAt;
    const query = { type: 'map' as const, projectId: 'p', view: 'connector-index' as const, snapshot: root.snapshot };
    expect(() => f.mapping.read(query, f.human)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' }));
    const fresh = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index' }, f.human);
    expect(fresh.snapshot).not.toBe(root.snapshot); expect(fresh.items).toEqual(root.items);
    f.reopen();
    expect(() => f.mapping.read({ ...query, snapshot: fresh.snapshot }, f.human)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' }));
    expect(f.state()).toEqual(original);
    expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'connector', id: line.id, versionId: line.versionId }, f.human)).toEqual(line);
    const reopened = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index' }, f.human);
    expect(reopened.items).toEqual(root.items); expect(reopened.revision).toBe(root.revision); expect(reopened.snapshot).not.toBe(fresh.snapshot);
  } finally { f.close(); }
});
