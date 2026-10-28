import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);
type Fixture = ReturnType<typeof groupFixture>;
function items(f: Fixture) {
  const s = f.state();
  return [...s.cards, ...s.texts!, ...s.shapes!, ...s.images!, ...s.strokes!];
}
function capture(f: Fixture, groupIds: string[], directItemIds: string[], dx = 40, dy = -10) {
  const s = f.state(), groups = s.groups!.filter(g => groupIds.includes(g.id));
  const ids = new Set([...groups.flatMap(g => g.memberItemIds), ...directItemIds]);
  return { commandId: randomUUID(), type: 'canvas.move-selection', expected: {
    groups: Object.fromEntries(groups.map(g => [g.id, g.versionId])),
    containment: Object.fromEntries([...ids].map(id => [id, s.containment!.find(c => c.id === id)?.versionId ?? null])),
    poses: Object.fromEntries(items(f).filter(v => ids.has(v.item.id)).map(v => [v.item.id, v.item.versionId])),
  }, payload: { groupIds, directItemIds, dx, dy } };
}

it('两个Group加松散对象一次平移五类去重闭包，保归属内容并一步历史同revision重开重放', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape(), image = f.image(), stroke = f.stroke();
  const g1 = f.group([card.item.id, text.item.id], 'g1'), g2 = f.group([shape.item.id, image.item.id], 'g2');
  expect(f.state().groups!.map(g => g.memberItemIds)).toEqual([[card.item.id, text.item.id], [shape.item.id, image.item.id]]);
  expect(f.state().containment!.find(c => c.id === stroke.item.id)).toBeUndefined();
  const before = f.state(), oldItems = items(f), history = f.history();
  const command = capture(f, [g1.id, g2.id, g1.id], [stroke.item.id, card.item.id, stroke.item.id]);
  const receipt = f.execute(command), moved = f.state(), movedItems = items(f);
  expect(moved.project.revision).toBe(before.project.revision + 1);
  for (const value of items(f)) {
    const old = oldItems.find(v => v.id === value.id)!;
    expect(value).toEqual({ ...old, item: { ...old.item, versionId: expect.any(String), pose: { ...old.item.pose, x: old.item.pose.x + 40, y: old.item.pose.y - 10 } } });
    expect(value.item.versionId).not.toBe(old.item.versionId);
  }
  expect(moved.containment).toEqual(before.containment);
  expect(moved.groups!.map(g => [g.id, g.versionId, g.memberItemIds])).toEqual(before.groups!.map(g => [g.id, g.versionId, g.memberItemIds]));
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  expect(f.history().undo.at(-1)).toMatchObject({ id: command.commandId, label: 'canvas.move-selection' });
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(delta.changes).toHaveLength(1);
  expect(delta.changes[0]!.domains).toEqual(oldItems.map(v => ({ domain: 'pose', id: v.item.id })));
  const map = f.mapping.read({ type: 'map', projectId: 'p', view: 'group-index' }, f.human);
  expect(map.revision).toBe(moved.project.revision);
  expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'containment', snapshot: map.snapshot }, f.human).items).toEqual(before.containment);
  f.reopen(); expect(f.state()).toEqual(moved); expect(f.execute(command)).toEqual(receipt);
  f.travel('history.undo');
  for (const value of items(f)) expect(value.item.pose).toEqual(oldItems.find(v => v.id === value.id)!.item.pose);
  expect(f.state().containment).toEqual(before.containment);
  f.travel('history.redo');
  for (const value of items(f)) expect(value.item.pose).toEqual(movedItems.find(v => v.id === value.id)!.item.pose);
});

it('直选组员不带兄弟，精确校验组内记录、移出parent:null记录与从未归属null三种事实，零位移不增历史', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape(), stroke = f.stroke();
  f.group([card.item.id, text.item.id, shape.item.id]);
  f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.membership(shape.item.id)!.containment }, payload: { id: 'g', itemId: shape.item.id } });
  const before = f.state(), history = f.history(), selected = [text.item.id, shape.item.id, stroke.item.id];
  expect(before.groups![0]!.memberItemIds).toEqual([card.item.id, text.item.id]);
  expect(before.containment!.find(c => c.id === text.item.id)!.parent).toEqual({ kind: 'group', id: before.groups![0]!.itemId });
  expect(before.containment!.find(c => c.id === shape.item.id)!.parent).toBeNull();
  expect(before.containment!.find(c => c.id === stroke.item.id)).toBeUndefined();
  const command = capture(f, [], selected, 0, 0);
  expect(command.expected.groups).toEqual({});
  expect(command.expected.containment).toEqual({ [text.item.id]: before.containment!.find(c => c.id === text.item.id)!.versionId,
    [shape.item.id]: before.containment!.find(c => c.id === shape.item.id)!.versionId, [stroke.item.id]: null });
  f.execute(command); expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes).toEqual([]);
  f.execute({ ...command, commandId: randomUUID(), payload: { ...command.payload, dx: 10, dy: 20 } });
  expect(f.state().cards[0]).toEqual(before.cards[0]);
  expect(f.state().texts![0]!.item.pose).toEqual({ ...text.item.pose, x: 110, y: 40 });
  expect(f.state().shapes![0]!.item.pose).toEqual({ ...shape.item.pose, x: 310, y: 40 });
  expect(f.state().strokes![0]!.item.pose).toEqual({ ...stroke.item.pose, x: 430, y: 40 });
  expect(f.state().containment).toEqual(before.containment);
  const fresh = capture(f, [], [shape.item.id]); fresh.expected.containment[shape.item.id] = null;
  const moved = f.state();
  expect(() => f.execute(fresh)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
  expect(f.state()).toEqual(moved);
});

