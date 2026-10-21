import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

it('形状单域与混合变化完整报告写域和删除身份，预算分页固定快照且隔离后续新写', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-observe-'));
  const mapping = openMapping(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  run({ type: 'project.create', expected: null, payload: { name: '形状变化🧠' } });
  run({ type: 'thought.create', expected: null, payload: { id: 'c', title: '原卡片', text: '正文', x: 10, y: 20 } });
  run({ type: 'text.create', expected: null, payload: { id: 't',
    content: { runs: [{ text: '独立文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 },
    pose: { x: 200, y: 40, width: 180, height: 27 } } });
  const baseRevision = state().project.revision;
  expect(baseRevision).toBe(3);
  const content = { shapeType: 'diamond', shortText: '条件待观察🧠', fill: '#fef3c7', stroke: '#92400e', strokeWidth: 2 };
  run({ commandId: 'shape-created', type: 'shape.create', expected: null,
    payload: { id: 's', content, pose: { x: -50, y: 80, width: 130, height: 90 } } });
  const original = state().shapes![0]!;
  run({ commandId: 'shape-edited', type: 'shape.edit', expected: original.versionId,
    payload: { id: 's', content: { ...content, shortText: '修改后的短文字' } } });
  run({ commandId: 'shape-moved', type: 'shape.move', expected: original.item.versionId, payload: { id: 's', x: -20, y: 110 } });
  const beforeMixed = state();
  const card = beforeMixed.cards[0]!, text = beforeMixed.texts![0]!, shape = beforeMixed.shapes![0]!;
  run({ commandId: 'mixed-moved', type: 'canvas.move',
    expected: { [card.item.id]: card.item.versionId, [text.item.id]: text.item.versionId, [shape.item.id]: shape.item.versionId },
    payload: { targets: [
      { kind: 'card', id: card.id, itemId: card.item.id, x: 40, y: 60 },
      { kind: 'text', id: text.id, itemId: text.item.id, x: 230, y: 80 },
      { kind: 'shape', id: shape.id, itemId: shape.item.id, x: 10, y: 150 },
    ] } });
  const moved = state().shapes![0]!;
  run({ commandId: 'shape-deleted', type: 'shape.delete', expected: { shape: moved.versionId, pose: moved.item.versionId }, payload: { id: 's' } });
  run({ commandId: 'shape-restored', type: 'history.undo', expected: state().project.revision, payload: {} });
  expect(state().project.revision).toBe(9);
  const budget = 16384;
  const first = mapping.observe({ projectId: 'p', afterRevision: baseRevision, limit: 1, budget }, human);
  expect(first).toMatchObject({ status: 'OK', revision: 9, nextRevision: 4, complete: false,
    changes: [{ commandId: 'shape-created', domains: [{ domain: 'shape', id: 's' }, { domain: 'pose', id: original.item.id }], deletedIds: [] }] });

  const restored = state().shapes![0]!;
  run({ commandId: 'later-shape-edit', type: 'shape.edit', expected: restored.versionId,
    payload: { id: 's', content: { ...restored.content, shortText: '快照之后的新变化' } } });
  expect(state().project.revision).toBe(10);
  expect(mapping.observe({ projectId: 'p', afterRevision: baseRevision, snapshot: first.snapshot, limit: 1, budget }, human)).toEqual(first);
  const pages = [first];
  for (let index = 1; index < 6; index++) {
    pages.push(mapping.observe({ projectId: 'p', afterRevision: pages.at(-1)!.nextRevision,
      snapshot: first.snapshot, limit: 1, budget }, human));
  }
  for (const [index, page] of pages.entries()) {
    expect(page.status).toBe('OK');
    expect(page.snapshot).toBe(first.snapshot);
    expect(page.revision).toBe(9);
    expect(page.afterRevision).toBe(3 + index);
    expect(page.nextRevision).toBe(4 + index);
    expect(page.complete).toBe(index === 5);
    expect(page.changes).toHaveLength(1);
    expect(page.budgetUnit).toBe('utf8_bytes');
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
    expect(page.bytes).toBeLessThanOrEqual(budget);
  }
  expect(pages.flatMap(page => page.changes).map(change => ({
    commandId: change.commandId, domains: change.domains, deletedIds: change.deletedIds,
  }))).toEqual([
    { commandId: 'shape-created', domains: [{ domain: 'shape', id: 's' }, { domain: 'pose', id: original.item.id }], deletedIds: [] },
    { commandId: 'shape-edited', domains: [{ domain: 'shape', id: 's' }], deletedIds: [] },
    { commandId: 'shape-moved', domains: [{ domain: 'pose', id: original.item.id }], deletedIds: [] },
    { commandId: 'mixed-moved', domains: [{ domain: 'pose', id: card.item.id }, { domain: 'pose', id: text.item.id }, { domain: 'pose', id: original.item.id }], deletedIds: [] },
    { commandId: 'shape-deleted', domains: [{ domain: 'shape', id: 's' }, { domain: 'pose', id: original.item.id }], deletedIds: ['s', original.item.id] },
    { commandId: 'shape-restored', domains: [{ domain: 'shape', id: 's' }, { domain: 'pose', id: original.item.id }], deletedIds: [] },
  ]);
  const next = mapping.observe({ projectId: 'p', afterRevision: 9, baseSnapshot: first.snapshot, limit: 1, budget }, human);
  expect(next).toMatchObject({ status: 'OK', revision: 10, nextRevision: 10, complete: true,
    changes: [{ commandId: 'later-shape-edit', domains: [{ domain: 'shape', id: 's' }], deletedIds: [] }] });
  expect(next.changes).toHaveLength(1);
  expect(next.snapshot).not.toBe(first.snapshot);
  expect(Buffer.byteLength(JSON.stringify(next), 'utf8')).toBe(next.bytes);
  expect(next.bytes).toBeLessThanOrEqual(budget);
});
