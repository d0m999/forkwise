import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

it('卡片、文字与形状混合移动原子提交并一步撤销重做，任一形状布局冲突整组不写', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-batch-'));
  const mapping = openMapping(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  run({ type: 'project.create', expected: null, payload: { name: '混合移动' } });
  run({ type: 'thought.create', expected: null, payload: { id: 'c', title: '保护卡片', text: '完整正文', x: 10, y: 20 } });
  run({ type: 'text.create', expected: null, payload: { id: 't',
    content: { runs: [{ text: '独立文字', bold: true }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 },
    pose: { x: 250, y: 40, width: 180, height: 27 } } });
  run({ type: 'shape.create', expected: null, payload: { id: 's',
    content: { shapeType: 'ellipse', shortText: '待观察', fill: '#fef3c7', stroke: '#92400e', strokeWidth: 2 },
    pose: { x: -150, y: 120, width: 130, height: 80 } } });
  const before = state();
  const originals = [before.cards[0]!, before.texts![0]!, before.shapes![0]!];
  const targets = [
    { kind: 'card', id: 'c', itemId: originals[0]!.item.id, x: 80, y: 90 },
    { kind: 'text', id: 't', itemId: originals[1]!.item.id, x: 320, y: 110 },
    { kind: 'shape', id: 's', itemId: originals[2]!.item.id, x: -80, y: 190 },
  ];
  const priorHistory = history();
  const movedReceipt = run({ type: 'canvas.move',
    expected: Object.fromEntries(originals.map(value => [value.item.id, value.item.versionId])), payload: { targets } });
  const moved = state();
  const movedValues = [moved.cards[0]!, moved.texts![0]!, moved.shapes![0]!];
  const originalPoses = [
    { ...originals[0]!.item.pose, x: 10, y: 20 },
    { x: 250, y: 40, width: 180, height: 27 },
    { x: -150, y: 120, width: 130, height: 80 },
  ];
  const movedPoses = [
    { ...originals[0]!.item.pose, x: 80, y: 90 },
    { x: 320, y: 110, width: 180, height: 27 },
    { x: -80, y: 190, width: 130, height: 80 },
  ];
  expect(movedValues.map(value => value.item.pose)).toEqual(movedPoses);
  expect(moved.project.revision).toBe(before.project.revision + 1);
  expect(movedReceipt.changedIds).toEqual(originals.map(value => value.item.id));
  expect(history().undo).toHaveLength(priorHistory.undo.length + 1);
  expect(history().undo.at(-1)?.label).toBe('canvas.move');

  const undo = run({ type: 'history.undo', expected: moved.project.revision, payload: {} });
  const undone = state();
  const undoneValues = [undone.cards[0]!, undone.texts![0]!, undone.shapes![0]!];
  expect(undoneValues.map(value => value.item.pose)).toEqual(originalPoses);
  expect(undone.project.revision).toBe(moved.project.revision + 1);
  expect(undo.changedIds).toEqual(originals.map(value => value.item.id));
  expect(history().undo).toHaveLength(priorHistory.undo.length);
  expect(history().redo).toHaveLength(1);

  const redo = run({ type: 'history.redo', expected: undone.project.revision, payload: {} });
  const redone = state();
  const redoneValues = [redone.cards[0]!, redone.texts![0]!, redone.shapes![0]!];
  expect(redoneValues.map(value => value.item.pose)).toEqual(movedPoses);
  expect(redone.project.revision).toBe(undone.project.revision + 1);
  expect(redo.changedIds).toEqual(originals.map(value => value.item.id));
  expect(history().undo).toHaveLength(priorHistory.undo.length + 1);
  expect(history().redo).toEqual([]);
  for (let index = 0; index < originals.length; index++) {
    const { item: originalItem, ...originalContent } = originals[index]!;
    const versions = [originalItem.versionId];
    for (const values of [movedValues, undoneValues, redoneValues]) {
      const { item, ...content } = values[index]!;
      expect(content).toEqual(originalContent);
      expect({ ...item, pose: originalItem.pose, versionId: originalItem.versionId }).toEqual(originalItem);
      expect(versions).not.toContain(item.versionId);
      versions.push(item.versionId);
    }
  }
  const beforeFailure = state();
  const beforeFailureHistory = history();
  const staleShapeExpected = Object.fromEntries(redoneValues.map(value => [value.item.id, value.item.versionId]));
  staleShapeExpected[originals[2]!.item.id] = originals[2]!.item.versionId;
  expect(() => run({ type: 'canvas.move', expected: staleShapeExpected, payload: { targets: [
    { ...targets[0], x: 100, y: 130 },
    { ...targets[1], x: 340, y: 150 },
    { ...targets[2], x: -60, y: 230 },
  ] } })).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(state()).toEqual(beforeFailure);
  expect(history()).toEqual(beforeFailureHistory);
});
