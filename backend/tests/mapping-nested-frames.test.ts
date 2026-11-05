import { captureSpatial, spatialItems } from '../src/mapping/frame-spatial.js';
import { afterEach, expect, it } from 'vitest';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';
import { createFrameCommand, moveFrameCommand } from './nested-frame-fixture.js';

afterEach(closeGroupFixtures);
it('三层分区的父移动带每层及普通后代恰好一次，撤销重开保留子树', () => {
  const f = groupFixture();
  for (const pose of [{ x: 0, y: 0, width: 900, height: 700 }, { x: 50, y: 70, width: 650, height: 500 }, { x: 120, y: 140, width: 300, height: 250 }])
    f.execute(createFrameCommand(f.state(), [], pose));
  const before = f.state(), [outer, middle, inner] = before.frames!;
  expect(before.containment!.find(c => c.id === middle!.id)?.parent).toEqual({ kind: 'frame', id: outer!.id });
  expect(before.containment!.find(c => c.id === inner!.id)?.parent).toEqual({ kind: 'frame', id: middle!.id });
  const card = f.card();
  const at = f.state();
  f.execute(moveFrameCommand(at, at.frames![0]!, 100, 50));
  expect(f.state().frames!.map(v => v.pose)).toEqual([
    { x: 100, y: 50, width: 900, height: 700 }, { x: 150, y: 120, width: 650, height: 500 }, { x: 220, y: 190, width: 300, height: 250 },
  ]);
  expect(f.state().cards[0]!.item.pose).toMatchObject({ x: card.item.pose.x + 100, y: card.item.pose.y + 50 });
  expect(f.mapping.observe({ projectId: 'p', afterRevision: at.project.revision }, f.human).changes).toHaveLength(1);
  f.travel('history.undo'); expect(f.state().frames!.map(v => v.pose)).toEqual(before.frames!.map(v => v.pose));
  f.travel('history.redo'); const moved = f.state(); f.reopen(); expect(f.state()).toEqual(moved);
});

it('直接拖放按指针而非对象中心进入唯一内层；成员单独拖动不拆组，旧候选集合原子拒绝', () => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: 100, y: 100, width: 500, height: 400 }));
  f.execute(createFrameCommand(f.state(), [], { x: 200, y: 200, width: 150, height: 120 }));
  const shape = f.shape(), snapshot = f.state(), inner = snapshot.frames![1]!;
  const command = { type: 'shape.move', expected: shape.item.versionId, placement: { expected: captureSpatial(snapshot), point: { x: 210, y: 210 } },
    payload: { id: shape.id, x: 0, y: 0 } };
  f.execute(command);
  expect(f.state().containment!.find(v => v.id === shape.item.id)?.parent).toEqual({ kind: 'frame', id: inner.id });
  f.travel('history.undo'); expect(f.state().containment!.find(v => v.id === shape.item.id)?.parent ?? null).toBeNull();
  const stale = { ...command, expected: f.state().shapes![0]!.item.versionId, placement: { expected: captureSpatial(f.state()), point: { x: 210, y: 210 } } };
  f.execute(createFrameCommand(f.state(), [], { x: 800, y: 800, width: 100, height: 100 }));
  const before = f.state(), history = f.history();
  expect(() => f.execute(stale)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
});

it('resize收纳完整新成员、保留相交、释放离开且不动成员，一步历史并删除嵌套框自身边', () => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: 0, y: 0, width: 900, height: 700 }));
  f.execute(createFrameCommand(f.state(), [], { x: 50, y: 0, width: 400, height: 300 }));
  const shape = f.shape(), text = f.text();
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'new', content: { shapeType: 'rectangle', shortText: '新收纳' }, pose: { x: 500, y: 80, width: 80, height: 50 } } });
  const before = f.state(), frame = before.frames![1]!, history = f.history();
  f.execute({ type: 'frame.resize', placement: { expected: captureSpatial(before) }, expected: frame.versionId,
    payload: { id: frame.id, pose: { x: 340, y: 10, width: 300, height: 180 } } });
  const resized = f.state();
  expect(resized.frames![1]!.memberItemIds).toEqual([shape.item.id, resized.shapes!.find(v => v.id === 'new')!.item.id]);
  expect(resized.containment!.find(v => v.id === text.item.id)?.parent ?? null).toBeNull();
  expect(resized.containment!.find(v => v.id === frame.id)?.parent).toEqual({ kind: 'frame', id: before.frames![0]!.id });
  expect(resized.shapes).toEqual(before.shapes); expect(resized.texts).toEqual(before.texts);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.travel('history.undo'); expect(f.state().frames![1]!.pose).toEqual(frame.pose);
  f.travel('history.redo');
  const deleting = f.state(), target = deleting.frames![1]!;
  f.execute({ type: 'frame.delete', expected: { frame: target.versionId,
    containment: Object.fromEntries(deleting.containment!.filter(v => v.id === target.id || v.parent?.id === target.id).map(v => [v.id, v.versionId])) }, payload: { id: target.id } });
  expect(f.state().containment!.some(v => v.id === target.id || v.parent?.id === target.id)).toBe(false);
  f.travel('history.undo'); expect(f.state().frames!.map(v => v.id)).toEqual(before.frames!.map(v => v.id));
  const restored = f.state(); f.reopen(); expect(f.state()).toEqual(restored);
});

