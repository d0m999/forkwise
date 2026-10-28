import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { cardExpected, closeGroupFixtures, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);
type Fixture = ReturnType<typeof groupFixture>;
function capture(f: Fixture, groupIds: string[], directItemIds: string[], scale = 2) {
  const state = f.state(), groups = state.groups!.filter(g => groupIds.includes(g.id));
  const ids = new Set([...groups.flatMap(g => g.memberItemIds), ...directItemIds]);
  const items: Record<string, unknown> = {};
  const cards: Record<string, { forWidth: number; necessaryHeight: number }> = {};
  const texts: Record<string, { width: number; height: number }> = {};
  for (const v of state.cards.filter(v => ids.has(v.item.id))) {
    items[v.item.id] = { kind: 'card', ...cardExpected(v) };
    cards[v.item.id] = { forWidth: v.item.pose.width * scale, necessaryHeight: 40 };
  }
  for (const v of state.texts!.filter(v => ids.has(v.item.id))) {
    items[v.item.id] = { kind: 'text', text: v.versionId, pose: v.item.versionId };
    texts[v.item.id] = { width: v.item.pose.width * scale, height: v.item.pose.height * scale };
  }
  for (const v of state.shapes!.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'shape', pose: v.item.versionId };
  for (const v of state.images!.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'image', image: v.versionId, pose: v.item.versionId };
  return { commandId: randomUUID(), type: 'group.scale', expected: {
    groups: Object.fromEntries(groups.map(g => [g.id, g.versionId])),
    containment: Object.fromEntries([...ids].map(id => [id, state.containment!.find(c => c.id === id)?.versionId ?? null])), items,
  }, payload: { groupIds, directItemIds, anchorCorner: 'nw', scale, measurements: { cards, texts } } };
}

it('混合Card Text Shape Image完整去重闭包统一2x且一次revision历史保归属', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape(), image = f.image();
  f.group([card.item.id, text.item.id]);
  const before = f.state(), history = f.history();
  const request = capture(f, ['g', 'g'], [shape.item.id, image.item.id, card.item.id]);
  const receipt = f.execute(request), after = f.state();
  expect(after.project.revision).toBe(before.project.revision + 1);
  expect(after.cards[0]!.item.pose).toEqual({ x: 10, y: 20, width: card.item.pose.width * 2, height: card.item.pose.height * 2 });
  expect(after.cards[0]!.item.heightPolicy).toMatchObject({ manualHeight: card.item.pose.height * 2, necessaryHeight: 40 });
  expect(after.texts![0]!.item.pose).toEqual({ x: 190, y: 20, width: 200, height: 54 });
  expect(after.texts![0]!.content).toEqual({ ...text.content, width: 200, fontSize: 36 });
  expect(after.shapes![0]!.item.pose).toEqual({ x: 590, y: 20, width: 200, height: 120 });
  expect(after.images![0]!.item.pose).toEqual({ x: 990, y: 20, width: 120, height: 80, rotation: 90 });
  expect(after.cards[0]!.body).toEqual(card.body);
  expect(after.shapes![0]!.content).toEqual(shape.content);
  expect(after.images![0]!.content).toEqual(image.content);
  expect(after.images![0]!.versionId).toBe(image.versionId);
  expect(after.containment).toEqual(before.containment);
  expect(after.groups![0]!.versionId).toBe(before.groups![0]!.versionId);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  expect(f.history().undo.at(-1)).toMatchObject({ id: request.commandId, label: 'group.scale' });
  const change = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(change.changes).toHaveLength(1);
  f.reopen(); expect(f.state()).toEqual(after); expect(f.execute(request)).toEqual(receipt);
  f.travel('history.undo');
  expect(f.state().cards[0]!.item.pose).toEqual(card.item.pose);
  expect(f.state().texts![0]!.content).toEqual(text.content);
  expect(f.state().shapes![0]!.item.pose).toEqual(shape.item.pose);
  expect(f.state().images![0]!.item.pose).toEqual(image.item.pose);
  f.travel('history.redo');
  expect(f.state().cards[0]!.item.pose).toEqual(after.cards[0]!.item.pose);
  expect(f.state().texts![0]!.item.pose).toEqual(after.texts![0]!.item.pose);
});

