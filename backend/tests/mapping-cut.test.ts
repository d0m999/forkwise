import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { captureCutCommand } from '../src/mapping/cut-command.js';
import { snapshotScope } from '../src/mapping/snapshot-tree.js';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);
type Fixture = ReturnType<typeof groupFixture>;

function cut(f: Fixture, cutId: string, selected: string[]) {
  const state = f.state();
  const scope = snapshotScope(state, selected);
  const itemIds = [...scope.ids].filter(id =>
    state.cards.some(value => value.item.id === id) || (state.texts ?? []).some(value => value.item.id === id) ||
    (state.shapes ?? []).some(value => value.item.id === id) || (state.images ?? []).some(value => value.item.id === id) ||
    (state.strokes ?? []).some(value => value.item.id === id));
  const groupIds = (state.groups ?? []).filter(value => scope.ids.has(value.itemId)).map(value => value.id);
  const frameIds = (state.frames ?? []).filter(value => scope.ids.has(value.id)).map(value => value.id);
  return f.execute(captureCutCommand(state, { commandId: crypto.randomUUID(), projectId: 'p', cutId, itemIds, groupIds, frameIds }));
}
function pasteCut(f: Fixture, cutId: string, cutRevision = 0, translation = { x: 100, y: 50 }) {
  return f.execute({ type: 'canvas.paste-cut', expected: { cut: cutId, cutRevision }, payload: { cutId, translation } });
}
function cutState(f: Fixture, cutId: string) {
  return f.mapping.read({ type: 'cut.state', projectId: 'p', cutId }, f.human);
}
function link(f: Fixture, id: string, start: string, end: string) {
  return f.execute({ type: 'connector.create', expected: null,
    payload: { id, start: { kind: 'bound', itemId: start, side: 'right' }, end: { kind: 'bound', itemId: end, side: 'left' }, path: 'straight' } });
}

it('剪切提交后移除对象，首次同项目粘贴恢复原身份并生成新版本', () => {
  const f = groupFixture();
  const card = f.card('a');
  cut(f, 'cut-1', [card.item.id]);
  expect(f.state().cards).toEqual([]);
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'eligible', revision: 0 });
  const receipt = pasteCut(f, 'cut-1');
  const restored = f.state().cards[0]!;
  expect(restored.id).toBe('a');
  expect(restored.item.id).toBe(card.item.id);
  expect(restored.versionId).not.toBe(card.versionId);
  expect(restored.item.pose).toEqual({ ...card.item.pose, x: card.item.pose.x + 100, y: card.item.pose.y + 50 });
  expect(receipt.cut).toMatchObject({ cutId: 'cut-1', state: 'consumed', revision: 1 });
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'consumed', revision: 1 });
});

it('资格已消费后再次首次粘贴被拒绝，不产生副本', () => {
  const f = groupFixture();
  const card = f.card('a');
  cut(f, 'cut-1', [card.item.id]);
  pasteCut(f, 'cut-1');
  const before = f.state();
  expect(() => pasteCut(f, 'cut-1')).toThrowError(expect.objectContaining({ code: 'CUT_STATE_CONFLICT' }));
  expect(f.state()).toEqual(before);
});

it('撤销剪切恢复原件与连线，资格转为 cut-undone', () => {
  const f = groupFixture();
  const a = f.card('a'), b = f.card('b');
  link(f, 'line', a.item.id, b.item.id);
  cut(f, 'cut-1', [a.item.id]);
  expect(f.state().connectors).toEqual([]);
  f.travel('history.undo');
  const restored = f.state();
  expect(restored.cards.map(card => card.id).sort()).toEqual(['a', 'b']);
  expect(restored.connectors!.map(line => line.id)).toEqual(['line']);
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'cut-undone' });
  expect(() => pasteCut(f, 'cut-1')).toThrowError(expect.objectContaining({ code: 'CUT_STATE_CONFLICT' }));
  expect(f.state()).toEqual(restored);
});