it.each(['group', 'containment', 'pose'] as const)('捕获后的%s版本同行更新使批移409且无半写，原commandId可按新事实重试', domain => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape(), stroke = f.stroke();
  f.group([card.item.id, text.item.id]);
  const command = capture(f, ['g'], [shape.item.id]);
  if (domain === 'group') f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.membership(text.item.id)!.containment }, payload: { id: 'g', itemId: text.item.id } });
  else if (domain === 'containment') f.group([shape.item.id, stroke.item.id], 'peer');
  else f.execute({ type: 'shape.move', expected: shape.item.versionId, payload: { id: shape.id, x: 400, y: 100 } });
  const peer = f.state(), history = f.history();
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
  expect(f.state()).toEqual(peer); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: peer.project.revision }, f.human).changes).toEqual([]);
  f.execute({ ...capture(f, ['g'], [shape.item.id]), commandId: command.commandId });
  expect(f.state().project.revision).toBe(peer.project.revision + 1);
});

it.each(['groups', 'containment', 'poses'] as const)('缺失或多报%s闭包返回400且无写入', domain => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape(), stroke = f.stroke();
  f.group([card.item.id, text.item.id]); f.group([shape.item.id, stroke.item.id], 'other');
  const before = f.state(), history = f.history(), command = capture(f, ['g'], []);
  const expected = structuredClone(command.expected);
  delete expected[domain][Object.keys(expected[domain])[0]!];
  expect(() => f.execute({ ...command, expected })).toThrowError(expect.objectContaining({ code: 'EXPECTED_DOMAINS', status: 400 }));
  const extra = structuredClone(command.expected);
  if (domain === 'groups') extra.groups.other = before.groups!.find(g => g.id === 'other')!.versionId;
  else if (domain === 'containment') extra.containment[shape.item.id] = before.containment!.find(c => c.id === shape.item.id)!.versionId;
  else extra.poses[shape.item.id] = shape.item.versionId;
  expect(() => f.execute({ ...command, expected: extra })).toThrowError(expect.objectContaining({ code: 'EXPECTED_DOMAINS', status: 400 }));
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
});

it('空选择在schema边界拒绝，未知itemId不会写入其它选择', () => {
  const f = groupFixture(), card = f.card(), before = f.state(), history = f.history();
  expect(() => f.execute(capture(f, [], []))).toThrow();
  const command = capture(f, [], [card.item.id, 'missing']);
  command.expected.poses.missing = 'missing-version';
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }));
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
});

it.each(['canvas.move-selection', 'group.move', 'canvas.move'] as const)('%s回执仅返回本次五类实际Pose版本，零移动省略且重开重放保持原receipt', type => {
  const f = groupFixture(), members = [f.card(), f.text(), f.shape(), f.image(), f.stroke()];
  f.group(members.map(value => value.item.id)); const excluded = f.shape('unmoved');
  function command(dx: number, dy: number) {
    const selected = items(f).filter(value => value.id !== excluded.id);
    return type === 'canvas.move-selection' ? capture(f, ['g'], [], dx, dy)
      : type === 'group.move' ? { commandId: randomUUID(), type, expected: { ...f.structure(), poses: Object.fromEntries(selected.map(value => [value.item.id, value.item.versionId])) }, payload: { id: 'g', dx, dy } }
        : { commandId: randomUUID(), type, expected: Object.fromEntries(selected.map(value => [value.item.id, value.item.versionId])), payload: {
          targets: selected.map(value => ({ kind: value.id === 'card' ? 'card' : value.id === 'text' ? 'text' : value.id === 'shape' ? 'shape' : value.id === 'image' ? 'image' : 'stroke',
            id: value.id, itemId: value.item.id, x: value.item.pose.x + dx, y: value.item.pose.y + dy })) } };
  }
  const request = command(40, 20), before = f.state(), receipt = f.execute(request);
  const moved = items(f).filter(value => value.id !== excluded.id);
  expect(receipt.itemPoseVersions).toEqual(Object.fromEntries(moved.map(value => [value.item.id, value.item.versionId])));
  expect(Object.keys(receipt.itemPoseVersions!)).toHaveLength(5);
  expect(receipt.itemPoseVersions).not.toHaveProperty(excluded.item.id);
  expect(f.state().shapes!.find(value => value.id === excluded.id)).toEqual(excluded);
  for (const value of moved) expect(receipt.itemPoseVersions![value.item.id]).not.toBe(members.find(old => old.id === value.id)!.item.versionId);
  expect(receipt.changedIds).toEqual(moved.map(value => value.item.id));
  f.reopen(); expect(f.execute(request)).toEqual(receipt);
  const saved = f.state(), history = f.history(), noOp = f.execute(command(0, 0));
  expect(noOp.itemPoseVersions).toBeUndefined(); expect(noOp.changedIds).toEqual([]);
  expect(f.state()).toEqual(saved); expect(f.history()).toEqual(history);
  expect(saved.project.revision).toBe(before.project.revision + 1);
});

it('旧pose.batch保留cardPoseVersions合同且不冒充新canvas移动回执', () => {
  const f = groupFixture(), first = f.card('first'), second = f.card('second');
  const receipt = f.execute({ type: 'pose.batch', expected: { [first.id]: first.item.versionId, [second.id]: second.item.versionId },
    payload: { poses: [first, second].map(value => ({ ...value.item.pose, id: value.id, x: value.item.pose.x + 20, y: value.item.pose.y + 10 })) } });
  expect(receipt.itemPoseVersions).toBeUndefined();
  expect(receipt.cardPoseVersions).toEqual(Object.fromEntries(f.state().cards.map(value => [value.item.id, value.item.versionId])));
});
