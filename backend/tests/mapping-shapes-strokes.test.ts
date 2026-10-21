import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('矩形的独立身份、短文字和世界坐标经真实 SQLite 重开保持，不创建卡片正文', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    mapping.execute({ commandId: randomUUID(), projectId: 'p', type: 'project.create', expected: null, payload: { name: '形状研究' } }, human);
    const content = { shapeType: 'rectangle', shortText: '先观察 INTC\n再核验证据' };
    const pose = { x: -120, y: 240, width: 180, height: 100 };
    mapping.execute({ commandId: randomUUID(), projectId: 'p', type: 'shape.create', expected: null, payload: { id: 'rectangle-1', content, pose } }, human);
    type State = { cards: unknown[]; shapes: { id: string; kind: string; content: typeof content; item: { id: string; pose: typeof pose } }[] };
    const before = mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    expect(before.cards).toEqual([]);
    expect(before.shapes).toHaveLength(1);
    const created = before.shapes[0]!;
    expect(created).toMatchObject({ id: 'rectangle-1', kind: 'shape', content, item: { id: expect.any(String), pose } });
    expect(created).not.toHaveProperty('body');

    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    const reopened = mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    expect(reopened.shapes).toEqual([created]);
    expect(reopened.cards).toEqual([]);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('矩形创建整体撤销重做保留原身份并产生新版本，已有普通卡完整不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const execute = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    execute({ type: 'project.create', expected: null, payload: { name: '形状历史' } });
    execute({ type: 'thought.create', expected: null, payload: { id: 'protected-card', title: '原有观察', text: '原有正文不可被形状历史影响', x: 500, y: 600 } });
    const protectedCards = mapping.read({ type: 'project', projectId: 'p' }, human).cards;
    const content = { shapeType: 'rectangle', shortText: '先观察 INTC\n再核验证据' };
    const pose = { x: -120, y: 240, width: 180, height: 100 };
    execute({ type: 'shape.create', expected: null, payload: { id: 'history-rectangle', content, pose } });
    type State = { project: { revision: number }; cards: unknown[]; shapes: { id: string; versionId: string; content: typeof content; item: { id: string; versionId: string; createdOrder: number; pose: typeof pose } }[] };
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    const created = state().shapes[0]!;

    execute({ type: 'history.undo', expected: state().project.revision, payload: {} });
    expect(state().shapes).toEqual([]);
    expect(state().cards).toEqual(protectedCards);
    execute({ type: 'history.redo', expected: state().project.revision, payload: {} });
    const restored = state().shapes[0]!;
    expect(restored).toMatchObject({ id: created.id, kind: 'shape', content, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose } });
    expect(restored.versionId).not.toBe(created.versionId);
    expect(restored.item.versionId).not.toBe(created.item.versionId);
    expect(state().cards).toEqual(protectedCards);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('其余四种已定形状经公开读取与 SQLite 重开保留各自身份、短文字和世界坐标', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    mapping.execute({ commandId: randomUUID(), projectId: 'p', type: 'project.create', expected: null, payload: { name: '基础形状' } }, human);
    const inputs = [
      { id: 'rounded', content: { shapeType: 'roundedRectangle', shortText: '圆角观察' }, pose: { x: -20, y: 40, width: 160, height: 90 } },
      { id: 'ellipse', content: { shapeType: 'ellipse', shortText: '椭圆范围' }, pose: { x: 220, y: -80, width: 180, height: 110 } },
      { id: 'diamond', content: { shapeType: 'diamond', shortText: '菱形判断\n待核实' }, pose: { x: 450, y: 30, width: 140, height: 120 } },
      { id: 'triangle', content: { shapeType: 'triangle', shortText: '三角情景' }, pose: { x: 600, y: 260, width: 150, height: 130 } },
    ];
    for (const input of inputs)
      mapping.execute({ commandId: randomUUID(), projectId: 'p', type: 'shape.create', expected: null, payload: input }, human);
    type State = { cards: unknown[]; shapes: { id: string; kind: string; content: { shapeType: string; shortText: string }; item: { id: string; pose: { x: number; y: number; width: number; height: number } } }[] };
    const before = mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    expect(before.cards).toEqual([]);
    expect(before.shapes).toHaveLength(4);
    for (const input of inputs) {
      const shape = before.shapes.find(value => value.id === input.id)!;
      expect(shape).toMatchObject({ id: input.id, kind: 'shape', content: input.content, item: { id: expect.any(String), pose: input.pose } });
      expect(shape).not.toHaveProperty('body');
    }
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    const reopened = mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    expect(reopened.shapes).toEqual(before.shapes);
    expect(reopened.cards).toEqual([]);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('矩形的明确填充、轮廓和粗细经公开读取与 SQLite 重开原样保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  let mapping = openMapping(directory);
  try {
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    mapping.execute({ commandId: randomUUID(), projectId: 'p', type: 'project.create', expected: null, payload: { name: '形状外观' } }, human);
    const content = { shapeType: 'rectangle', shortText: '重点观察\n下一次披露', fill: '#f4e9b9', stroke: '#403b36', strokeWidth: 2 };
    const pose = { x: 75, y: -35, width: 210, height: 120 };
    mapping.execute({ commandId: randomUUID(), projectId: 'p', type: 'shape.create', expected: null, payload: { id: 'styled-rectangle', content, pose } }, human);
    type State = { cards: unknown[]; shapes: { id: string; kind: string; content: typeof content; item: { id: string; pose: typeof pose } }[] };
    const before = mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    expect(before.cards).toEqual([]);
    expect(before.shapes).toHaveLength(1);
    const shape = before.shapes[0]!;
    expect(shape).toMatchObject({ id: 'styled-rectangle', kind: 'shape', item: { id: expect.any(String), pose } });
    expect(shape.content).toEqual(content);
    expect(shape).not.toHaveProperty('body');
    mapping.close();
    mapping = openMapping(directory);
    human = mapping.access.authenticate(token);
    const reopened = mapping.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    expect(reopened.shapes).toEqual([shape]);
    expect(reopened.cards).toEqual([]);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('形状内容编辑与撤销重做只推进内容版本，完整 item 和原卡不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const execute = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    execute({ type: 'project.create', expected: null, payload: { name: '形状编辑' } });
    execute({ type: 'thought.create', expected: null, payload: { id: 'protected-card', title: '保留原卡', text: '不随形状编辑改变', x: 700, y: 500 } });
    const protectedCards = mapping.read({ type: 'project', projectId: 'p' }, human).cards;
    const originalContent = { shapeType: 'rectangle', shortText: '原观察', fill: '#f4e9b9', stroke: '#403b36', strokeWidth: 2 };
    const changedContent = { shapeType: 'rectangle', shortText: '修改后的观察\n继续验证', fill: '#dce8dd', stroke: '#ad343e', strokeWidth: 3 };
    execute({ type: 'shape.create', expected: null, payload: { id: 'edited-rectangle', content: originalContent, pose: { x: -200, y: 300, width: 210, height: 120 } } });
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    const created = state().shapes![0]!;
    execute({ type: 'shape.edit', expected: created.versionId, payload: { id: created.id, content: changedContent } });
    const edited = state().shapes![0]!;
    expect(edited.id).toBe(created.id);
    expect(edited.content).toEqual(changedContent);
    expect(edited.versionId).not.toBe(created.versionId);
    expect(edited.item).toEqual(created.item);
    expect(state().cards).toEqual(protectedCards);
    execute({ type: 'history.undo', expected: state().project.revision, payload: {} });
    const undone = state().shapes![0]!;
    expect(undone).toMatchObject({ id: created.id, content: originalContent, item: created.item });
    expect(undone.versionId).not.toBe(created.versionId);
    expect(undone.versionId).not.toBe(edited.versionId);
    expect(undone.item).toEqual(created.item);
    expect(state().cards).toEqual(protectedCards);
    execute({ type: 'history.redo', expected: state().project.revision, payload: {} });
    const redone = state().shapes![0]!;
    expect(redone).toMatchObject({ id: created.id, content: changedContent, item: created.item });
    expect(redone.versionId).not.toBe(edited.versionId);
    expect(redone.versionId).not.toBe(undone.versionId);
    expect(redone.item).toEqual(created.item);
    expect(state().cards).toEqual(protectedCards);
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('形状移动和内容独立版本，移动撤销重做保留已编辑内容，旧版本写入不改变状态', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  const mapping = openMapping(directory);
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const execute = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    execute({ type: 'project.create', expected: null, payload: { name: '形状位置' } });
    const originalContent = { shapeType: 'rectangle', shortText: '原观察', fill: '#f4e9b9', stroke: '#403b36', strokeWidth: 2 };
    const editedContent = { ...originalContent, shortText: '已编辑的内容' };
    const originalPose = { x: -200, y: 300, width: 210, height: 120 };
    execute({ type: 'shape.create', expected: null, payload: { id: 'moving-shape', content: originalContent, pose: originalPose } });
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    const created = state().shapes![0]!;
    execute({ type: 'shape.edit', expected: created.versionId, payload: { id: created.id, content: editedContent } });
    const edited = state().shapes![0]!;
    execute({ type: 'shape.move', expected: created.item.versionId, payload: { id: created.id, x: 140, y: -60 } });
    const moved = state().shapes![0]!;
    expect(moved).toMatchObject({ id: created.id, content: editedContent, versionId: edited.versionId, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose: { x: 140, y: -60, width: 210, height: 120 } } });
    expect(moved.item.versionId).not.toBe(created.item.versionId);
    execute({ type: 'history.undo', expected: state().project.revision, payload: {} });
    const undone = state().shapes![0]!;
    expect(undone).toMatchObject({ id: created.id, content: editedContent, versionId: edited.versionId, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose: originalPose } });
    expect(undone.item.versionId).not.toBe(created.item.versionId);
    expect(undone.item.versionId).not.toBe(moved.item.versionId);
    execute({ type: 'history.redo', expected: state().project.revision, payload: {} });
    const redone = state().shapes![0]!;
    expect(redone).toMatchObject({ id: created.id, content: editedContent, versionId: edited.versionId, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose: { x: 140, y: -60, width: 210, height: 120 } } });
    expect(redone.item.versionId).not.toBe(moved.item.versionId);
    expect(redone.item.versionId).not.toBe(undone.item.versionId);
    for (const stale of [
      { type: 'shape.edit', expected: created.versionId, payload: { id: created.id, content: originalContent } },
      { type: 'shape.move', expected: created.item.versionId, payload: { id: created.id, x: 900, y: 900 } },
    ]) {
      const beforeFailure = state();
      let failure: unknown;
      try { execute(stale); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(state()).toEqual(beforeFailure);
    }
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