it('合法旧小值s1不stamp且放大连续，group专属undo恢复无heightPolicy原几何', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), image = f.image();
  // A pre-policy database is fixture input only; every behavior assertion uses Mapping.
  const db = new Database(join(f.directory, 'workspace.sqlite'));
  const legacy = structuredClone(card);
  delete legacy.item.heightPolicy;
  legacy.item.pose = { x: 0.1, y: 0.2, width: 80, height: 32 };
  db.prepare('UPDATE mapping_cards SET value=? WHERE id=?').run(JSON.stringify(legacy), card.id); db.close();
  f.execute({ type: 'text.transform', expected: { text: text.versionId, pose: text.item.versionId },
    payload: { id: text.id, content: { ...text.content, fontSize: 0.5, width: 0.8 }, pose: { x: 100.1, y: 20.2, width: 0.8, height: 0.75 } } });
  f.execute({ type: 'image.transform', expected: { image: image.versionId, pose: image.item.versionId },
    payload: { id: image.id, pose: { x: 500.1, y: 20.2, width: 0.5, height: 0.7 } } });
  f.group([card.item.id, text.item.id, image.item.id]);
  const before = f.state(), history = f.history(), noop = capture(f, ['g'], [], 1);
  noop.payload.anchorCorner = 'se'; noop.payload.measurements.cards[card.item.id]!.necessaryHeight = 16;
  f.execute(noop); expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  const grow = capture(f, ['g'], [], 2); grow.payload.measurements.cards[card.item.id]!.necessaryHeight = 16;
  f.execute(grow); expect(f.state().cards[0]!.item.pose.width).toBe(160);
  expect(f.state().texts![0]!.content.fontSize).toBe(1);
  expect(f.state().images![0]!.item.pose.width).toBe(1);
  f.travel('history.undo'); f.reopen();
  expect(f.state().cards[0]!.item.pose).toEqual(legacy.item.pose);
  expect(f.state().cards[0]!.item.heightPolicy).toBeUndefined();
  expect(f.state().texts![0]!.content).toEqual(before.texts![0]!.content);
});

it('多Group加loose及member直选只缩放完整去重目标，不扩大到直选成员的兄弟', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), c = f.shape('c'), d = f.shape('d');
  const direct = f.shape('direct'), sibling = f.shape('sibling'), loose = f.shape('loose');
  f.group([a.item.id, b.item.id], 'one'); f.group([c.item.id, d.item.id], 'two');
  f.group([direct.item.id, sibling.item.id], 'unselected');
  const before = f.state(), request = capture(f, ['one', 'two', 'one'], [direct.item.id, loose.item.id, a.item.id, loose.item.id]);
  f.execute(request); const after = f.state();
  expect(after.project.revision).toBe(before.project.revision + 1); expect(after.containment).toEqual(before.containment);
  for (const value of after.shapes!) {
    const old = before.shapes!.find(v => v.id === value.id)!;
    if (value.id === sibling.id) expect(value).toEqual(old);
    else expect(value.item.pose).toEqual({ x: 300, y: 20, width: 200, height: 120 });
  }
  expect(after.groups!.map(g => [g.id, g.versionId, g.memberItemIds])).toEqual(before.groups!.map(g => [g.id, g.versionId, g.memberItemIds]));
});

it('group scale撤销仅恢复对应宽度policy，保当前正文外观标签版本，redo重开一致', () => {
  const f = groupFixture(), card = f.card(), shape = f.shape();
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'tag', name: '现标签' } });
  f.group([card.item.id, shape.item.id]);
  f.execute(capture(f, ['g'], [])); const scaled = f.state().cards[0]!;
  f.execute({ type: 'body.edit', expected: scaled.body.versionId, payload: { id: card.id, text: '之后修改' } });
  f.execute({ type: 'card.appearance', expected: null, payload: { id: card.id, titleColor: '#f7e9bd', showPreview: false } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: card.id, tagIds: ['tag'] } });
  f.travel('history.undo'); f.travel('history.undo'); f.travel('history.undo');
  const current = f.state().cards[0]!;
  expect(current.body.versionId).not.toBe(card.body.versionId);
  expect(current.appearance).toBeDefined(); expect(current.cardTags).toBeDefined();
  f.travel('history.undo'); const undone = f.state().cards[0]!;
  expect(undone.item.pose).toEqual(card.item.pose); expect(undone.item.heightPolicy).toEqual(card.item.heightPolicy);
  expect(undone.body).toEqual(current.body); expect(undone.appearance).toEqual(current.appearance); expect(undone.cardTags).toEqual(current.cardTags);
  f.travel('history.redo'); f.reopen(); const redone = f.state().cards[0]!;
  expect(redone.item.pose).toEqual(scaled.item.pose); expect(redone.item.heightPolicy).toEqual(scaled.item.heightPolicy);
  expect(redone.body).toEqual(current.body); expect(redone.appearance).toEqual(current.appearance); expect(redone.cardTags).toEqual(current.cardTags);
});

