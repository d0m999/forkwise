import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('形状删除只移除目标，撤销恢复原身份，重做与 SQLite 重开仍禁止复用已删身份', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const execute = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    execute({ type: 'project.create', expected: null, payload: { name: '形状生命周期' } });
    execute({ type: 'thought.create', expected: null, payload: { id: 'protected-card', title: '保留原卡', text: '形状删除不应影响正文', x: 700, y: 500 } });
    const protectedCards = state().cards;
    const payload = { id: 'lifecycle-shape', content: { shapeType: 'diamond', shortText: '待确认\n下一次披露', fill: '#f4e9b9', stroke: '#403b36', strokeWidth: 2 }, pose: { x: -100, y: 240, width: 200, height: 140 } };
    execute({ type: 'shape.create', expected: null, payload });
    const created = state().shapes![0]!;
    const removed = execute({ type: 'shape.delete', expected: { shape: created.versionId, pose: created.item.versionId }, payload: { id: created.id } });
    expect(removed.deletedIds).toEqual([created.id, created.item.id]);
    expect(state().shapes).toEqual([]);
    expect(state().cards).toEqual(protectedCards);
    const rejectReuse = () => {
      const beforeFailure = state();
      let failure: unknown;
      try { execute({ type: 'shape.create', expected: null, payload }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'ID_CONFLICT' });
      expect(state()).toEqual(beforeFailure);
    };
    rejectReuse();
    execute({ type: 'history.undo', expected: state().project.revision, payload: {} });
    const restored = state().shapes![0]!;
    expect(restored).toMatchObject({ id: created.id, content: payload.content, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose: payload.pose } });
    expect(restored.versionId).not.toBe(created.versionId);
    expect(restored.item.versionId).not.toBe(created.item.versionId);
    expect(state().cards).toEqual(protectedCards);
    execute({ type: 'history.redo', expected: state().project.revision, payload: {} });
    expect(state().shapes).toEqual([]);
    expect(state().cards).toEqual(protectedCards);
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    expect(state().shapes).toEqual([]);
    expect(state().cards).toEqual(protectedCards);
    rejectReuse();
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
