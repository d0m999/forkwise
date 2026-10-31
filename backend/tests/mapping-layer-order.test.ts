import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);
type Fixture = ReturnType<typeof groupFixture>;
type Pose = { x: number; y: number; width: number; height: number };

function items(f: Fixture) {
  const s = f.state();
  return [...s.cards, ...s.texts!, ...s.shapes!, ...s.images!, ...s.strokes!];
}
function ordered(f: Fixture) {
  return items(f)
    .sort((a, b) => (a.item.createdOrder ?? 0) - (b.item.createdOrder ?? 0))
    .map(value => value.id);
}
function item(f: Fixture, id: string) {
  return items(f).find(value => value.id === id)!;
}
function layer(f: Fixture, objectIds: string[], operation: 'front' | 'back' | 'forward' | 'backward') {
  const s = f.state(), content = [...s.cards, ...s.texts!, ...s.shapes!, ...s.images!];
  const itemIds = objectIds.map(id => item(f, id).item.id);
  const expected = Object.fromEntries(content.map(value => [value.item.id, value.item.versionId]));
  return f.execute({ type: 'canvas.layer', expected, payload: { itemIds, operation } });
}
function createCard(f: Fixture, id: string, pose: Pose) {
  f.execute({ type: 'thought.create', expected: null, payload: { id, title: id, text: '', x: pose.x, y: pose.y } });
  return f.state().cards.find(value => value.id === id)!;
}
function createText(f: Fixture, id: string, pose: Pose) {
  f.execute({ type: 'text.create', expected: null, payload: {
    id,
    content: { runs: [{ text: id }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: pose.width },
    pose,
  } });
  return f.state().texts!.find(value => value.id === id)!;
}
function createShape(f: Fixture, id: string, pose: Pose) {
  f.execute({ type: 'shape.create', expected: null, payload: { id, content: { shapeType: 'rectangle', shortText: id }, pose } });
  return f.state().shapes!.find(value => value.id === id)!;
}
function createImage(f: Fixture, id: string, pose: Pose) {
  const assetId = id + '-asset';
  f.execute({ type: 'asset.save', expected: null, payload: { id: assetId, name: id + '.png', mime: 'image/png',
    base64: createCanvas(2, 3).toBuffer('image/png').toString('base64') } });
  f.execute({ type: 'image.create', expected: null, payload: {
    id, content: { assetId, crop: { x: 0, y: 0, width: 1, height: 1 } },
    pose: { ...pose, rotation: 0 },
  } });
  return f.state().images!.find(value => value.id === id)!;
}
function seed(f: Fixture, kind: 'card' | 'text' | 'shape' | 'image', id: string, pose: Pose) {
  if (kind === 'card') return createCard(f, id, pose);
  if (kind === 'text') return createText(f, id, pose);
  if (kind === 'shape') return createShape(f, id, pose);
  return createImage(f, id, pose);
}

it('四类共用持久顺序，置顶置底跨类型保内部顺序，undo/redo与重开一致', () => {
  const f = groupFixture();
  seed(f, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  seed(f, 'text', 'b', { x: 10, y: 10, width: 100, height: 50 });
  seed(f, 'shape', 'c', { x: 20, y: 20, width: 100, height: 60 });
  seed(f, 'image', 'd', { x: 30, y: 30, width: 60, height: 40 });
  const before = f.state(), history = f.history(), initial = ordered(f);
  expect(initial).toEqual(['a', 'b', 'c', 'd']);

  const front = layer(f, ['a', 'c'], 'front');
  expect(ordered(f)).toEqual(['b', 'd', 'a', 'c']);
  expect(f.state().project.revision).toBe(before.project.revision + 1);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  expect(f.history().undo.at(-1)).toMatchObject({ id: front.commandId, label: 'canvas.layer' });
  expect(f.history().undo.at(-1)?.target.id).toBe('a');
  expect(Object.keys(front.itemPoseVersions ?? {}).sort()).toEqual([...front.changedIds].sort());
  for (const id of ['a', 'b', 'c', 'd']) expect(item(f, id).item.createdOrder).toBe(ordered(f).indexOf(id) + 1);

  const frontState = f.state();
  f.reopen();
  expect(ordered(f)).toEqual(['b', 'd', 'a', 'c']);
  expect(f.state().project.revision).toBe(frontState.project.revision);

  f.travel('history.undo');
  expect(ordered(f)).toEqual(initial);
  expect(f.state().project.revision).toBe(frontState.project.revision + 1);
  f.travel('history.redo');
  expect(ordered(f)).toEqual(['b', 'd', 'a', 'c']);

  const backed = layer(f, ['a', 'c'], 'back');
  expect(backed.changedIds.length).toBeGreaterThan(0);
  expect(ordered(f)).toEqual(['a', 'c', 'b', 'd']);
  expect(f.state().groups).toEqual([]);
});

it('逐层跳过无重叠，多选内部保序并允许必要联动，no-op不写历史', () => {
  const f = groupFixture();
  seed(f, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  seed(f, 'shape', 's', { x: 1000, y: 0, width: 100, height: 100 });
  seed(f, 'image', 'b', { x: 20, y: 20, width: 100, height: 100 });
  seed(f, 'text', 'c', { x: 2000, y: 0, width: 100, height: 50 });
  expect(ordered(f)).toEqual(['a', 's', 'b', 'c']);

  layer(f, ['a'], 'forward');
  expect(ordered(f)).toEqual(['s', 'b', 'a', 'c']);
  f.travel('history.undo');
  expect(ordered(f)).toEqual(['a', 's', 'b', 'c']);
  layer(f, ['a'], 'backward');
  expect(ordered(f)).toEqual(['a', 's', 'b', 'c']);

  // D318: separated overlaps move independently.
  const g = groupFixture();
  seed(g, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  seed(g, 'image', 'x', { x: 20, y: 20, width: 100, height: 100 });
  seed(g, 'card', 'b', { x: 500, y: 0, width: 100, height: 100 });
  seed(g, 'image', 'y', { x: 520, y: 20, width: 100, height: 100 });
  const gHistory = g.history();
  expect(ordered(g)).toEqual(['a', 'x', 'b', 'y']);
  layer(g, ['a', 'b'], 'forward');
  expect(ordered(g)).toEqual(['x', 'a', 'y', 'b']);
  expect(g.history().undo).toHaveLength(gHistory.undo.length + 1);
  g.travel('history.undo');
  expect(ordered(g)).toEqual(['a', 'x', 'b', 'y']);

  // A selected item already above the crossing target keeps its own relation
  // to upper unselected objects: only overlapping targets move.
  const k = groupFixture();
  seed(k, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  seed(k, 'image', 'x', { x: 20, y: 20, width: 100, height: 100 });
  seed(k, 'card', 'b', { x: 500, y: 0, width: 100, height: 100 });
  seed(k, 'image', 'y', { x: 1000, y: 0, width: 100, height: 100 });
  expect(ordered(k)).toEqual(['a', 'x', 'b', 'y']);
  layer(k, ['a', 'b'], 'forward');
  expect(ordered(k)).toEqual(['x', 'a', 'b', 'y']);

  const m = groupFixture();
  seed(m, 'image', 'y', { x: 1000, y: 0, width: 100, height: 100 });
  seed(m, 'card', 'b', { x: 500, y: 0, width: 100, height: 100 });
  seed(m, 'image', 'x', { x: 20, y: 20, width: 100, height: 100 });
  seed(m, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  expect(ordered(m)).toEqual(['y', 'b', 'x', 'a']);
  layer(m, ['a', 'b'], 'backward');
  expect(ordered(m)).toEqual(['y', 'b', 'a', 'x']);

  // D319: lower selected item crossing X also links the selected item above it.
  const h = groupFixture();
  seed(h, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  seed(h, 'card', 'b', { x: 500, y: 0, width: 100, height: 100 });
  seed(h, 'image', 'x', { x: 20, y: 20, width: 100, height: 100 });
  expect(ordered(h)).toEqual(['a', 'b', 'x']);
  layer(h, ['a', 'b'], 'forward');
  expect(ordered(h)).toEqual(['x', 'a', 'b']);

  // No overlap in the requested direction is a no-op receipt, not history.
  const before = h.state(), history = h.history(), receipt = layer(h, ['b'], 'forward');
  expect(receipt.changedIds).toEqual([]);
  expect(h.state()).toEqual(before);
  expect(h.history()).toEqual(history);
  expect(h.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, h.human).changes).toEqual([]);
});

it('历史目标优先使用真正发生变化的已选对象，不回退到未选对象', () => {
  const f = groupFixture();
  seed(f, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  seed(f, 'image', 'b', { x: 500, y: 0, width: 100, height: 100 });
  seed(f, 'card', 'x', { x: 550, y: 0, width: 280, height: 100 });
  expect(ordered(f)).toEqual(['a', 'b', 'x']);
  layer(f, ['a'], 'front');
  layer(f, ['a'], 'back');
  expect(ordered(f)).toEqual(['a', 'b', 'x']);
  layer(f, ['a', 'b'], 'forward');
  expect(ordered(f)).toEqual(['a', 'x', 'b']);
  expect(f.history().undo.at(-1)?.target.id).toBe('b');
});

it('逐层多选后移保留内部顺序并按同一操作前状态联动', () => {
  const f = groupFixture();
  seed(f, 'image', 'x', { x: 0, y: 0, width: 100, height: 100 });
  seed(f, 'card', 'a', { x: 20, y: 20, width: 100, height: 100 });
  seed(f, 'card', 'b', { x: 20, y: 20, width: 100, height: 100 });
  expect(ordered(f)).toEqual(['x', 'a', 'b']);
  layer(f, ['a', 'b'], 'backward');
  expect(ordered(f)).toEqual(['a', 'b', 'x']);
});

it('新建与副本在重排后仍置顶，组归属与解组不重排成员', () => {
  const f = groupFixture();
  seed(f, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  seed(f, 'image', 'b', { x: 20, y: 20, width: 100, height: 100 });
  layer(f, ['b'], 'back');
  expect(ordered(f)).toEqual(['b', 'a']);

  const card = createCard(f, 'new-card', { x: 300, y: 0, width: 100, height: 100 });
  expect(card.item.createdOrder).toBeGreaterThan(item(f, 'a').item.createdOrder!);
  const text = createText(f, 'new-text', { x: 400, y: 0, width: 100, height: 50 });
  expect(text.item.createdOrder).toBeGreaterThan(card.item.createdOrder!);
  const shape = createShape(f, 'new-shape', { x: 500, y: 0, width: 100, height: 100 });
  expect(shape.item.createdOrder).toBeGreaterThan(text.item.createdOrder!);
  const image = createImage(f, 'new-image', { x: 600, y: 0, width: 100, height: 100 });
  expect(image.item.createdOrder).toBeGreaterThan(shape.item.createdOrder!);
  expect(ordered(f).slice(-4)).toEqual(['new-card', 'new-text', 'new-shape', 'new-image']);

  f.execute({ type: 'text.copy', expected: { text: text.versionId, pose: text.item.versionId }, payload: { id: 'new-text', copyId: 'copy-text' } });
  expect(ordered(f).at(-1)).toBe('copy-text');

  const beforeGroup = ordered(f);
  const group = f.group(['a', 'b'].map(id => item(f, id).item.id));
  expect(group.memberItemIds).toEqual([item(f, 'b').item.id, item(f, 'a').item.id]);
  expect(ordered(f)).toEqual(beforeGroup);
  f.execute({ type: 'group.ungroup', expected: f.structure(), payload: { id: 'g' } });
  expect(ordered(f)).toEqual(beforeGroup);
});

it('逐层拒绝Stroke、精确校验选择版本并保持失败无半写', () => {
  const f = groupFixture();
  seed(f, 'card', 'a', { x: 0, y: 0, width: 100, height: 100 });
  const stroke = f.stroke('s');
  // A stroke is not part of the four-kind layer domain: a content item already
  // above all content stays a no-op even when the stroke sorts above it.
  const contentTop = f.state(), contentHistory = f.history(), contentReceipt = layer(f, ['a'], 'front');
  expect(contentReceipt.changedIds).toEqual([]);
  expect(f.state()).toEqual(contentTop);
  expect(f.history()).toEqual(contentHistory);
  const another = createCard(f, 'b', { x: 200, y: 0, width: 100, height: 100 });
  const strokeBefore = f.state().strokes![0]!;
  layer(f, ['a'], 'front');
  expect(f.state().strokes![0]).toEqual(strokeBefore);
  expect(ordered(f).filter(id => id !== 's')).toEqual(['b', 'a']);
  expect(another.item.createdOrder).toBeGreaterThan(item(f, 'a').item.createdOrder!);
  const before = f.state(), history = f.history();
  expect(() => f.execute({ type: 'canvas.layer', expected: { [stroke.item.id]: stroke.item.versionId },
    payload: { itemIds: [stroke.item.id], operation: 'front' } }))
    .toThrowError(expect.objectContaining({ code: 'INVALID_COMMAND', status: 400 }));
  const fullExpected = Object.fromEntries([...before.cards, ...before.texts!, ...before.shapes!, ...before.images!]
    .map(value => [value.item.id, value.item.versionId]));
  const stale = { type: 'canvas.layer', expected: { ...fullExpected, [before.cards[0]!.item.id]: randomUUID() },
    payload: { itemIds: [before.cards[0]!.item.id], operation: 'front' } };
  expect(() => f.execute(stale)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
  const { [before.cards[0]!.item.id]: _missing, ...withoutCard } = fullExpected;
  expect(() => f.execute({ type: 'canvas.layer', expected: withoutCard, payload: { itemIds: [before.cards[0]!.item.id], operation: 'front' } }))
    .toThrowError(expect.objectContaining({ code: 'EXPECTED_DOMAINS', status: 400 }));
  expect(f.state()).toEqual(before);
  expect(f.history()).toEqual(history);
});
