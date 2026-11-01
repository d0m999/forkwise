import { afterEach, expect, it } from 'vitest';
import { closeGroupFixtures, groupDeleteExpected, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);

it('空分区创建、改名和背景经 undo/redo 与重开保持，默认无正文且版本可独立读取', () => {
  const f = groupFixture();
  const before = f.state();
  f.execute({ type: 'frame.create',
    expected: { frame: null, groups: {}, containment: {}, poses: {} },
    payload: { id: 'frame', itemIds: [], pose: { x: 40, y: 50, width: 300, height: 200 } } });
  const created = f.state(), frame = created.frames![0]!;
  expect(frame).toMatchObject({ id: 'frame', kind: 'frame', name: '分区1', background: null, memberItemIds: [],
    pose: { x: 40, y: 50, width: 300, height: 200 } });
  expect(frame).not.toHaveProperty('body');
  expect(created.project.revision).toBe(before.project.revision + 1);
  expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'frame', id: frame.id, versionId: frame.versionId }, f.human)).toMatchObject({ id: 'frame', name: '分区1' });
  expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes[0]!.domains)
    .toEqual([{ domain: 'frame', id: 'frame' }]);

  const editedReceipt = f.execute({ type: 'frame.edit', expected: frame.versionId,
    payload: { id: 'frame', name: '行业研究', background: '#f5f5f5' } });
  expect(f.state().frames![0]).toMatchObject({ name: '行业研究', background: '#f5f5f5' });
  f.travel('history.undo');
  expect(f.state().frames![0]).toMatchObject({ name: '分区1', background: null });
  f.travel('history.undo');
  expect(f.state().frames).toEqual([]);
  f.travel('history.redo');
  expect(f.state().frames![0]).toMatchObject({ id: 'frame', name: '分区1' });
  f.travel('history.redo');
  const restored = f.state();
  expect(restored.frames![0]).toMatchObject({ name: '行业研究', background: '#f5f5f5' });
  f.reopen();
  expect(f.state()).toEqual(restored);
  expect(f.execute({ type: 'frame.edit', expected: frame.versionId, payload: { id: 'frame', name: '行业研究', background: '#f5f5f5' }, commandId: editedReceipt.commandId })).toEqual(editedReceipt);
});

it('创建分区只收纳完整对象，Group 作为整体保持内部归属并可一次撤销', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape();
  const group = f.group([text.item.id, shape.item.id]);
  const before = f.state();
  f.execute({ type: 'frame.create',
    expected: {
      frame: null,
      groups: { [group.id]: group.versionId },
      containment: { [card.item.id]: null, [group.itemId]: null },
      poses: { [card.item.id]: card.item.versionId, [text.item.id]: text.item.versionId, [shape.item.id]: shape.item.versionId },
    },
    payload: { id: 'frame', itemIds: [card.item.id, group.itemId], pose: { x: 0, y: 0, width: 800, height: 400 } } });
  const created = f.state(), frame = created.frames![0]!;
  expect(frame.memberItemIds).toEqual([card.item.id, group.itemId]);
  expect(created.containment).toEqual([
    { id: text.item.id, versionId: expect.any(String), parent: { kind: 'group', id: group.itemId } },
    { id: shape.item.id, versionId: expect.any(String), parent: { kind: 'group', id: group.itemId } },
    { id: card.item.id, versionId: expect.any(String), parent: { kind: 'frame', id: frame.id } },
    { id: group.itemId, versionId: expect.any(String), parent: { kind: 'frame', id: frame.id } },
  ]);
  expect(created.groups![0]!.memberItemIds).toEqual([text.item.id, shape.item.id]);
  f.travel('history.undo');
  expect(f.state().frames).toEqual([]);
  expect(f.state().containment).toEqual(before.containment);
  f.travel('history.redo');
  expect(f.state().frames![0]!.memberItemIds).toEqual([card.item.id, group.itemId]);
});

it('部分框入对象或部分 Group 拒绝创建且不留下半套分区或归属', () => {
  const f = groupFixture(), text = f.text(), shape = f.shape();
  const group = f.group([text.item.id, shape.item.id]);
  const before = f.state(), history = f.history();
  expect(() => f.execute({ type: 'frame.create',
    expected: {
      frame: null,
      groups: { [group.id]: group.versionId },
      containment: { [group.itemId]: null },
      poses: { [text.item.id]: text.item.versionId, [shape.item.id]: shape.item.versionId },
    },
    payload: { id: 'frame', itemIds: [group.itemId], pose: { x: 90, y: 10, width: 120, height: 100 } } }))
    .toThrowError(expect.objectContaining({ code: 'INVALID_FRAME_MEMBER', status: 400 }));
  expect(f.state()).toEqual(before);
  expect(f.history()).toEqual(history);
});