it('撤销首次粘贴后再次粘贴仍按首次搬动恢复原身份，redo 回到已消费', () => {
  const f = groupFixture();
  const card = f.card('a');
  cut(f, 'cut-1', [card.item.id]);
  pasteCut(f, 'cut-1');
  const pasted = f.state().cards[0]!;
  f.travel('history.undo');
  expect(f.state().cards).toEqual([]);
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'eligible', revision: 2 });
  pasteCut(f, 'cut-1', 2, { x: 10, y: 10 });
  expect(f.state().cards[0]!.id).toBe('a');
  expect(f.state().cards[0]!.id).toBe(pasted.id);
  f.travel('history.undo');
  f.travel('history.redo');
  expect(f.state().cards[0]!.id).toBe('a');
  expect(cutState(f, 'cut-1').state).toBe('consumed');
});

it('首次粘贴恢复外线，另一端已删除时只恢复卡片', () => {
  const f = groupFixture();
  const a = f.card('a'), b = f.card('b'), c = f.card('c');
  link(f, 'keep', a.item.id, b.item.id);
  link(f, 'drop', a.item.id, c.item.id);
  cut(f, 'cut-1', [a.item.id]);
  f.execute({ type: 'thought.delete', expected: { thought: c.versionId, body: c.body.versionId, pose: c.item.versionId, appearance: null, cardTags: null, connectors: {} }, payload: { id: 'c' } });
  // 外端删除按 AC2 跳过该线，不能被 P1 的版本比对误判成并发修改而整体拒绝。
  const receipt = pasteCut(f, 'cut-1');
  expect(receipt.cut).toMatchObject({ state: 'consumed' });
  const state = f.state();
  expect(state.cards.map(card => card.id).sort()).toEqual(['a', 'b']);
  expect(state.connectors!.map(line => line.id)).toEqual(['keep']);
  expect(state.connectors![0]!.start).toMatchObject({ kind: 'bound', itemId: a.item.id });
  expect(state.connectors![0]!.end).toMatchObject({ kind: 'bound', itemId: b.item.id });
});

it('外端在剪切后被修改时首次粘贴明确拒绝，原对象与历史不变', () => {
  const f = groupFixture();
  const a = f.card('a'), b = f.card('b');
  link(f, 'line', a.item.id, b.item.id);
  cut(f, 'cut-1', [a.item.id]);
  const moved = f.state().cards.find(card => card.id === 'b')!;
  f.execute({ type: 'card.edit', expected: { body: moved.body.versionId, pose: moved.item.versionId },
    payload: { id: 'b', text: '另一张卡片的新正文，长度明显增加以触发增高', x: 640, y: 480 } });
  const before = f.state();
  expect(() => pasteCut(f, 'cut-1')).toThrowError(expect.objectContaining({ code: 'CUT_OUTER_CHANGED' }));
  expect(f.state()).toEqual(before);
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'eligible', revision: 0 });
  expect(f.history().undo.every(action => action.label !== 'canvas.paste-cut')).toBe(true);
});

it('外端版本未变化时首次粘贴仍恢复外线', () => {
  const f = groupFixture();
  const a = f.card('a'), b = f.card('b');
  link(f, 'line', a.item.id, b.item.id);
  cut(f, 'cut-1', [a.item.id]);
  pasteCut(f, 'cut-1');
  expect(f.state().connectors!.map(line => line.id)).toEqual(['line']);
});

it('剪切整组子树后首次粘贴恢复内部归属与连接', () => {
  const f = groupFixture();
  const a = f.card('a'), b = f.card('b');
  const group = f.group([a.item.id, b.item.id]);
  link(f, 'inside', a.item.id, b.item.id);
  cut(f, 'cut-1', [group.itemId]);
  const gone = f.state();
  expect(gone.cards).toEqual([]);
  expect(gone.groups).toEqual([]);
  expect(gone.connectors).toEqual([]);
  pasteCut(f, 'cut-1');
  const state = f.state();
  expect(state.groups!.map(value => value.id)).toEqual(['g']);
  expect(state.groups![0]!.memberItemIds.sort()).toEqual([a.item.id, b.item.id].sort());
  expect(state.connectors!.map(line => line.id)).toEqual(['inside']);
  expect(state.cards.every(card => card.item.pose.x >= a.item.pose.x + 100 - 1)).toBe(true);
});

