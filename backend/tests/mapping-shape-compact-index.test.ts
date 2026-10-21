import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

it('根索引首次建立快照即固定形状索引身份和版本，后续编辑移动删除不污染旧 Shape 页', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-shape-index-'));
  const mapping = openMapping(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  run({ type: 'project.create', expected: null, payload: { name: '固定形状索引' } });
  const longText = '无限制短文字🧠'.repeat(5000);
  const content = { shapeType: 'roundedRectangle', shortText: longText, fill: '#fef3c7', stroke: '#92400e', strokeWidth: 2 };
  run({ type: 'shape.create', expected: null, payload: { id: 'a', content, pose: { x: -80, y: 20, width: 170, height: 90 } } });
  run({ type: 'shape.create', expected: null, payload: { id: 'b', content: { shapeType: 'triangle', shortText: '即将删除' }, pose: { x: 220, y: -40, width: 130, height: 120 } } });
  const [originalA, originalB] = state().shapes!;
  const budget = 4096;
  const root = mapping.read({ type: 'map', view: 'index', projectId: 'p', budget }, human);
  expect(root.revision).toBe(3);
  run({ type: 'shape.edit', expected: originalA!.versionId, payload: { id: 'a', content: { ...content, shortText: '新内容', fill: '#dbeafe' } } });
  run({ type: 'shape.move', expected: originalA!.item.versionId, payload: { id: 'a', x: 45, y: 160 } });
  run({ type: 'shape.delete', expected: { shape: originalB!.versionId, pose: originalB!.item.versionId }, payload: { id: 'b' } });
  const current = state();
  expect(current.project.revision).toBe(6);
  expect(current.shapes).toHaveLength(1);
  const old = mapping.read({ type: 'map', view: 'shape-index', projectId: 'p', snapshot: root.snapshot, budget }, human);
  expect(old).toMatchObject({ snapshot: root.snapshot, revision: 3, totalItems: 2,
    scope: { types: ['shape'], relations: 'not_implemented', order: 'creation_ordinal' },
    fidelity: 'shape-index', availability: 'available', coverage: { start: 0, end: 2, complete: true }, nextCursor: null });
  expect(old.items).toEqual([
    { id: 'a', type: 'shape', versionId: originalA!.versionId, order: 0, item: originalA!.item,
      content: { shapeType: 'roundedRectangle', fill: '#fef3c7', stroke: '#92400e', strokeWidth: 2, availability: 'not_fetched' } },
    { id: 'b', type: 'shape', versionId: originalB!.versionId, order: 1, item: originalB!.item,
      content: { shapeType: 'triangle', availability: 'not_fetched' } },
  ]);
  expect(JSON.stringify(old)).not.toContain('shortText');
  expect(JSON.stringify(old)).not.toContain('无限制短文字');
  expect(mapping.read({ type: 'map', view: 'index', projectId: 'p', snapshot: root.snapshot, budget }, human)).toEqual(root);
  expect(mapping.read({ type: 'map', view: 'shape-index', projectId: 'p', snapshot: root.snapshot, budget }, human)).toEqual(old);

  const freshRoot = mapping.read({ type: 'map', view: 'index', projectId: 'p', budget }, human);
  const fresh = mapping.read({ type: 'map', view: 'shape-index', projectId: 'p', snapshot: freshRoot.snapshot, budget }, human);
  const surviving = current.shapes![0]!;
  expect(fresh.snapshot).toBe(freshRoot.snapshot);
  expect(fresh.snapshot).not.toBe(root.snapshot);
  expect(fresh.revision).toBe(6);
  expect(fresh.totalItems).toBe(1);
  expect(surviving.versionId).not.toBe(originalA!.versionId);
  expect(surviving.item.versionId).not.toBe(originalA!.item.versionId);
  expect(fresh.items).toEqual([
    { id: 'a', type: 'shape', versionId: surviving.versionId, order: 0, item: surviving.item,
      content: { shapeType: 'roundedRectangle', fill: '#dbeafe', stroke: '#92400e', strokeWidth: 2, availability: 'not_fetched' } },
  ]);
  expect(JSON.stringify(fresh)).not.toContain('shortText');
  for (const page of [root, old, freshRoot, fresh]) {
    expect(page.budgetUnit).toBe('utf8_bytes');
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
    expect(page.bytes).toBeLessThanOrEqual(budget);
  }
});
