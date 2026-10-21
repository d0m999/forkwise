import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { CompactPage, DetailChunk } from '../src/mapping/compact-contracts.js';

it('笔迹完整路径按根快照固定内容版本无损分页，增删隔离、游标边界和 SQLite 重开保持明确', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-stroke-detail-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    const rootRead = () => mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 16384 }, human);
    const budget = 8192;
    const detail = (snapshot: string, strokeId: string, cursor?: string) => mapping.read({ type: 'map', view: 'stroke-detail',
      projectId: 'p', snapshot, strokeId, budget, ...(cursor ? { cursor } : {}) }, human);
    const failure = (read: () => unknown, code: string) => {
      let error: unknown;
      try { read(); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code });
    };
    const assertBytes = (page: CompactPage) => {
      expect(page.budgetUnit).toBe('utf8_bytes');
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
      expect(page.bytes).toBeLessThanOrEqual(budget);
    };
    run({ type: 'project.create', expected: null, payload: { name: '无损笔迹🧠' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'card', title: '原卡', text: '正文保留', x: 400, y: 500 } });
    run({ type: 'text.create', expected: null, payload: { id: 'text',
      content: { runs: [{ text: '独立文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 120 },
      pose: { x: 200, y: 100, width: 120, height: 60 } } });
    run({ type: 'shape.create', expected: null, payload: { id: 'shape',
      content: { shapeType: 'triangle', shortText: '原形状', fill: '#dce8dd', stroke: '#403b36', strokeWidth: 2 },
      pose: { x: 20, y: -80, width: 140, height: 120 } } });
    const a = { id: 'A-普通笔🧠', content: { penKind: 'pen',
      path: Array.from({ length: 4097 }, (_, index) => ({ x: 1 + index / 16, y: 1 + index % 8 })),
      color: '#123456', width: 2, opacity: 1 }, pose: { x: -120.5, y: 240.25, width: 260, height: 10 } };
    run({ type: 'stroke.create', expected: null, payload: a });
    const before = state();
    const original = before.strokes![0]!;
    const root = rootRead();
    expect(root.scope.types).toEqual(['thought']);
    expect(root.items).toHaveLength(1);
    expect(root.revision).toBe(before.project.revision);
    const first = detail(root.snapshot, a.id);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.totalItems).toBeGreaterThan(first.items.length);

    run({ type: 'stroke.delete', expected: { stroke: original.versionId, pose: original.item.versionId }, payload: { id: a.id } });
    const b = { id: 'B-荧光笔', content: { penKind: 'highlighter', path: [{ x: 6, y: 6 }, { x: 40, y: 6 }, { x: 74, y: 16 }],
      color: '#ffe08a', width: 12, opacity: 0.4 }, pose: { x: 80, y: -35, width: 80, height: 22 } };
    run({ type: 'stroke.create', expected: null, payload: b });
    const current = state();
    const added = current.strokes![0]!;
    expect(current.strokes!.map(value => value.id)).toEqual([b.id]);
    for (const field of ['cards', 'texts', 'shapes', 'tags'] as const) expect(current[field]).toEqual(before[field]);
    const oldIndex = mapping.read({ type: 'map', view: 'stroke-index', projectId: 'p', snapshot: root.snapshot }, human);
    expect(oldIndex.items).toEqual([{ id: a.id, type: 'stroke', versionId: original.versionId, order: 0, item: original.item,
      content: { penKind: 'pen', color: '#123456', width: 2, opacity: 1, pointCount: 4097, availability: 'not_fetched' } }]);
    const collect = (initial: CompactPage, strokeId: string, snapshot: string, revision: number, versionId: string) => {
      const chunks: DetailChunk[] = [];
      let page = initial;
      let pageCount = 0;
      for (;;) {
        pageCount++;
        expect(page).toMatchObject({ scope: { types: ['stroke'] }, snapshot, revision, fidelity: 'lossless_json_chunks',
          availability: 'available', target: { strokeId, versionId } });
        expect(page.totalItems).toBe(initial.totalItems);
        expect(page.coverage).toEqual({ start: chunks.length, end: chunks.length + page.items.length, complete: page.nextCursor === null });
        expect(page.items.length).toBeGreaterThan(0);
        assertBytes(page);
        for (const raw of page.items) {
          const chunk = raw as DetailChunk;
          expect(chunk).toMatchObject({ id: strokeId, chunkIndex: chunks.length, chunkCount: initial.totalItems, jsonText: expect.any(String) });
          expect(Array.from(chunk.jsonText).length).toBeLessThanOrEqual(128);
          if (chunk.chunkIndex < chunk.chunkCount - 1) expect(Array.from(chunk.jsonText)).toHaveLength(128);
          chunks.push(chunk);
        }
        if (!page.nextCursor) break;
        page = detail(snapshot, strokeId, page.nextCursor);
      }
      expect(chunks).toHaveLength(initial.totalItems);
      return { value: JSON.parse(chunks.map(chunk => chunk.jsonText).join('')), pageCount };
    };
    const restored = collect(first, a.id, root.snapshot, root.revision, original.versionId);
    expect(restored.pageCount).toBeGreaterThan(1);
    expect(restored.value).toEqual({ id: a.id, versionId: original.versionId, content: a.content });
    expect(restored.value.content.path).toHaveLength(4097);
    expect(detail(root.snapshot, a.id)).toEqual(first);
    for (const id of [b.id, 'never-existed']) {
      const absent = detail(root.snapshot, id);
      expect(absent).toMatchObject({ availability: 'not_found', target: { strokeId: id }, totalItems: 0, items: [],
        snapshot: root.snapshot, revision: root.revision, coverage: { start: 0, end: 0, complete: true }, nextCursor: null });
      assertBytes(absent);
    }
    failure(() => detail(root.snapshot, b.id, first.nextCursor!), 'INVALID_CURSOR');
    failure(() => mapping.read({ type: 'map', view: 'stroke-index', projectId: 'p', snapshot: root.snapshot,
      cursor: first.nextCursor!, budget }, human), 'INVALID_CURSOR');
    const fresh = rootRead();
    expect(fresh.snapshot).not.toBe(root.snapshot);
    expect(fresh.revision).toBe(root.revision + 2);
    const deleted = detail(fresh.snapshot, a.id);
    expect(deleted).toMatchObject({ availability: 'deleted', target: { strokeId: a.id }, totalItems: 0, items: [],
      snapshot: fresh.snapshot, revision: fresh.revision, coverage: { start: 0, end: 0, complete: true }, nextCursor: null });
    assertBytes(deleted);

    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    failure(() => detail(root.snapshot, a.id), 'SNAPSHOT_EXPIRED');
    expect(state()).toEqual(current);
    const reopenedRoot = rootRead();
    const reopenedIndex = mapping.read({ type: 'map', view: 'stroke-index', projectId: 'p', snapshot: reopenedRoot.snapshot }, human);
    expect(reopenedIndex.items).toEqual([{ id: b.id, type: 'stroke', versionId: added.versionId, order: 1, item: added.item,
      content: { penKind: 'highlighter', color: '#ffe08a', width: 12, opacity: 0.4, pointCount: 3, availability: 'not_fetched' } }]);
    expect(collect(detail(reopenedRoot.snapshot, b.id), b.id, reopenedRoot.snapshot, current.project.revision, added.versionId).value)
      .toEqual({ id: b.id, versionId: added.versionId, content: b.content });
    expect(mapping.read({ type: 'version', projectId: 'p', domain: 'stroke', id: a.id, versionId: original.versionId }, human))
      .toEqual({ id: a.id, versionId: original.versionId, content: a.content });
    expect(detail(reopenedRoot.snapshot, a.id).availability).toBe('deleted');
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
