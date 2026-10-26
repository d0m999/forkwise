import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import type { DetailChunk } from '../src/mapping/compact-contracts.js';

it('普通连线详情固定不可变版本且删除与未知身份明确区分', () => {
  const f = lifecycleFixture();
  try {
    const a = f.card('a'), b = f.card('b');
    const original = f.connector('line', f.bound(a.item.id, 'top'), f.free(200, -80));
    const root = f.mapping.read({ type: 'map', projectId: 'p', view: 'index' }, f.human);
    f.run({ type: 'connector.reconnect', expected: original.versionId, payload: { id: original.id, endpoint: 'end', value: f.bound(b.item.id, 'left') } });
    const changed = f.state().connectors![0]!;
    f.run({ type: 'connector.delete', expected: changed.versionId, payload: { id: changed.id } });
    const deletedRoot = f.mapping.read({ type: 'map', projectId: 'p', view: 'index' }, f.human);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    const restored = f.state().connectors![0]!;
    const read = (snapshot: string, connectorId = original.id) => f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-detail', connectorId, snapshot, budget: 4096 }, f.human);
    const old = read(root.snapshot);
    expect(old).toMatchObject({ snapshot: root.snapshot, revision: root.revision, scope: { types: ['connector'], relations: 'connectors' }, fidelity: 'lossless_json_chunks', availability: 'available', target: { connectorId: original.id, versionId: original.versionId }, nextCursor: null });
    expect(JSON.parse((old.items as DetailChunk[]).map(value => value.jsonText).join(''))).toEqual(original);
    const deleted = read(deletedRoot.snapshot), absent = read(deletedRoot.snapshot, 'never');
    expect(deleted).toMatchObject({ availability: 'deleted', target: { connectorId: original.id }, totalItems: 0, items: [], coverage: { start: 0, end: 0, complete: true }, nextCursor: null });
    expect(absent).toMatchObject({ availability: 'not_found', target: { connectorId: 'never' }, items: [] });
    const current = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index' }, f.human);
    const fresh = read(current.snapshot);
    expect(fresh.target).toEqual({ connectorId: original.id, versionId: restored.versionId });
    expect(JSON.parse((fresh.items as DetailChunk[]).map(value => value.jsonText).join(''))).toEqual(restored);
    expect(read(root.snapshot)).toEqual(old); expect(read(deletedRoot.snapshot)).toEqual(deleted);
    for (const page of [old, deleted, absent, fresh]) { expect(Buffer.byteLength(JSON.stringify(page))).toBe(page.bytes); expect(page.bytes).toBeLessThanOrEqual(4096); }
  } finally { f.close(); }
});


it('普通连线详情Unicode与转义身份按字节预算无损分块重建', () => {
  const f = lifecycleFixture();
  try {
    const id = '🧠"\\路径\n'.repeat(18);
    const original = f.connector(id, f.free(-0.125, 1e100), f.free(300.5, -200.75));
    f.connector('other', f.free(0, 0), f.free(1, 1));
    const root = f.mapping.read({ type: 'map', projectId: 'p', view: 'index' }, f.human);
    const query = { type: 'map' as const, projectId: 'p', view: 'connector-detail' as const, connectorId: id, snapshot: root.snapshot };
    const full = f.mapping.read({ ...query, budget: 65536 }, f.human), budget = full.bytes - 1;
    let page = f.mapping.read({ ...query, budget }, f.human), pageCount = 0;
    expect(page.nextCursor).toEqual(expect.any(String)); const cursor = page.nextCursor!;
    f.run({ type: 'connector.path', expected: original.versionId, payload: { id, path: 'elbow' } });
    const chunks: DetailChunk[] = [];
    for (;;) {
      pageCount++; expect(page.snapshot).toBe(root.snapshot); expect(page.revision).toBe(root.revision);
      expect(page.target).toEqual({ connectorId: id, versionId: original.versionId });
      expect(page.coverage).toEqual({ start: chunks.length, end: chunks.length + page.items.length, complete: page.nextCursor === null });
      expect(page.items.length).toBeGreaterThan(0); expect(Buffer.byteLength(JSON.stringify(page))).toBe(page.bytes); expect(page.bytes).toBeLessThanOrEqual(budget);
      for (const chunk of page.items as DetailChunk[]) { expect(chunk.chunkIndex).toBe(chunks.length); expect(chunk.chunkCount).toBe(full.totalItems); expect(Array.from(chunk.jsonText).length).toBeLessThanOrEqual(128); chunks.push(chunk); }
      if (!page.nextCursor) break;
      page = f.mapping.read({ ...query, budget, cursor: page.nextCursor }, f.human);
    }
    expect(pageCount).toBeGreaterThan(1); expect(chunks).toHaveLength(full.totalItems);
    expect(JSON.parse(chunks.map(value => value.jsonText).join(''))).toEqual(original);
    expect(() => f.mapping.read({ ...query, connectorId: 'other', budget, cursor }, f.human)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  } finally { f.close(); }
});
