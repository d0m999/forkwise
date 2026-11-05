import { afterEach, expect, it } from 'vitest';
import { cardExpected, closeGroupFixtures, groupDeleteExpected, groupFixture } from './group-fixture.js';
import { createFrameCommand, moveFrameCommand } from './nested-frame-fixture.js';
import { captureSpatial, frameDrawMembers, spatialItems } from '../src/mapping/frame-spatial.js';

afterEach(closeGroupFixtures);
it.each(['duplicate', 'paste'] as const)('Frame内%s的card/shape撤销删除归属边，公共投影与同库重开始终可读', method => {
  const f = groupFixture(), card = f.card(), shape = f.shape();
  const rect = { x: -100, y: -100, width: 900, height: 700 };
  f.execute(createFrameCommand(f.state(), frameDrawMembers(f.state(), rect), rect));
  if (method === 'duplicate') f.execute({ type: 'canvas.duplicate', expected: {
    cards: { [card.id]: cardExpected(card) }, texts: {}, shapes: { [shape.id]: { content: shape.versionId, pose: shape.item.versionId } }, images: {}, strokes: {}, connectors: {}, anchors: {},
  }, payload: { objects: [{ kind: 'card', id: card.id, copyId: 'card-copy' }, { kind: 'shape', id: shape.id, copyId: 'shape-copy' }], connectors: [] } });
  else f.execute({ type: 'canvas.paste', expected: null, payload: { translation: { x: 24, y: 24 }, connectors: [], objects: [
    { kind: 'card', copyId: 'card-copy', stack: 1, title: card.title, blocks: card.body.blocks, tagIds: null, appearance: null, pose: card.item.pose },
    { kind: 'shape', copyId: 'shape-copy', stack: 2, content: shape.content, pose: shape.item.pose },
  ] } });
  const copied = f.state(), copies = [copied.cards.find(c => c.id === 'card-copy')!, copied.shapes!.find(c => c.id === 'shape-copy')!];
  for (const c of copies) expect(copied.containment!.find(v => v.id === c.item.id)?.parent).toEqual({ kind: 'frame', id: copied.frames![0]!.id });
  for (const direction of ['history.undo', 'history.redo', 'history.undo', 'history.redo'] as const) {
    f.travel(direction); const state = f.state();
    expect(state.containment!.filter(v => copies.some(c => c.item.id === v.id))).toHaveLength(direction === 'history.undo' ? 0 : 2);
    for (const view of ['frame-index', 'group-index', 'containment'] as const)
      expect(() => f.mapping.read({ type: 'map', projectId: 'p', view }, f.human)).not.toThrow();
    f.reopen(); expect(f.state()).toEqual(state);
    if (direction === 'history.redo') for (const c of copies) expect(state.containment!.find(v => v.id === c.item.id)?.parent).toEqual({ kind: 'frame', id: state.frames![0]!.id });
  }
});