it('分区内新建普通对象可以同父组合，整组拖出不拆组，单组员跨界仍保留组合', () => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: 0, y: 0, width: 800, height: 600 }));
  const a = f.shape('a'), b = f.text('b'), group = f.group([a.item.id, b.item.id]);
  expect(f.state().containment!.find(v => v.id === group.itemId)?.parent).toEqual({ kind: 'frame', id: f.state().frames![0]!.id });
  let s = f.state();
  f.execute({ type: 'group.move', placement: { expected: captureSpatial(s), point: { x: 1000, y: 1000 } },
    expected: { group: group.versionId, containment: f.structure().containment, poses: Object.fromEntries(spatialItems(s).map(v => [v.item.id, v.item.versionId])) }, payload: { id: group.id, dx: 700, dy: 700 } });
  expect(f.state().containment!.find(v => v.id === group.itemId)?.parent).toBeNull();
  s = f.state();
  f.execute({ type: 'shape.move', expected: s.shapes![0]!.item.versionId, placement: { expected: captureSpatial(s), point: { x: 100, y: 100 } }, payload: { id: a.id, x: 100, y: 100 } });
  expect(f.state().groups![0]!.memberItemIds).toEqual(group.memberItemIds);
  expect(f.state().containment!.find(v => v.id === a.item.id)?.parent).toEqual({ kind: 'group', id: group.itemId });
});

it('父子框同批删除保留普通内容与释放边，无悬挂归属且undo恢复完整树', () => {
  const f = groupFixture();
  for (const pose of [{ x: 0, y: 0, width: 900, height: 700 }, { x: 50, y: 0, width: 500, height: 350 }])
    f.execute(createFrameCommand(f.state(), [], pose));
  f.shape(); const before = f.state();
  f.execute({ type: 'canvas.delete-selection', expected: { groups: {}, frames: Object.fromEntries(before.frames!.map(v => [v.id, v.versionId])),
    containment: Object.fromEntries(before.containment!.map(v => [v.id, v.versionId])), items: {}, connectors: {} },
    payload: { groupIds: [], directItemIds: [], frameIds: before.frames!.map(v => v.id) } });
  expect(f.state().frames).toEqual([]); expect(f.state().shapes).toEqual(before.shapes);
  expect(f.state().containment!.every(v => v.parent === null)).toBe(true);
  f.travel('history.undo'); expect(f.state().frames!.map(v => v.id)).toEqual(before.frames!.map(v => v.id));
  const restoredMemberships = f.state().containment!;
  expect(restoredMemberships).toHaveLength(before.containment!.length);
  expect(new Set(restoredMemberships.map(v => v.id)).size).toBe(restoredMemberships.length);
  expect(restoredMemberships.map(v => [v.id, v.parent]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    .toEqual(before.containment!.map(v => [v.id, v.parent]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  f.travel('history.redo'); const after = f.state(); f.reopen(); expect(f.state()).toEqual(after);
});

it('undo/redo恢复原指针归属而不按对象中心重新分配', () => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: 500, y: 500, width: 300, height: 300 }));
  const shape = f.shape(), s = f.state();
  f.execute({ type: 'shape.move', expected: shape.item.versionId, placement: { expected: captureSpatial(s), point: { x: 600, y: 600 } }, payload: { id: shape.id, x: 0, y: 0 } });
  const framed = f.state(), current = framed.shapes![0]!, frame = framed.frames![0]!;
  f.execute({ type: 'shape.delete', expected: { shape: current.versionId, pose: current.item.versionId,
    membership: { frame: { id: frame.id, versionId: frame.versionId }, containment: framed.containment![0]!.versionId } }, payload: { id: current.id } });
  f.travel('history.undo');
  expect(f.state().containment!.find(v => v.id === shape.item.id)?.parent).toEqual({ kind: 'frame', id: frame.id });
  f.travel('history.redo'); expect(f.state().shapes).toEqual([]);
});

it('五类普通新对象按中心进入最内层，原文与各自类型保持', () => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: -100, y: -100, width: 1000, height: 600 }));
  f.execute(createFrameCommand(f.state(), [], { x: -50, y: -50, width: 700, height: 500 }));
  const values = [f.card(), f.text(), f.shape(), f.image(), f.stroke()];
  const s = f.state(), inner = s.frames![1]!;
  expect(s.containment!.filter(v => values.some(item => item.item.id === v.id)).map(v => v.parent))
    .toEqual(values.map(() => ({ kind: 'frame', id: inner.id })));
  expect(s.cards[0]!.body.blocks[0]).toMatchObject({ text: '原始正文' });
});

