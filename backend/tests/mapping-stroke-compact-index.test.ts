import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { CompactPage } from '../src/mapping/compact-contracts.js';

it('Card-only 根快照首次固定有界 Stroke 索引，增删不污染旧预算分页，SQLite 重开保留当前索引', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-stroke-index-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    const rootRead = () => mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 16384 }, human);
    const indexRead = (snapshot: string, budget: number, cursor?: string) => mapping.read({ type: 'map', view: 'stroke-index', projectId: 'p', snapshot, budget, ...(cursor ? { cursor } : {}) }, human);
    run({ type: 'project.create', expected: null, payload: { name: '固定笔迹索引🧠' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'protected-card', title: '原卡', text: '保留正文', x: 600, y: 400 } });
    run({ type: 'text.create', expected: null, payload: {
      id: 'protected-text', content: { runs: [{ text: '原独立文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
      pose: { x: 400, y: 200, width: 160, height: 60 },
    } });
    run({ type: 'shape.create', expected: null, payload: {
      id: 'protected-shape', content: { shapeType: 'diamond', shortText: '原形状', fill: '#dce8dd', stroke: '#403b36', strokeWidth: 2 },
      pose: { x: 200, y: -80, width: 140, height: 120 },
    } });
    const pen = { id: 'b-普通笔', content: {
      penKind: 'pen', path: Array.from({ length: 4097 }, (_, index) => ({ x: 1 + index / 16, y: 1 + index % 8 })), color: '#123456', width: 2, opacity: 1,
    }, pose: { x: -120.5, y: 240.25, width: 260, height: 10 } };
    const highlighter = { id: 'a-荧光笔', content: { penKind: 'highlighter', path: [{ x: 6, y: 6 }, { x: 40, y: 6 }, { x: 74, y: 16 }], color: '#ffe08a', width: 12, opacity: 0.4 }, pose: { x: 80, y: -35, width: 80, height: 22 } };
    run({ type: 'stroke.create', expected: null, payload: pen });
    run({ type: 'stroke.create', expected: null, payload: highlighter });
    const before = state();
    const originalPen = before.strokes!.find(stroke => stroke.id === pen.id)!;
    const originalHighlighter = before.strokes!.find(stroke => stroke.id === highlighter.id)!;
    const root = rootRead();
    expect(root.revision).toBe(before.project.revision);
    expect(root.scope).toEqual({ types: ['thought'], relations: 'not_implemented', order: 'creation_ordinal' });
    expect(root.items).toHaveLength(1);
    expect(root.items[0]).toMatchObject({ id: 'protected-card', type: 'thought', body: { id: before.cards[0]!.body.id, versionId: before.cards[0]!.body.versionId } });

    run({ type: 'stroke.delete', expected: { stroke: originalPen.versionId, pose: originalPen.item.versionId }, payload: { id: pen.id } });
    const added = { id: 'c-新增笔迹', content: { penKind: 'pen', path: [{ x: 1, y: 1 }], color: '#654321', width: 2, opacity: 1 }, pose: { x: -20, y: 50, width: 2, height: 2 } };
    run({ type: 'stroke.create', expected: null, payload: added });
    const current = state();
    const newStroke = current.strokes!.find(stroke => stroke.id === added.id)!;
    expect(current.strokes!.some(stroke => stroke.id === pen.id)).toBe(false);
    expect(current.project.revision).toBe(before.project.revision + 2);
    for (const field of ['cards', 'texts', 'shapes', 'tags'] as const) expect(current[field]).toEqual(before[field]);
    const old = indexRead(root.snapshot, 16384);
    const oldItems = [
      { id: highlighter.id, type: 'stroke', versionId: originalHighlighter.versionId, order: 1, item: originalHighlighter.item,
        content: { penKind: 'highlighter', color: '#ffe08a', width: 12, opacity: 0.4, pointCount: 3, availability: 'not_fetched' } },
      { id: pen.id, type: 'stroke', versionId: originalPen.versionId, order: 0, item: originalPen.item,
        content: { penKind: 'pen', color: '#123456', width: 2, opacity: 1, pointCount: 4097, availability: 'not_fetched' } },
    ];
    expect(old).toMatchObject({ snapshot: root.snapshot, revision: before.project.revision, totalItems: 2, fidelity: 'stroke-index', availability: 'available',
      scope: { types: ['stroke'], relations: 'not_implemented', order: 'creation_ordinal' }, coverage: { start: 0, end: 2, complete: true }, nextCursor: null });
    expect(old.items).toEqual(oldItems);
    expect(JSON.stringify(old)).not.toContain('"path"');
    const assertBytes = (page: CompactPage, budget: number) => {
      expect(page.budgetUnit).toBe('utf8_bytes');
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
      expect(page.bytes).toBeLessThanOrEqual(budget);
    };
    assertBytes(old, 16384);
    const budget = old.bytes - 1;
    const first = indexRead(root.snapshot, budget);
    expect(first.coverage).toEqual({ start: 0, end: 1, complete: false });
    expect(first.items).toEqual([oldItems[0]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = indexRead(root.snapshot, budget, first.nextCursor!);
    expect(last.coverage).toEqual({ start: 1, end: 2, complete: true });
    expect(last.nextCursor).toBeNull();
    expect([...first.items, ...last.items]).toEqual(oldItems);
    for (const page of [first, last]) {
      assertBytes(page, budget);
      expect(page.snapshot).toBe(root.snapshot);
      expect(page.revision).toBe(before.project.revision);
      expect(page.totalItems).toBe(2);
      expect(JSON.stringify(page)).not.toContain('"path"');
    }
    for (const view of ['index', 'text-index', 'shape-index'] as const) {
      let failure: unknown;
      try { mapping.read({ type: 'map', view, projectId: 'p', snapshot: root.snapshot, cursor: first.nextCursor!, budget: 16384 }, human); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'INVALID_CURSOR' });
    }
    expect(indexRead(root.snapshot, 16384)).toEqual(old);
    expect(mapping.read({ type: 'map', view: 'index', projectId: 'p', snapshot: root.snapshot, budget: 16384 }, human)).toEqual(root);

    const freshRoot = rootRead();
    const fresh = indexRead(freshRoot.snapshot, 16384);
    const freshItems = [oldItems[0],
      { id: added.id, type: 'stroke', versionId: newStroke.versionId, order: 2, item: newStroke.item,
        content: { penKind: 'pen', color: '#654321', width: 2, opacity: 1, pointCount: 1, availability: 'not_fetched' } },
    ];
    expect(freshRoot.snapshot).not.toBe(root.snapshot);
    expect(freshRoot.scope.types).toEqual(['thought']);
    expect(fresh.snapshot).toBe(freshRoot.snapshot);
    expect(fresh.revision).toBe(current.project.revision);
    expect(fresh.items).toEqual(freshItems);
    expect(fresh.coverage).toEqual({ start: 0, end: 2, complete: true });
    assertBytes(fresh, 16384);
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    expect(state()).toEqual(current);
    const reopenedRoot = rootRead();
    const reopened = indexRead(reopenedRoot.snapshot, 16384);
    expect(reopenedRoot.scope.types).toEqual(['thought']);
    expect(reopened.snapshot).toBe(reopenedRoot.snapshot);
    expect(reopened.revision).toBe(current.project.revision);
    expect(reopened.items).toEqual(freshItems);
    assertBytes(reopened, 16384);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