it.each(['canvas.move', 'canvas.move-card', 'pose.move', 'group.move', 'canvas.move-selection', 'pose.batch', 'frame.move'] as const)('%s结构历史同时恢复每张卡pose/parent且保留正文与非几何版本', type => {
  const f = groupFixture(), a = f.card('a'), b = f.card('b'), shape = f.shape();
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'tag', name: '版本保护' } });
  for (const id of [a.id, b.id]) {
    f.execute({ type: 'card.tags', expected: null, payload: { id, tagIds: ['tag'] } });
    f.execute({ type: 'card.appearance', expected: null, payload: { id, titleColor: '#f7e9bd', showPreview: false } });
  }
  const rect = { x: -100, y: -100, width: 700, height: 600 };
  f.execute(createFrameCommand(f.state(), frameDrawMembers(f.state(), rect), rect));
  f.execute(createFrameCommand(f.state(), [], { x: 1000, y: -100, width: 700, height: 600 }));
  const group = type === 'group.move' || type === 'canvas.move-selection' ? f.group([a.item.id, b.item.id, shape.item.id]) : null;
  const before = f.state(), single = before.cards[0]!, items = spatialItems(before), placement = { expected: captureSpatial(before), point: { x: 1200, y: 100 } };
  if (type === 'pose.move') f.execute({ type, placement, expected: single.item.versionId, payload: { id: single.id, x: single.item.pose.x + 1100, y: single.item.pose.y } });
  else if (type === 'canvas.move' || type === 'canvas.move-card') f.execute({ type: 'canvas.move', placement, expected: Object.fromEntries((type === 'canvas.move-card' ? before.cards : items).map(v => [v.item.id, v.item.versionId])),
    payload: { targets: [...before.cards.map(c => ({ kind: 'card', id: c.id, itemId: c.item.id, x: c.item.pose.x + 1100, y: c.item.pose.y })), ...(type === 'canvas.move-card' ? [] : before.shapes!).map(c => ({ kind: 'shape', id: c.id, itemId: c.item.id, x: c.item.pose.x + 1100, y: c.item.pose.y }))] } });
  else if (type === 'pose.batch') f.execute({ type, expected: Object.fromEntries(before.cards.map(c => [c.id, c.item.versionId])),
    payload: { poses: before.cards.map(c => ({ id: c.id, ...c.item.pose, x: c.item.pose.x + 1100 })) } });
  else if (type === 'frame.move') f.execute(moveFrameCommand(before, before.frames![0]!, 1100, 0));
  else f.execute(type === 'group.move' ? { type, placement, expected: { group: group!.versionId, containment: f.structure().containment, poses: Object.fromEntries(items.map(v => [v.item.id, v.item.versionId])) }, payload: { id: group!.id, dx: 1100, dy: 0 } }
    : { type, placement, expected: { groups: { [group!.id]: group!.versionId }, containment: f.structure().containment, poses: Object.fromEntries(items.map(v => [v.item.id, v.item.versionId])) }, payload: { groupIds: [group!.id], directItemIds: [], dx: 1100, dy: 0 } });
  const moved = f.state(), forward = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(forward.changes).toHaveLength(1);
  expect(forward.changes[0]!.domains.filter(d => ['thought', 'body', 'appearance', 'cardTags'].includes(d.domain))).toEqual([]);
  for (const card of moved.cards) {
    expect({ ...card, item: undefined }).toEqual({ ...before.cards.find(c => c.id === card.id)!, item: undefined });
    expect(forward.changes[0]!.changedIds).not.toContain(card.id); expect(forward.changes[0]!.changedIds).not.toContain(card.body.id);
    expect(forward.changes[0]!.changedIds).not.toContain(card.appearance!.id); expect(forward.changes[0]!.changedIds).not.toContain(card.cardTags!.id);
  }
  for (const direction of ['history.undo', 'history.redo'] as const) {
    const prior = f.state(), target = direction === 'history.undo' ? before : moved;
    const receipt = f.travel(direction); const state = f.state();
    for (const card of state.cards) {
      const expected = target.cards.find(c => c.id === card.id)!, original = before.cards.find(c => c.id === card.id)!;
      expect(card.item.pose).toEqual(expected.item.pose);
      expect({ ...card, item: undefined }).toEqual({ ...original, item: undefined });
      expect(receipt.changedIds).not.toContain(card.id); expect(receipt.changedIds).not.toContain(card.body.id);
      expect(receipt.changedIds).not.toContain(card.appearance!.id); expect(receipt.changedIds).not.toContain(card.cardTags!.id);
      if (type !== 'pose.move' || card.id === a.id) expect(card.item.versionId).not.toBe(prior.cards.find(c => c.id === card.id)!.item.versionId);
      expect(state.containment!.find(v => v.id === card.item.id)?.parent).toEqual(target.containment!.find(v => v.id === card.item.id)?.parent);
    }
    const delta = f.mapping.observe({ projectId: 'p', afterRevision: prior.project.revision }, f.human);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]!.domains.filter(d => ['thought', 'body', 'appearance', 'cardTags'].includes(d.domain))).toEqual([]);
    for (const card of state.cards.filter(c => type !== 'pose.move' || c.id === a.id)) expect(delta.changes[0]!.domains.filter(d => d.domain === 'pose' && d.id === card.item.id)).toHaveLength(1);
    f.reopen(); expect(f.state()).toEqual(state);
  }
});

it('Frame内组删除与undo重建继续保留完整卡片身份closure，几何历史修复不削弱生命周期', () => {
  const f = groupFixture(); f.execute(createFrameCommand(f.state(), [], { x: -100, y: -100, width: 1000, height: 700 }));
  const card = f.card(), shape = f.shape();
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'tag', name: '生命周期' } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: card.id, tagIds: ['tag'] } });
  f.execute({ type: 'card.appearance', expected: null, payload: { id: card.id, titleColor: '#f7e9bd', showPreview: false } });
  const group = f.group([card.item.id, shape.item.id]), original = f.state().cards[0]!;
  const ids = [original.id, original.body.id, original.item.id, original.appearance!.id, original.cardTags!.id];
  const deletion = f.execute({ type: 'group.delete', expected: groupDeleteExpected(f), payload: { id: group.id } });
  for (const id of ids) { expect(deletion.changedIds).toContain(id); expect(deletion.deletedIds).toContain(id); }
  const restored = f.travel('history.undo');
  for (const id of ids) expect(restored.changedIds).toContain(id);
  expect(restored.deletedIds).toEqual([]); const state = f.state();
  expect(state.cards[0]!.body.blocks).toEqual(original.body.blocks); expect(state.groups![0]!.memberItemIds).toEqual(group.memberItemIds);
  f.reopen(); expect(f.state()).toEqual(state);
  const redone = f.travel('history.redo'); for (const id of ids) expect(redone.deletedIds).toContain(id);
  expect(f.state().cards).toEqual([]); const empty = f.state(); f.reopen(); expect(f.state()).toEqual(empty);
});