it('40 步历史裁剪后首次搬动资格与恢复资料仍可用', () => {
  const f = groupFixture();
  const card = f.card('a');
  cut(f, 'cut-1', [card.item.id]);
  for (let index = 0; index < 45; index++) {
    const created = f.state().cards[0]!;
    f.execute({ type: 'thought.create', expected: null, payload: { id: `filler-${index}`, title: `补白${index}`, text: '', x: 900 + index * 4, y: 900 } });
    void created;
  }
  expect(f.history().undo.every(action => action.label !== 'canvas.cut')).toBe(true);
  pasteCut(f, 'cut-1');
  expect(f.state().cards.some(value => value.id === 'a')).toBe(true);
});

it('同库重开后首次搬动资格、撤销与重做仍成立', () => {
  const f = groupFixture();
  const card = f.card('a');
  cut(f, 'cut-1', [card.item.id]);
  f.reopen();
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'eligible', revision: 0 });
  pasteCut(f, 'cut-1');
  f.reopen();
  expect(cutState(f, 'cut-1')).toMatchObject({ state: 'consumed', revision: 1 });
  f.travel('history.undo');
  expect(cutState(f, 'cut-1').state).toBe('eligible');
  f.travel('history.redo');
  expect(cutState(f, 'cut-1').state).toBe('consumed');
  expect(f.state().cards.map(value => value.id)).toEqual(['a']);
});

it('剪切后普通复制粘贴不改变首次搬动资格，仍恢复原身份', () => {
  const f = groupFixture();
  const a = f.card('a'), other = f.card('other');
  cut(f, 'cut-1', [a.item.id]);
  const frozen = f.state().cards[0]!;
  f.execute({ type: 'canvas.paste', expected: null, payload: {
    translation: { x: 200, y: 0 },
    objects: [{ kind: 'card', copyId: 'copy-1', stack: 1, title: frozen.title, blocks: frozen.body.blocks, tagIds: null, appearance: null, pose: frozen.item.pose }],
    connectors: [],
  } });
  expect(f.state().cards.map(value => value.id).sort()).toEqual(['copy-1', 'other']);
  expect(cutState(f, 'cut-1').state).toBe('eligible');
  pasteCut(f, 'cut-1');
  expect(f.state().cards.map(value => value.id).sort()).toEqual(['a', 'copy-1', 'other']);
  void other;
});

it('缺失剪切记录时拒绝粘贴，不猜测资格', () => {
  const f = groupFixture();
  f.card('a');
  expect(() => pasteCut(f, 'ghost')).toThrowError(expect.objectContaining({ code: 'CUT_NOT_FOUND' }));
  expect(() => f.mapping.read({ type: 'cut.state', projectId: 'p', cutId: 'ghost' }, f.human))
    .toThrowError(expect.objectContaining({ code: 'CUT_NOT_FOUND' }));
});

it('剪切嵌套分区子树后首次粘贴恢复分区、成员与内部连线', () => {
  const f = groupFixture();
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} },
    payload: { id: 'frame', itemIds: [], pose: { x: 0, y: 0, width: 900, height: 600 } } });
  // 先建分区，再在其中新建卡片：新建对象按既有落点规则自动归属。
  const a = f.card('a'), b = f.card('b');
  link(f, 'inside', a.item.id, b.item.id);
  const framed = f.state();
  expect(framed.frames!.map(value => value.id)).toEqual(['frame']);
  cut(f, 'cut-1', ['frame']);
  const gone = f.state();
  expect(gone.frames).toEqual([]);
  expect(gone.cards).toEqual([]);
  expect(gone.connectors).toEqual([]);
  pasteCut(f, 'cut-1', 0, { x: 40, y: 60 });
  const state = f.state();
  expect(state.frames!.map(value => value.id)).toEqual(['frame']);
  expect(state.frames![0]!.pose).toMatchObject({ x: 40, y: 60 });
  expect(state.cards.map(value => value.id).sort()).toEqual(['a', 'b']);
  expect(state.containment!.filter(value => value.parent?.kind === 'frame').length).toBe(2);
  expect(state.connectors!.map(line => line.id)).toEqual(['inside']);
});