it('普通单对象duplicate与paste按新中心归属，不继承原容器或开放容器复制', () => {
  const f = groupFixture(), shape = f.shape();
  f.execute(createFrameCommand(f.state(), [], { x: 365, y: 0, width: 400, height: 400 }));
  f.execute({ type: 'canvas.duplicate', expected: { cards: {}, texts: {}, shapes: { [shape.id]: { content: shape.versionId, pose: shape.item.versionId } }, images: {}, strokes: {}, connectors: {}, anchors: {} },
    payload: { objects: [{ kind: 'shape', id: shape.id, copyId: 'copy' }], connectors: [] } });
  const duplicated = f.state(), copy = duplicated.shapes!.find(v => v.id === 'copy')!;
  expect(duplicated.containment!.find(v => v.id === copy.item.id)?.parent).toEqual({ kind: 'frame', id: duplicated.frames![0]!.id });
  expect(duplicated.containment!.some(v => v.id === shape.item.id)).toBe(false);
  f.execute({ type: 'canvas.paste', expected: null, payload: { translation: { x: 100, y: 0 }, connectors: [], objects: [{ kind: 'shape', copyId: 'pasted', stack: 1, content: shape.content, pose: shape.item.pose }] } });
  const pasted = f.state(), pastedItem = pasted.shapes!.find(v => v.id === 'pasted')!;
  expect(pasted.containment!.find(v => v.id === pastedItem.item.id)?.parent).toEqual({ kind: 'frame', id: pasted.frames![0]!.id });
  expect(pasted.frames).toHaveLength(1); expect(pasted.groups).toEqual([]);
  f.travel('history.undo'); expect(f.state().shapes!.some(v => v.id === 'pasted')).toBe(false);
  f.travel('history.redo'); expect(f.state().containment!.find(v => v.id === pastedItem.item.id)?.parent).toEqual({ kind: 'frame', id: pasted.frames![0]!.id });
});

it('跨枝重叠先排祖先再按Frame前景，新普通对象按同一候选归属', () => {
  const f = groupFixture();
  for (const pose of [{ x: 0, y: 0, width: 1000, height: 800 }, { x: 100, y: 100, width: 500, height: 400 }, { x: 50, y: 150, width: 650, height: 500 }])
    f.execute(createFrameCommand(f.state(), [], pose));
  const before = f.state();
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'overlap', content: { shapeType: 'rectangle', shortText: '前景' }, pose: { x: 175, y: 175, width: 50, height: 50 } } });
  const s = f.state(); expect(s.containment!.find(v => v.id === s.shapes![0]!.item.id)?.parent).toEqual({ kind: 'frame', id: before.frames![2]!.id });
  const move = moveFrameCommand(s, s.frames![0]!, 1, 1);
  move.placement.point = { x: 200, y: 200 };
  f.execute(move);
  expect(f.state().containment!.find(v => v.id === before.frames![0]!.id)?.parent ?? null).toBeNull();
  expect(f.state().frames!.map(v => v.id)).toEqual(before.frames!.map(v => v.id));
  f.travel('history.undo'); const undone = f.state(); f.reopen(); expect(f.state()).toEqual(undone);
});

it('resize预览后新增普通对象使旧请求原子拒绝，失败commandId可修正后重试', () => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: 0, y: 0, width: 900, height: 700 }));
  const before = f.state(), command = { commandId: 'resize-retry', type: 'frame.resize', placement: { expected: captureSpatial(before) }, expected: before.frames![0]!.versionId,
    payload: { id: before.frames![0]!.id, pose: { x: 0, y: 0, width: 300, height: 200 } } };
  f.shape(); const current = f.state(), history = f.history();
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(current); expect(f.history()).toEqual(history);
  const corrected = { ...command, placement: { expected: captureSpatial(current) } };
  const receipt = f.execute(corrected); expect(f.execute(corrected)).toEqual(receipt);
  expect(f.state().frames![0]!.pose.width).toBe(300);
});

it('Frame-index分页与删除撤销/同库重开保持实际绘制序', () => {
  const f = groupFixture();
  for (let i = 0; i < 14; i++) f.execute(createFrameCommand(f.state(), [], { x: i * 1000, y: 0, width: 400, height: 300 }));
  const before = f.state(), ids: string[] = [];
  let page = f.mapping.read({ type: 'map', projectId: 'p', view: 'frame-index', budget: 1600 }, f.human);
  ids.push(...page.items.map(v => v.id));
  let pages = 1;
  while (page.nextCursor) {
    page = f.mapping.read({ type: 'map', projectId: 'p', view: 'frame-index', budget: 1600, snapshot: page.snapshot, cursor: page.nextCursor }, f.human);
    ids.push(...page.items.map(v => v.id)); pages++;
  }
  expect(pages).toBeGreaterThan(1); expect(ids).toEqual(before.frames!.map(v => v.id));
  f.execute({ type: 'frame.delete', expected: { frame: before.frames![4]!.versionId, containment: {} }, payload: { id: before.frames![4]!.id } });
  f.travel('history.undo'); expect(f.state().frames!.map(v => v.id)).toEqual(ids);
  const restored = f.state(); f.reopen(); expect(f.state()).toEqual(restored);
});
