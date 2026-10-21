import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { ProjectState, Receipt } from '../src/mapping/contracts.js';
import type { CanvasStroke } from '../src/mapping/stroke-contracts.js';
import type { Delta, ObservePage } from '../src/mapping/observe-contracts.js';

type SavedChange = { receipt: Receipt; before: CanvasStroke | null; after: CanvasStroke | null };

it('笔迹变化完整报告两域与身份，连续分页固定终点并无损重建，后续撤销只由新观察接收', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-stroke-observe-'));
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '笔迹变化🧠' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'protected-card', title: '原卡', text: '保留正文', x: 600, y: 400 } });
    run({ type: 'text.create', expected: null, payload: {
      id: 'protected-text', content: { runs: [{ text: '原独立文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
      pose: { x: 400, y: 250, width: 160, height: 60 },
    } });
    run({ type: 'shape.create', expected: null, payload: {
      id: 'protected-shape', content: { shapeType: 'ellipse', shortText: '原形状', fill: '#d9e7f1', stroke: '#403b36', strokeWidth: 2 },
      pose: { x: 200, y: -80, width: 140, height: 100 },
    } });
    run({ type: 'tag.create', expected: null, payload: { id: 'protected-tag', name: '原标签' } });
    const baseline = state();
    const baseRevision = baseline.project.revision;
    const baseSnapshot = mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 16384 }, human);
    expect(baseSnapshot.revision).toBe(baseRevision);
    expect(baseline.strokes).toEqual([]);
    expect(baseline.tags).toHaveLength(1);
    const capture = (command: Record<string, unknown>, id: string): SavedChange => {
      const beforeState = state();
      const before = beforeState.strokes!.find(stroke => stroke.id === id) ?? null;
      const receipt = run(command);
      const after = state().strokes!.find(stroke => stroke.id === id) ?? null;
      const identity = after ?? before!;
      expect(receipt.revision).toBe(beforeState.project.revision + 1);
      expect(receipt.changedIds).toEqual([identity.id, identity.item.id]);
      return { receipt, before, after };
    };
    const pen = { id: 'pen-普通笔', content: { penKind: 'pen', path: [{ x: 1, y: 1 }, { x: 20.5, y: 6.25 }, { x: 39, y: 19 }], color: '#123456', width: 2, opacity: 1 }, pose: { x: -90.5, y: 160.25, width: 40, height: 20 } };
    const highlighter = { id: 'highlighter-荧光笔', content: { penKind: 'highlighter', path: [{ x: 5, y: 5 }, { x: 40, y: 5 }, { x: 75, y: 15 }], color: '#ffe08a', width: 10, opacity: 0.35 }, pose: { x: 110, y: -45, width: 80, height: 20 } };
    const expected = [
      capture({ type: 'stroke.create', expected: null, payload: pen }, pen.id),
      capture({ type: 'stroke.create', expected: null, payload: highlighter }, highlighter.id),
    ];
    const createdPen = state().strokes!.find(stroke => stroke.id === pen.id)!;
    expected.push(capture({ type: 'stroke.delete', expected: { stroke: createdPen.versionId, pose: createdPen.item.versionId }, payload: { id: pen.id } }, pen.id));
    expected.push(capture({ type: 'history.undo', expected: state().project.revision, payload: {} }, pen.id));
    expected.push(capture({ type: 'history.redo', expected: state().project.revision, payload: {} }, pen.id));
    const frozenState = state();
    const budget = 16384;
    const first = mapping.observe({ projectId: 'p', afterRevision: baseRevision, baseSnapshot: baseSnapshot.snapshot, limit: 1, budget }, human);
    const assertChange = (change: Delta, saved: SavedChange) => {
      const identity = saved.after ?? saved.before!;
      expect(change).toMatchObject(saved.receipt);
      expect(change.domains).toEqual([{ domain: 'stroke', id: identity.id }, { domain: 'pose', id: identity.item.id }]);
      expect(change.strokeChange).toEqual({ before: saved.before, after: saved.after });
      expect(change.changedIds).toEqual([identity.id, identity.item.id]);
      expect(change.deletedIds).toEqual(saved.after ? [] : [identity.id, identity.item.id]);
      expect(change.before).toBeNull();
      expect(change.after).toBeNull();
      for (const field of ['cardChanges', 'textChange', 'textChanges', 'shapeChange', 'shapeChanges', 'tagChange']) expect(change).not.toHaveProperty(field);
    };
    expect(first.changes).toHaveLength(1);
    assertChange(first.changes[0]!, expected[0]!);

    const later = capture({ type: 'history.undo', expected: state().project.revision, payload: {} }, pen.id);
    const liveState = state();
    expect(liveState.project.revision).toBe(frozenState.project.revision + 1);
    expect(mapping.observe({ projectId: 'p', afterRevision: baseRevision, snapshot: first.snapshot, limit: 1, budget }, human)).toEqual(first);
    const pages = [first];
    for (let index = 1; index < expected.length; index++) pages.push(mapping.observe({ projectId: 'p', afterRevision: pages.at(-1)!.nextRevision, snapshot: first.snapshot, limit: 1, budget }, human));
    const assertBytes = (page: ObservePage) => {
      expect(page.status).toBe('OK');
      expect(page.budgetUnit).toBe('utf8_bytes');
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
      expect(page.bytes).toBeLessThanOrEqual(budget);
    };
    let reconstructed: ProjectState = structuredClone(baseline);
    const apply = (change: Delta) => {
      const after = change.strokeChange!.after;
      const id = (after ?? change.strokeChange!.before!).id;
      reconstructed.strokes = reconstructed.strokes!.filter(stroke => stroke.id !== id);
      if (after) reconstructed.strokes.push(structuredClone(after));
      reconstructed.project.revision = change.revision;
    };
    for (const [index, page] of pages.entries()) {
      assertBytes(page);
      expect(page.snapshot).toBe(first.snapshot);
      expect(page.revision).toBe(frozenState.project.revision);
      expect(page.afterRevision).toBe(baseRevision + index);
      expect(page.nextRevision).toBe(baseRevision + index + 1);
      expect(page.complete).toBe(index === expected.length - 1);
      expect(page.changes).toHaveLength(1);
      assertChange(page.changes[0]!, expected[index]!);
      apply(page.changes[0]!);
    }
    expect(reconstructed).toEqual(frozenState);
    const next = mapping.observe({ projectId: 'p', afterRevision: frozenState.project.revision, baseSnapshot: first.snapshot, limit: 1, budget }, human);
    assertBytes(next);
    expect(next.snapshot).not.toBe(first.snapshot);
    expect(next.revision).toBe(liveState.project.revision);
    expect(next.nextRevision).toBe(liveState.project.revision);
    expect(next.complete).toBe(true);
    expect(next.changes).toHaveLength(1);
    assertChange(next.changes[0]!, later);
    apply(next.changes[0]!);
    expect(reconstructed).toEqual(liveState);
    for (const field of ['cards', 'texts', 'shapes', 'tags'] as const) expect(reconstructed[field]).toEqual(baseline[field]);
    const empty = mapping.observe({ projectId: 'p', afterRevision: liveState.project.revision, baseSnapshot: next.snapshot, limit: 1, budget }, human);
    assertBytes(empty);
    expect(empty).toMatchObject({ revision: liveState.project.revision, afterRevision: liveState.project.revision, nextRevision: liveState.project.revision, complete: true, changes: [] });
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