it('移动整框使直接成员和 Group 成员各只移动一次，保序保归属并一步撤销', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape();
  const group = f.group([text.item.id, shape.item.id]);
  f.execute({ type: 'frame.create',
    expected: { frame: null, groups: { [group.id]: group.versionId }, containment: { [card.item.id]: null, [group.itemId]: null },
      poses: { [card.item.id]: card.item.versionId, [text.item.id]: text.item.versionId, [shape.item.id]: shape.item.versionId } },
    payload: { id: 'frame', itemIds: [card.item.id, group.itemId], pose: { x: 0, y: 0, width: 800, height: 400 } } });
  const before = f.state(), frame = before.frames![0]!;
  const membership = Object.fromEntries(before.containment!.map(value => [value.id, value.versionId]));
  f.execute({ type: 'frame.move',
    expected: { frame: frame.versionId, groups: { [group.id]: group.versionId }, containment: membership,
      poses: { [card.item.id]: card.item.versionId, [text.item.id]: text.item.versionId, [shape.item.id]: shape.item.versionId } },
    payload: { id: frame.id, dx: 25, dy: 35 } });
  const moved = f.state();
  expect(moved.frames![0]!.pose).toEqual({ x: 25, y: 35, width: 800, height: 400 });
  for (const [kind, original] of [['cards', card], ['texts', text], ['shapes', shape]] as const) {
    const current = moved[kind]![0]!;
    expect(current.item.pose).toEqual({ ...original.item.pose, x: original.item.pose.x + 25, y: original.item.pose.y + 35 });
    expect(current.item.createdOrder).toBe(original.item.createdOrder);
  }
  expect(moved.containment).toEqual(before.containment);
  expect(moved.project.revision).toBe(before.project.revision + 1);
  f.travel('history.undo');
  expect(f.state().frames![0]!.pose).toEqual(frame.pose);
  expect(f.state().cards[0]!.item.pose).toEqual(card.item.pose);
  expect(f.state().texts![0]!.item.pose).toEqual(text.item.pose);
  expect(f.state().shapes![0]!.item.pose).toEqual(shape.item.pose);
  f.travel('history.redo');
  expect(f.state().frames![0]!.pose).toEqual(moved.frames![0]!.pose);
});

it('删框只释放直接成员，保留 Group、成员间线和内容并可撤销恢复', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape();
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'member-line',
    start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: text.item.id, side: 'left' } } });
  const group = f.group([text.item.id, shape.item.id]);
  f.execute({ type: 'frame.create',
    expected: { frame: null, groups: { [group.id]: group.versionId }, containment: { [card.item.id]: null, [group.itemId]: null },
      poses: { [card.item.id]: card.item.versionId, [text.item.id]: text.item.versionId, [shape.item.id]: shape.item.versionId } },
    payload: { id: 'frame', itemIds: [card.item.id, group.itemId], pose: { x: 0, y: 0, width: 800, height: 400 } } });
  const before = f.state(), frame = before.frames![0]!;
  f.execute({ type: 'frame.delete', expected: { frame: frame.versionId,
    containment: Object.fromEntries([card.item.id, group.itemId].map(id => [id, before.containment!.find(value => value.id === id)!.versionId])) },
    payload: { id: frame.id } });
  const deleted = f.state();
  expect(deleted.frames).toEqual([]);
  expect(deleted.cards).toEqual(before.cards);
  expect(deleted.groups).toEqual(before.groups);
  expect(deleted.connectors).toEqual(before.connectors);
  expect(deleted.containment).toEqual([
    { id: text.item.id, versionId: expect.any(String), parent: { kind: 'group', id: group.itemId } },
    { id: shape.item.id, versionId: expect.any(String), parent: { kind: 'group', id: group.itemId } },
    { id: card.item.id, versionId: expect.any(String), parent: null },
    { id: group.itemId, versionId: expect.any(String), parent: null },
  ]);
  f.travel('history.undo');
  expect(f.state().frames![0]!.memberItemIds).toEqual([card.item.id, group.itemId]);
  expect(f.state().connectors).toEqual(before.connectors);
  f.travel('history.redo');
  const redone = f.state();
  expect(redone.frames).toEqual([]);
  expect(redone.cards).toEqual(before.cards);
  expect(redone.groups).toEqual(before.groups);
  expect(redone.connectors).toEqual(before.connectors);
  expect(redone.containment!.map(value => [value.id, value.parent])).toEqual(deleted.containment!.map(value => [value.id, value.parent]));
});