it.each(['items', 'cards', 'texts', 'forWidth', 'necessaryHeight', 'stroke'] as const)('%s错误不截断闭包或部分写入', fault => {
  const f = groupFixture(), card = f.card(), text = f.text(), image = f.image(), stroke = f.stroke();
  f.group([card.item.id, text.item.id]);
  const request = capture(f, ['g'], [image.item.id]);
  if (fault === 'items') delete request.expected.items[image.item.id];
  if (fault === 'cards') request.payload.measurements.cards.extra = { forWidth: 280, necessaryHeight: 40 };
  if (fault === 'texts') delete request.payload.measurements.texts[text.item.id];
  if (fault === 'forWidth') request.payload.measurements.cards[card.item.id]!.forWidth = 123;
  if (fault === 'necessaryHeight') request.payload.measurements.cards[card.item.id]!.necessaryHeight = 9999;
  if (fault === 'stroke') { request.payload.directItemIds.push(stroke.item.id); request.expected.containment[stroke.item.id] = null; }
  const before = f.state(), history = f.history();
  expect(() => f.execute(request)).toThrow(); expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
});

it.each(['body', 'pose', 'containment'] as const)('混合缩放捕获后%s冲突原子拒绝且不改history', domain => {
  const f = groupFixture(), card = f.card(), text = f.text(), image = f.image(), shape = f.shape();
  f.group([card.item.id, text.item.id]);
  const request = capture(f, ['g'], [image.item.id]);
  if (domain === 'body') f.execute({ type: 'body.edit', expected: card.body.versionId, payload: { id: card.id, text: '并发正文' } });
  else if (domain === 'pose') f.execute({ type: 'image.transform', expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, pose: { x: 510, y: 20, width: 60, height: 40 } } });
  else f.group([image.item.id, shape.item.id], 'peer');
  const before = f.state(), history = f.history();
  expect(() => f.execute(request)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes).toEqual([]);
});

it('短Card两倍仍低于80且按目标宽度必要高度一次保存，undo恢复原policy', () => {
  const f = groupFixture();
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'short', title: '短', text: '', x: 0, y: 0 } });
  f.execute({ type: 'card.layout', expected: cardExpected(f.state().cards[0]!), payload: { id: 'short', necessaryHeight: 32 } });
  const card = f.state().cards[0]!, shape = f.shape();
  f.group([card.item.id, shape.item.id]);
  const request = capture(f, ['g'], []);
  request.payload.measurements.cards[card.item.id] = { forWidth: card.item.pose.width * 2, necessaryHeight: 36 };
  f.execute(request);
  const after = f.state().cards[0]!;
  expect(after.item.pose.height).toBe(64);
  expect(after.item.heightPolicy).toMatchObject({ manualHeight: 64, necessaryHeight: 36 });
  f.travel('history.undo'); expect(f.state().cards[0]!.item.pose).toEqual(card.item.pose);
  expect(f.state().cards[0]!.item.heightPolicy).toEqual(card.item.heightPolicy);
  f.travel('history.redo'); f.reopen();
  expect(f.state().cards[0]!.item.pose).toEqual(after.item.pose);
  expect(f.state().cards[0]!.item.heightPolicy).toEqual(after.item.heightPolicy);
});

it('纯Image共同中心右90保crop内容且公开Pose版本等于最终值，一次历史可撤销重开', () => {
  const f = groupFixture(), first = f.image('first'), second = f.image('second');
  f.execute({ type: 'image.transform', expected: { image: second.versionId, pose: second.item.versionId },
    payload: { id: second.id, pose: { x: 600, y: 80, width: 20, height: 80 } } });
  f.group([first.item.id, second.item.id]);
  const before = f.state(), history = f.history(), captured = capture(f, ['g'], []);
  const request = { ...captured, type: 'group.rotate90', payload: { groupIds: ['g'], directItemIds: [], direction: 'right' } };
  f.execute(request);
  const after = f.state();
  expect(after.images!.map(v => v.item.pose)).toEqual([
    { x: 590, y: 30, width: 40, height: 60, rotation: 180 },
    { x: 490, y: 130, width: 80, height: 20, rotation: 180 },
  ]);
  for (const value of after.images!) {
    expect(value.content).toEqual(before.images!.find(v => v.id === value.id)!.content);
    expect(value.versionId).toBe(before.images!.find(v => v.id === value.id)!.versionId);
    expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'pose', id: value.item.id, versionId: value.item.versionId }, f.human)).toEqual(value.item);
  }
  expect(after.project.revision).toBe(before.project.revision + 1);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.travel('history.undo'); expect(f.state().images!.map(v => v.item.pose)).toEqual(before.images!.map(v => v.item.pose));
  f.travel('history.redo'); f.reopen(); expect(f.state().images!.map(v => v.item.pose)).toEqual(after.images!.map(v => v.item.pose));
});
