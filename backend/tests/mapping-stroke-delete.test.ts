import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('笔迹删除校验两个当前版本且失败键可重试，撤销重做和 SQLite 重开保留完整身份与其他对象', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-stroke-delete-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const execute = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
    const travel = (type: 'history.undo' | 'history.redo') => execute({ type, expected: state().project.revision, payload: {} });
    const reopen = () => {
      mapping.close();
      mapping = openMapping(directory);
      human = mapping.access.authenticate(token);
    };
    execute({ type: 'project.create', expected: null, payload: { name: '笔迹删除' } });
    execute({ type: 'thought.create', expected: null, payload: { id: 'protected-card', title: '保留原卡', text: '笔迹删除不触碰正文', x: 600, y: 500 } });
    execute({ type: 'text.create', expected: null, payload: {
      id: 'protected-text', content: { runs: [{ text: '保留独立文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 },
      pose: { x: 400, y: 200, width: 180, height: 60 },
    } });
    execute({ type: 'shape.create', expected: null, payload: {
      id: 'protected-shape', content: { shapeType: 'triangle', shortText: '保留形状', fill: '#dce8dd', stroke: '#403b36', strokeWidth: 2 },
      pose: { x: 350, y: -80, width: 140, height: 120 },
    } });
    execute({ type: 'stroke.create', expected: null, payload: {
      id: 'protected-stroke', content: { penKind: 'pen', path: [{ x: 1, y: 1 }, { x: 31, y: 11 }], color: '#654321', width: 2, opacity: 1 },
      pose: { x: 700, y: -100, width: 32, height: 12 },
    } });
    const protectedState = state();
    const expectProtected = () => {
      const current = state();
      expect(current.cards).toEqual(protectedState.cards);
      expect(current.texts).toEqual(protectedState.texts);
      expect(current.shapes).toEqual(protectedState.shapes);
      expect(current.tags).toEqual([]);
    };
    const inputs = [
      { id: 'delete-pen', content: { penKind: 'pen', path: [{ x: 1, y: 1 }, { x: 20.5, y: 8.25 }, { x: 39, y: 19 }], color: '#123456', width: 2, opacity: 1 }, pose: { x: -90.5, y: 160.25, width: 40, height: 20 } },
      { id: 'delete-highlighter', content: { penKind: 'highlighter', path: [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 75, y: 15 }], color: '#ffe08a', width: 10, opacity: 0.35 }, pose: { x: 110, y: -45, width: 80, height: 20 } },
    ];
    for (const input of inputs) {
      const otherStrokes = state().strokes!;
      execute({ type: 'stroke.create', expected: null, payload: input });
      const original = state().strokes!.find(stroke => stroke.id === input.id)!;
      travel('history.undo');
      expect(state().strokes).toEqual(otherStrokes);
      travel('history.redo');
      const renewed = state().strokes!.find(stroke => stroke.id === input.id)!;
      expect(renewed.versionId).not.toBe(original.versionId);
      expect(renewed.item.versionId).not.toBe(original.item.versionId);
      for (const staleDomain of ['content', 'pose']) {
        const current = state().strokes!.find(stroke => stroke.id === input.id)!;
        const beforeFailure = state();
        const historyBeforeFailure = history();
        const command = { commandId: randomUUID(), type: 'stroke.delete', payload: { id: input.id }, expected: {
          stroke: staleDomain === 'content' ? original.versionId : current.versionId,
          pose: staleDomain === 'pose' ? original.item.versionId : current.item.versionId,
        } };
        let failure: unknown;
        try { execute(command); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(state()).toEqual(beforeFailure);
        expect(history()).toEqual(historyBeforeFailure);

        const receipt = execute({ ...command, expected: { stroke: current.versionId, pose: current.item.versionId } });
        expect(receipt.changedIds).toEqual([current.id, current.item.id]);
        expect(receipt.deletedIds).toEqual([current.id, current.item.id]);
        expect(receipt.revision).toBe(beforeFailure.project.revision + 1);
        expect(state().strokes).toEqual(otherStrokes);
        expect(history().undo).toHaveLength(historyBeforeFailure.undo.length + 1);
        expect(history().undo.at(-1)).toMatchObject({ id: command.commandId, label: 'stroke.delete', target: { id: current.id } });
        expectProtected();
        const deletedState = state();
        const deletedHistory = history();
        reopen();
        expect(state()).toEqual(deletedState);
        expect(history()).toEqual(deletedHistory);

        travel('history.undo');
        const restored = state().strokes!.find(stroke => stroke.id === input.id)!;
        expect(restored).toMatchObject({ id: original.id, kind: 'stroke', content: input.content, item: { id: original.item.id, createdOrder: original.item.createdOrder, pose: input.pose } });
        expect(restored.content).toEqual(input.content);
        expect(restored.item.pose).toEqual(input.pose);
        expect(restored.versionId).not.toBe(current.versionId);
        expect(restored.item.versionId).not.toBe(current.item.versionId);
        expect(restored.versionId).not.toBe(restored.item.versionId);
        expect(state().strokes!.filter(stroke => stroke.id !== input.id)).toEqual(otherStrokes);
        expectProtected();
        travel('history.redo');
        expect(state().strokes).toEqual(otherStrokes);
        expectProtected();
        travel('history.undo');
        const final = state().strokes!.find(stroke => stroke.id === input.id)!;
        expect(final).toMatchObject({ id: original.id, content: input.content, item: { id: original.item.id, createdOrder: original.item.createdOrder, pose: input.pose } });
        expect(final.versionId).not.toBe(restored.versionId);
        expect(final.item.versionId).not.toBe(restored.item.versionId);
        const restoredState = state();
        const restoredHistory = history();
        reopen();
        expect(state()).toEqual(restoredState);
        expect(history()).toEqual(restoredHistory);
        expectProtected();
      }
    }
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
