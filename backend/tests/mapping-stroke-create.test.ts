import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

type Content = { penKind: string; path: { x: number; y: number }[]; color: string; width: number; opacity: number };
type Pose = { x: number; y: number; width: number; height: number };
type Stroke = { id: string; kind: string; versionId: string; content: Content; item: { id: string; versionId: string; createdOrder: number; pose: Pose } };
type State = { project: { revision: number }; cards: unknown[]; texts: unknown[]; shapes: unknown[]; tags: unknown[]; strokes: Stroke[] };

it('普通笔和荧光笔独立身份、完整路径及世界姿态经统一创建历史和真实 SQLite 重开保持', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-stroke-create-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const execute = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
    execute({ type: 'project.create', expected: null, payload: { name: '笔迹持久化' } });
    execute({ type: 'thought.create', expected: null, payload: { id: 'protected-card', title: '原卡', text: '原正文不被笔迹改变', x: 700, y: 400 } });
    execute({ type: 'text.create', expected: null, payload: {
      id: 'protected-text', content: { runs: [{ text: '保留独立文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
      pose: { x: 400, y: 300, width: 160, height: 60 },
    } });
    execute({ type: 'shape.create', expected: null, payload: {
      id: 'protected-shape', content: { shapeType: 'diamond', shortText: '保留形状', fill: '#e8dff0', stroke: '#403b36', strokeWidth: 2 },
      pose: { x: 300, y: -100, width: 140, height: 120 },
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
      { id: 'ordinary-stroke', content: { penKind: 'pen', path: [{ x: 1, y: 1 }, { x: 18.25, y: 6.5 }, { x: 35, y: 19 }], color: '#123456', width: 2, opacity: 1 }, pose: { x: -120.5, y: 240.25, width: 36, height: 20 } },
      { id: 'highlight-stroke', content: { penKind: 'highlighter', path: [{ x: 6, y: 6 }, { x: 40, y: 6 }, { x: 74, y: 16 }], color: '#ffe08a', width: 12, opacity: 0.4 }, pose: { x: 80, y: -35, width: 80, height: 22 } },
    ];
    for (const input of inputs) {
      const before = state();
      const previousStrokes = before.strokes ?? [];
      const previousHistory = history();
      const command = { commandId: randomUUID(), type: 'stroke.create', expected: null, payload: input };
      const receipt = execute(command);
      const created = state().strokes.find(stroke => stroke.id === input.id)!;
      expect(created).toMatchObject({ id: input.id, kind: 'stroke', content: input.content, item: { id: expect.any(String), pose: input.pose, createdOrder: before.project.revision + 1 } });
      expect(created.content).toEqual(input.content);
      expect(created.item.pose).toEqual(input.pose);
      expect(created.versionId).toEqual(expect.any(String));
      expect(created.item.versionId).toEqual(expect.any(String));
      expect(new Set([created.id, created.item.id, created.versionId, created.item.versionId]).size).toBe(4);
      expect(created).not.toHaveProperty('body');
      expect(created).not.toHaveProperty('tags');
      expect(state().strokes).toEqual([...previousStrokes, created]);
      expect(receipt.changedIds).toEqual([created.id, created.item.id]);
      expect(receipt.revision).toBe(before.project.revision + 1);
      expect(history().undo).toHaveLength(previousHistory.undo.length + 1);
      expect(history().undo.at(-1)).toMatchObject({ id: command.commandId, label: 'stroke.create', target: { id: created.id } });
      expect(history().redo).toEqual([]);
      expectProtected();

      execute({ type: 'history.undo', expected: state().project.revision, payload: {} });
      expect(state().strokes).toEqual(previousStrokes);
      expect(history().undo).toEqual(previousHistory.undo);
      expect(history().redo).toHaveLength(1);
      expect(history().redo[0]!.id).toBe(command.commandId);
      expectProtected();
      execute({ type: 'history.redo', expected: state().project.revision, payload: {} });
      const restored = state().strokes.find(stroke => stroke.id === input.id)!;
      expect(restored).toMatchObject({ id: created.id, kind: 'stroke', content: input.content, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose: input.pose } });
      expect(restored.content).toEqual(input.content);
      expect(restored.item.pose).toEqual(input.pose);
      expect(restored.versionId).not.toBe(created.versionId);
      expect(restored.item.versionId).not.toBe(created.item.versionId);
      expect(restored.versionId).not.toBe(restored.item.versionId);
      expect(state().strokes.filter(stroke => stroke.id !== restored.id)).toEqual(previousStrokes);
      expect(history().undo).toHaveLength(previousHistory.undo.length + 1);
      expect(history().redo).toEqual([]);
      expectProtected();
    }
    const beforeReopen = state();
    const historyBeforeReopen = history();
    expect(beforeReopen.strokes).toHaveLength(2);
    expect(new Set(beforeReopen.strokes.flatMap(stroke => [stroke.id, stroke.item.id])).size).toBe(4);
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    expect(state()).toEqual(beforeReopen);
    expect(history()).toEqual(historyBeforeReopen);
    expectProtected();
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