it('剪切提交失败时不移除对象、不写历史也不产生剪切记录', () => {
  const f = groupFixture();
  const card = f.card('a');
  const state = f.state();
  const command = captureCutCommand(state, { commandId: crypto.randomUUID(), projectId: 'p', cutId: 'cut-1',
    itemIds: [card.item.id], groupIds: [], frameIds: [] });
  f.execute({ type: 'thought.title', expected: card.versionId, payload: { id: 'a', title: '改过标题' } });
  const before = f.state();
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(before);
  expect(f.history().undo.some(action => action.label === 'canvas.cut')).toBe(false);
  expect(() => cutState(f, 'cut-1')).toThrowError(expect.objectContaining({ code: 'CUT_NOT_FOUND' }));
});

it('只剪切组合成员时不复活未选组合，首次粘贴落在顶层并恢复外线', () => {
  const f = groupFixture();
  const a = f.card('a'), b = f.card('b'), outside = f.card('outside');
  const group = f.group([a.item.id, b.item.id]);
  link(f, 'outer', a.item.id, outside.item.id);
  cut(f, 'cut-1', [a.item.id]);
  const afterCut = f.state();
  expect(afterCut.groups!.map(value => value.id)).toEqual(['g']);
  expect(afterCut.groups![0]!.memberItemIds).toEqual([b.item.id]);
  expect(afterCut.connectors).toEqual([]);
  pasteCut(f, 'cut-1', 0, { x: 1200, y: 900 });
  const state = f.state();
  expect(state.cards.map(card => card.id).sort()).toEqual(['a', 'b', 'outside']);
  expect(state.containment!.find(value => value.id === a.item.id)?.parent ?? null).toBeNull();
  expect(state.groups![0]!.memberItemIds).toEqual([b.item.id]);
  expect(state.connectors!.map(line => line.id)).toEqual(['outer']);
  void group;
});

it('首次搬动只登记对象身份，不把 CanvasItem id 写进身份表', () => {
  const f = groupFixture();
  const card = f.card('a');
  cut(f, 'cut-1', [card.item.id]);
  pasteCut(f, 'cut-1');
  const db = new Database(join(f.directory, 'workspace.sqlite'), { readonly: true });
  try {
    expect(db.prepare('SELECT project_id FROM mapping_card_ids WHERE id=?').get(card.id)).toEqual({ project_id: 'p' });
    expect(db.prepare('SELECT 1 FROM mapping_card_ids WHERE id=?').get(card.item.id)).toBeUndefined();
  } finally { db.close(); }
});

it('剪切嵌套分区（分区套分区）后首次粘贴恢复自身归属校验与子树', () => {
  const f = groupFixture();
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} },
    payload: { id: 'outer', itemIds: [], pose: { x: 0, y: 0, width: 1400, height: 1000 } } });
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} },
    payload: { id: 'inner', itemIds: [], pose: { x: 100, y: 100, width: 500, height: 400 }, parentId: 'outer' } });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'a', title: '甲', text: '', x: 150, y: 150 } });
  const before = f.state();
  expect(before.frames!.map(value => value.id).sort()).toEqual(['inner', 'outer']);
  expect(before.containment!.find(value => value.id === 'inner')?.parent).toEqual({ kind: 'frame', id: 'outer' });
  cut(f, 'cut-1', ['inner']);
  const gone = f.state();
  expect(gone.frames!.map(value => value.id)).toEqual(['outer']);
  expect(gone.cards).toEqual([]);
  pasteCut(f, 'cut-1', 0, { x: 2000, y: 1500 });
  const state = f.state();
  expect(state.frames!.map(value => value.id).sort()).toEqual(['inner', 'outer']);
  expect(state.cards.map(card => card.id)).toEqual(['a']);
  expect(state.frames!.find(value => value.id === 'inner')!.memberItemIds).toEqual([before.cards[0]!.item.id]);
  expect(state.containment!.find(value => value.id === 'inner')?.parent ?? null).toBeNull();
});