it('删除框内普通成员只移除该成员及归属，空 Frame 保留', () => {
  const f = groupFixture(), card = f.card();
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: { [card.item.id]: null }, poses: { [card.item.id]: card.item.versionId } },
    payload: { id: 'frame', itemIds: [card.item.id], pose: { x: 0, y: 0, width: 800, height: 400 } } });
  const before = f.state(), frame = before.frames![0]!, membership = before.containment!.find(value => value.id === card.item.id)!;
  f.execute({ type: 'thought.delete', expected: {
    thought: card.versionId, body: card.body.versionId, pose: card.item.versionId,
    appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null,
    membership: { frame: { id: frame.id, versionId: frame.versionId }, containment: membership.versionId },
  }, payload: { id: card.id } });
  const deleted = f.state();
  expect(deleted.cards).toEqual([]);
  expect(deleted.frames![0]!.memberItemIds).toEqual([]);
  expect(deleted.containment).toEqual([]);
  f.travel('history.undo');
  expect(f.state().cards[0]).toMatchObject({ id: card.id, title: card.title,
    body: { blocks: card.body.blocks }, item: { pose: card.item.pose } });
  expect(f.state().cards[0]!.versionId).not.toBe(card.versionId);
  expect(f.state().frames![0]!.memberItemIds).toEqual([card.item.id]);
});

it('批量删除框内 Group 同时清理 Group 自身归属，Frame 保留且可撤销', () => {
  const f = groupFixture(), text = f.text(), shape = f.shape();
  const group = f.group([text.item.id, shape.item.id]);
  f.execute({ type: 'frame.create', expected: { frame: null, groups: { [group.id]: group.versionId }, containment: { [group.itemId]: null },
    poses: { [text.item.id]: text.item.versionId, [shape.item.id]: shape.item.versionId } },
    payload: { id: 'frame', itemIds: [group.itemId], pose: { x: 0, y: 0, width: 800, height: 400 } } });
  const before = f.state(), frame = before.frames![0]!;
  const base = groupDeleteExpected(f, group.id);
  const expected = { groups: { [group.id]: base.group }, containment: base.containment, items: base.items, connectors: base.connectors,
    frames: { [frame.id]: frame.versionId } };
  expected.containment[group.itemId] = before.containment!.find(value => value.id === group.itemId)!.versionId;
  f.execute({ type: 'canvas.delete-selection', expected, payload: { groupIds: [group.id], directItemIds: [] } });
  const deleted = f.state();
  expect(deleted.groups).toEqual([]);
  expect(deleted.texts).toEqual([]);
  expect(deleted.shapes).toEqual([]);
  expect(deleted.frames![0]!.memberItemIds).toEqual([]);
  expect(deleted.containment).toEqual([]);
  f.travel('history.undo');
  expect(f.state().groups![0]!.memberItemIds).toEqual([text.item.id, shape.item.id]);
  expect(f.state().frames![0]!.memberItemIds).toEqual([group.itemId]);
});

it('Compact frame-index 固定同一快照的名称、外观、姿态和成员数', () => {
  const f = groupFixture(), card = f.card();
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: { [card.item.id]: null }, poses: { [card.item.id]: card.item.versionId } },
    payload: { id: 'frame', itemIds: [card.item.id], pose: { x: 0, y: 0, width: 800, height: 400 } } });
  const frame = f.state().frames![0]!;
  const pinned = f.mapping.read({ type: 'map', projectId: 'p', view: 'frame-index' }, f.human);
  expect(pinned).toMatchObject({ fidelity: 'frame-index', revision: frame ? f.state().project.revision : 0,
    items: [{ id: frame.id, type: 'frame', name: '分区1', background: null, memberCount: 1, pose: frame.pose }] });
  expect(pinned.items[0]).not.toHaveProperty('body');
  f.execute({ type: 'frame.edit', expected: frame.versionId, payload: { id: frame.id, name: '新版分区', background: '#eeeeee' } });
  const latest = f.mapping.read({ type: 'map', projectId: 'p', view: 'frame-index' }, f.human);
  expect(latest.items[0]).toMatchObject({ name: '新版分区', background: '#eeeeee' });
  expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'frame-index', snapshot: pinned.snapshot }, f.human).items[0])
    .toMatchObject({ name: '分区1', background: null });
});
