import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeGroupFixtures, groupFixture, cardExpected, groupDeleteExpected } from './group-fixture.js';
import type { ProjectState } from '../src/mapping/contracts.js';
import { captureSpatial } from '../src/mapping/frame-spatial.js';

afterEach(closeGroupFixtures);
type Ref = { kind: 'card' | 'text' | 'shape' | 'image' | 'stroke' | 'group' | 'frame'; id: string; copyId: string };
function duplicateCommand(s: ProjectState, roots: string[], objects: Ref[], lineIds: string[] = []) {
  const lists = { card: s.cards, text: s.texts!, shape: s.shapes!, image: s.images!, stroke: s.strokes! };
  const ordinary = objects.filter(v => v.kind !== 'group' && v.kind !== 'frame');
  const itemIds = objects.map(v => v.kind === 'frame' ? v.id : v.kind === 'group' ? s.groups!.find(g => g.id === v.id)!.itemId : lists[v.kind].find(x => x.id === v.id)!.item.id);
  const pairs = (kind: 'text' | 'shape' | 'image' | 'stroke') => Object.fromEntries(ordinary.filter(v => v.kind === kind).map(v => { const x = lists[kind].find(x => x.id === v.id)!; return [v.id, { content: x.versionId, pose: x.item.versionId }]; }));
  return { commandId: randomUUID(), projectId: s.project.id, type: 'canvas.duplicate', placement: { expected: captureSpatial(s) }, expected: {
    cards: Object.fromEntries(ordinary.filter(v => v.kind === 'card').map(v => [v.id, cardExpected(s.cards.find(x => x.id === v.id)!)])),
    texts: pairs('text'), shapes: pairs('shape'), images: pairs('image'), strokes: pairs('stroke'),
    groups: Object.fromEntries(objects.filter(v => v.kind === 'group').map(v => [v.id, s.groups!.find(x => x.id === v.id)!.versionId])),
    frames: Object.fromEntries(objects.filter(v => v.kind === 'frame').map(v => [v.id, s.frames!.find(x => x.id === v.id)!.versionId])),
    containment: Object.fromEntries(itemIds.map(id => [id, s.containment!.find(v => v.id === id)?.versionId ?? null])),
    connectors: Object.fromEntries(lineIds.map(id => [id, s.connectors!.find(v => v.id === id)!.versionId])), anchors: {},
  }, payload: { version: 2, roots, objects, connectors: lineIds.map(id => ({ id, copyId: id + '-copy' })) } };
}

it('整组复制混合成员、独立正文及两卡共享标签，一次撤销重做并重开保持新树', () => {
  const f = groupFixture();
  f.execute({ type: 'canvas.paste', expected: null, payload: { translation: { x: 0, y: 0 }, objects: [{ kind: 'card', copyId: 'a', stack: 1, title: 'a',
    blocks: [{ id: 'original-text', type: 'text', text: '原始正文' }, { id: 'vendor', type: 'vendorWidget', schemaVersion: 7, contentVersion: 'v4', payload: { keep: true } }],
    tagIds: null, appearance: null, pose: { x: 10, y: 20, width: 280, height: 160 }, heightPolicy: { manualHeight: 160, necessaryHeight: 64, previewFloor: 120 } }], connectors: [] } });
  f.card('b'); const text = f.text('note');
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'macro', name: '宏观' } });
  for (const id of ['a', 'b']) f.execute({ type: 'card.tags', expected: null, payload: { id, tagIds: ['macro'] } });
  const source = f.state(), a = source.cards[0]!, b = source.cards[1]!;
  const group = f.group([b.item.id, text.item.id, a.item.id], 'bundle');
  const before = f.state(), history = f.history().undo.length;
  const command = duplicateCommand(before, [group.itemId], [
    { kind: 'group', id: group.id, copyId: 'bundle-copy' }, { kind: 'card', id: 'a', copyId: 'a-copy' },
    { kind: 'card', id: 'b', copyId: 'b-copy' }, { kind: 'text', id: 'note', copyId: 'note-copy' },
  ]);
  const receipt = f.mapping.execute(command, f.human);
  const next = f.state(), copyGroup = next.groups!.find(g => g.id === 'bundle-copy')!;
  const copies = next.cards.filter(v => v.id.endsWith('-copy'));
  expect(copyGroup.itemId).not.toBe(group.itemId);
  expect(copyGroup.createdOrder).toBeGreaterThan(group.createdOrder);
  expect(copyGroup.memberItemIds).toEqual([next.cards.find(v => v.id === 'a-copy')!.item.id, next.cards.find(v => v.id === 'b-copy')!.item.id, next.texts!.find(v => v.id === 'note-copy')!.item.id]);
  expect(copies.map(v => v.cardTags!.tagIds)).toEqual([['macro'], ['macro']]);
  expect(next.cards.find(v => v.id === 'a-copy')!.body.blocks[1]).toMatchObject({ type: 'vendorWidget', schemaVersion: 7, contentVersion: 'v4', payload: { keep: true } });
  expect(next.cards.find(v => v.id === 'a-copy')!.item.heightPolicy).toEqual(a.item.heightPolicy);
  const observed = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(observed.changes).toHaveLength(1);
  expect(observed.changes[0]!.groupChanges!.map(v => v.after!.id)).toEqual(['bundle-copy']);
  for (const view of ['group-index', 'frame-index', 'containment'] as const) expect(f.mapping.read({ type: 'map', projectId: 'p', view, snapshot: observed.snapshot }, f.human).revision).toBe(next.project.revision);
  expect(copies.every(v => v.body.id !== a.body.id && v.body.id !== b.body.id && v.body.blocks[0]!.id !== a.body.blocks[0]!.id)).toBe(true);
  expect(next.cards.find(v => v.id === 'a-copy')!.item.pose.x).toBe(34);
  expect(next.cards.filter(v => !v.id.endsWith('-copy'))).toEqual(before.cards);
  expect(f.history().undo).toHaveLength(history + 1);
  expect(receipt.changedIds).toEqual(expect.arrayContaining(['bundle-copy', copyGroup.itemId]));
  f.reopen(); expect(f.state()).toEqual(next);
  f.travel('history.undo'); expect(f.state().groups!.map(g => g.id)).toEqual(['bundle']); expect(f.state().cards).toEqual(before.cards);
  expect(f.mapping.execute(command, f.human)).toEqual(receipt); expect(f.state().groups).toHaveLength(1);
  f.travel('history.redo'); expect(f.state().groups!.find(g => g.id === 'bundle-copy')!.memberItemIds).toEqual(copyGroup.memberItemIds);
  const editable = f.state().cards.find(v => v.id === 'a-copy')!;
  f.execute({ type: 'body.edit', expected: editable.body.versionId, payload: { id: editable.id, blocks: editable.body.blocks.map(v => v.type === 'text' ? { ...v, text: '副本独立修改' } : v) } });
  expect(f.state().cards.find(v => v.id === 'a')!.body.blocks[0]!.text).toBe('原始正文');
  f.execute({ type: 'group.delete', expected: groupDeleteExpected(f, 'bundle-copy'), payload: { id: 'bundle-copy' } });
  expect(f.mapping.execute(command, f.human)).toEqual(receipt); expect(f.state().groups!.map(g => g.id)).toEqual(['bundle']);
});

function frame(f: ReturnType<typeof groupFixture>, id: string, itemIds: string[], pose: { x: number; y: number; width: number; height: number }) {
  const s = f.state(), groups = s.groups!.filter(g => itemIds.includes(g.itemId));
  const ordinaryIds = itemIds.flatMap(id => groups.find(g => g.itemId === id)?.memberItemIds ?? (s.frames!.some(v => v.id === id) ? [] : [id]));
  const ordinary = [...s.cards, ...s.texts!, ...s.shapes!, ...s.images!, ...s.strokes!];
  f.execute({ type: 'frame.create', placement: { expected: captureSpatial(s, { rect: pose }) },
    expected: { frame: null, groups: Object.fromEntries(groups.map(g => [g.id, g.versionId])),
      containment: Object.fromEntries(itemIds.map(id => [id, s.containment!.find(v => v.id === id)?.versionId ?? null])),
      poses: Object.fromEntries(ordinaryIds.map(id => [id, ordinary.find(v => v.item.id === id)!.item.versionId])) }, payload: { id, itemIds, pose } });
  return f.state().frames!.find(v => v.id === id)!;
}
function nested(f: ReturnType<typeof groupFixture>) {
  const a = f.card('a'), b = f.text('note'), group = f.group([a.item.id, b.item.id], 'bundle');
  frame(f, 'inner', [group.itemId], { x: -10, y: -10, width: 400, height: 250 });
  frame(f, 'middle', ['inner'], { x: -50, y: -50, width: 700, height: 500 });
  frame(f, 'outer', ['middle'], { x: -100, y: -100, width: 1000, height: 800 });
  frame(f, 'ancestor', ['outer'], { x: -200, y: -200, width: 1400, height: 1000 });
  return { a, b, group, refs: [
    { kind: 'frame', id: 'outer', copyId: 'outer-copy' }, { kind: 'frame', id: 'middle', copyId: 'middle-copy' },
    { kind: 'frame', id: 'inner', copyId: 'inner-copy' }, { kind: 'group', id: 'bundle', copyId: 'bundle-copy' },
    { kind: 'card', id: 'a', copyId: 'a-copy' }, { kind: 'text', id: 'note', copyId: 'note-copy' },
  ] as Ref[] };
}

it('三层树按保存归属复制，越界组员带走、几何重叠者和未选祖先排除、多选后代去重，根可落回源Frame', () => {
  const f = groupFixture(), { a, group, refs } = nested(f);
  const source = f.state(), note = source.texts![0]!;
  // A member can geometrically lie outside all its saved containers.
  f.execute({ type: 'text.move', expected: note.item.versionId, payload: { id: note.id, x: 1700, y: 200 } });
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'overlap', content: { shapeType: 'rectangle', shortText: '几何相交但非成员' }, pose: { x: 2000, y: 2000, width: 50, height: 40 } } });
  const outside = f.state().shapes![0]!;
  f.execute({ type: 'shape.move', placement: { expected: captureSpatial(f.state()), point: { x: 3000, y: 3000 } }, expected: outside.item.versionId,
    payload: { id: outside.id, x: 100, y: 100 } });
  const before = f.state();
  f.mapping.execute(duplicateCommand(before, ['outer', 'inner', group.itemId, a.item.id], refs), f.human);
  const s = f.state(), copiedGroup = s.groups!.find(v => v.id === 'bundle-copy')!;
  const parent = (id: string) => s.containment!.find(v => v.id === id)?.parent;
  expect(s.frames!.map(v => v.id)).toEqual(['inner', 'middle', 'outer', 'ancestor', 'inner-copy', 'middle-copy', 'outer-copy']);
  expect(parent('middle-copy')).toEqual({ kind: 'frame', id: 'outer-copy' });
  expect(parent('inner-copy')).toEqual({ kind: 'frame', id: 'middle-copy' });
  expect(parent(copiedGroup.itemId)).toEqual({ kind: 'frame', id: 'inner-copy' });
  expect(parent(s.cards.find(v => v.id === 'a-copy')!.item.id)).toEqual({ kind: 'group', id: copiedGroup.itemId });
  expect(s.texts!.find(v => v.id === 'note-copy')!.item.pose).toMatchObject({ x: 1724, y: 224 });
  expect(s.shapes!.map(v => v.id)).toEqual(['overlap']);
  expect(s.frames!.some(v => v.id === 'ancestor-copy')).toBe(false);
  expect(parent('outer-copy')).toEqual({ kind: 'frame', id: 'middle' });
  for (const original of before.frames!) {
    const actual = s.frames!.find(v => v.id === original.id)!;
    expect({ ...actual, memberItemIds: original.memberItemIds }).toEqual(original);
    expect(actual.memberItemIds).toEqual(original.id === 'middle' ? [...original.memberItemIds, 'outer-copy'] : original.memberItemIds);
  }
  const saved = f.state(); f.reopen(); expect(f.state()).toEqual(saved);
  f.travel('history.undo'); expect(f.state().frames).toEqual(before.frames); expect(f.state().groups).toEqual(before.groups);
  f.travel('history.redo'); expect(f.state().frames!.map(v => v.id)).toEqual(saved.frames!.map(v => v.id));
});

it('v2冻结paste不依赖原树仍存在，保留空框、框名背景、多根及内部父子，根仅由已有场景决定归属', () => {
  const f = groupFixture();
  frame(f, 'host', [], { x: 400, y: 400, width: 500, height: 500 });
  const objects = [
    { kind: 'frame', copyId: 'root-a', stack: 2, name: '外框原名', background: '#abc', pose: { x: 0, y: 0, width: 300, height: 300 } },
    { kind: 'frame', copyId: 'inner-a', stack: 0, name: '空框', background: null, pose: { x: 20, y: 20, width: 50, height: 50 } },
    { kind: 'frame', copyId: 'root-b', stack: 1, name: '独立根', background: null, pose: { x: 50, y: 50, width: 100, height: 100 } },
  ];
  const command = { commandId: 'frozen-tree', projectId: 'p', type: 'canvas.paste', expected: null,
    payload: { version: 2, roots: ['root-a', 'root-b'], containment: [{ copyId: 'inner-a', parentCopyId: 'root-a' }], translation: { x: 450, y: 450 }, objects, connectors: [] } };
  const revision = f.state().project.revision, receipt = f.mapping.execute(command, f.human), s = f.state();
  expect(receipt.revision).toBe(revision + 1);
  expect(s.frames!.map(v => v.id)).toEqual(['host', 'inner-a', 'root-b', 'root-a']);
  expect(s.containment!.find(v => v.id === 'root-a')!.parent).toEqual({ kind: 'frame', id: 'host' });
  expect(s.containment!.find(v => v.id === 'root-b')!.parent).toEqual({ kind: 'frame', id: 'host' });
  expect(s.containment!.find(v => v.id === 'inner-a')!.parent).toEqual({ kind: 'frame', id: 'root-a' });
  expect(s.frames!.find(v => v.id === 'inner-a')!.memberItemIds).toEqual([]);
  expect(s.frames!.find(v => v.id === 'root-a')).toMatchObject({ name: '外框原名', background: '#abc' });
  f.reopen(); expect(f.state()).toEqual(s);
  f.travel('history.undo'); expect(f.state().frames!.map(v => v.id)).toEqual(['host']);
  f.travel('history.redo'); expect(f.state().frames!.map(v => v.id)).toEqual(s.frames!.map(v => v.id));
  const solo = { ...command, commandId: 'empty-top', payload: { version: 2, roots: ['top'], containment: [], translation: { x: 2000, y: 2000 }, objects: [{ ...objects[1], copyId: 'top' }], connectors: [] } };
  f.mapping.execute(solo, f.human); expect(f.state().containment!.find(v => v.id === 'top')?.parent ?? null).toBeNull();
});

it('归属树新进/移出成员、源版本与新增内部线变化均拒绝整批，不扩泛锁到无关正文', () => {
  const f = groupFixture(), { group, refs } = nested(f);
  const command = duplicateCommand(f.state(), ['outer'], refs);
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'new-member', content: { shapeType: 'ellipse', shortText: '' }, pose: { x: 100, y: 100, width: 30, height: 30 } } });
  const changed = f.state();
  expect(() => f.mapping.execute(command, f.human)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(changed);
  const withShape = [...refs, { kind: 'shape', id: 'new-member', copyId: 'shape-copy' } as Ref];
  const moved = duplicateCommand(f.state(), ['outer'], withShape), shape = f.state().shapes![0]!;
  f.execute({ type: 'shape.move', placement: { expected: captureSpatial(f.state()) }, expected: shape.item.versionId, payload: { id: shape.id, x: 2000, y: 2000 } });
  expect(() => f.mapping.execute(moved, f.human)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  const lineCommand = duplicateCommand(f.state(), ['outer'], refs);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'new-internal', path: 'straight', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'bound', targetKind: 'frame', itemId: 'outer', side: 'left' } } });
  const before = f.state(), count = f.history().undo.length;
  expect(() => f.mapping.execute(lineCommand, f.human)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(before); expect(f.history().undo).toHaveLength(count);
});

it('内部连线保留组与Frame本体端点类型，显式外部端变同平移世界自由点，源线不变', () => {
  const f = groupFixture(), a = f.card('a'), note = f.text('note'), group = f.group([a.item.id, note.item.id], 'bundle');
  frame(f, 'empty', [], { x: 1000, y: 0, width: 200, height: 100 });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'outside', title: '外部', text: '', x: 2000, y: 0 } });
  const outside = f.state().cards.find(v => v.id === 'outside')!;
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'internal', path: 'curve', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'bound', targetKind: 'frame', itemId: 'empty', side: 'left' } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'outgoing', path: 'straight', start: { kind: 'bound', targetKind: 'frame', itemId: 'empty', side: 'right' }, end: { kind: 'bound', itemId: outside.item.id, side: 'left' } } });
  const s = f.state(), command = duplicateCommand(s, [group.itemId, 'empty'], [
    { kind: 'group', id: 'bundle', copyId: 'bundle-copy' }, { kind: 'card', id: 'a', copyId: 'a-copy' },
    { kind: 'text', id: 'note', copyId: 'note-copy' }, { kind: 'frame', id: 'empty', copyId: 'empty-copy' },
  ], ['internal', 'outgoing']);
  Object.assign(command.expected.anchors, { [outside.item.id]: outside.item.versionId });
  f.mapping.execute(command, f.human);
  const after = f.state(), g = after.groups!.find(v => v.id === 'bundle-copy')!;
  expect(after.connectors!.find(v => v.id === 'internal-copy')).toMatchObject({ path: 'curve', start: { kind: 'bound', targetKind: 'group', itemId: g.itemId, side: 'right' }, end: { kind: 'bound', targetKind: 'frame', itemId: 'empty-copy', side: 'left' } });
  expect(after.connectors!.find(v => v.id === 'outgoing-copy')).toMatchObject({ start: { kind: 'bound', targetKind: 'frame', itemId: 'empty-copy' }, end: { kind: 'free', point: { x: 2024, y: 104 } } });
  expect(after.connectors!.filter(v => !v.id.endsWith('-copy'))).toEqual(s.connectors);
});

it('v2未知版本、非闭合/多父/有环树、组含Frame及端点类型不匹配拒绝且不写半套', () => {
  const f = groupFixture(), before = f.state();
  const root = { kind: 'frame', copyId: 'f', stack: 1, name: '根', background: null, pose: { x: 0, y: 0, width: 300, height: 200 } };
  const child = { ...root, copyId: 'child' };
  const base = { version: 2, roots: ['f'], containment: [{ copyId: 'child', parentCopyId: 'f' }], translation: { x: 0, y: 0 }, objects: [root, child], connectors: [] };
  const invalid = [
    { ...base, version: 3 }, { ...base, containment: [] },
    { ...base, containment: [{ copyId: 'child', parentCopyId: 'absent' }] },
    { ...base, containment: [{ copyId: 'child', parentCopyId: 'f' }, { copyId: 'child', parentCopyId: 'f' }] },
    { ...base, roots: [], containment: [{ copyId: 'child', parentCopyId: 'f' }, { copyId: 'f', parentCopyId: 'child' }] },
    { ...base, objects: [{ kind: 'group', copyId: 'f', stack: 1, pose: root.pose }, child] },
    { ...base, connectors: [{ copyId: 'line', path: 'straight', start: { kind: 'bound', copyId: 'f', targetKind: 'group', side: 'top' }, end: { kind: 'free', point: { x: 1, y: 2 } } }] },
  ];
  for (const payload of invalid) {
    expect(() => f.execute({ type: 'canvas.paste', expected: null, payload })).toThrow();
    expect(f.state()).toEqual(before);
  }
});

it('树paste缺任一标签或资源整批失败，逐卡重复标签拒绝；删除或undo后重复commandId不复活', () => {
  const f = groupFixture();
  const root = { kind: 'frame', copyId: 'f', stack: 1, name: '根', background: null, pose: { x: 0, y: 0, width: 300, height: 200 } };
  const card = { kind: 'card', copyId: 'a', stack: 0, title: '冻结', blocks: [{ id: 'p', type: 'text', text: '旧正文' }], tagIds: ['lost'], appearance: null, pose: { x: 20, y: 20, width: 280, height: 160 } };
  const payload = { version: 2, roots: ['f'], containment: [{ copyId: 'a', parentCopyId: 'f' }], translation: { x: 0, y: 0 }, objects: [root, card], connectors: [] };
  const before = f.state(), history = f.history();
  expect(() => f.execute({ type: 'canvas.paste', expected: null, payload })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  const missingImage = { ...card, tagIds: null, blocks: [{ id: 'i', type: 'image', assetId: 'missing' }] };
  expect(() => f.execute({ type: 'canvas.paste', expected: null, payload: { ...payload, objects: [root, missingImage] } })).toThrowError(expect.objectContaining({ code: 'MEDIA_NOT_PERSISTED' }));
  expect(f.state()).toEqual(before);
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'macro', name: '宏观' } });
  expect(() => f.execute({ type: 'canvas.paste', expected: null, payload: { ...payload, objects: [root, { ...card, tagIds: ['macro', 'macro'] }] } })).toThrowError(expect.objectContaining({ code: 'INVALID_TAGS' }));
  const command = { commandId: 'paste-tree-once', projectId: 'p', type: 'canvas.paste', expected: null, payload: { ...payload, objects: [root, { ...card, tagIds: ['macro'] }] } };
  const receipt = f.mapping.execute(command, f.human);
  expect(f.mapping.execute(command, f.human)).toEqual(receipt);
  f.travel('history.undo'); expect(f.state().cards).toHaveLength(0); expect(f.state().frames).toHaveLength(0);
  f.reopen(); expect(f.mapping.execute(command, f.human)).toEqual(receipt); expect(f.state().frames).toHaveLength(0);
});

it.each(['versions', 'history', 'receipt'] as const)('整树复制在%s检查点失败时内容/树/历史/observe全部回滚，原请求可重试', phase => {
  let armed = false;
  const f = groupFixture({ checkpoint: at => { if (armed && at === phase) throw new Error('树写入故障'); } });
  const { refs } = nested(f), before = f.state(), history = f.history();
  const command = duplicateCommand(before, ['outer'], refs);
  armed = true;
  expect(() => f.mapping.execute(command, f.human)).toThrow('树写入故障');
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes).toEqual([]);
  f.reopen(); expect(f.state()).toEqual(before);
  armed = false;
  const receipt = f.mapping.execute(command, f.human);
  expect(receipt.revision).toBe(before.project.revision + 1);
  expect(f.state().frames!.map(v => v.id)).toEqual(['inner', 'middle', 'outer', 'ancestor', 'inner-copy', 'middle-copy', 'outer-copy']);
});

it('组复制保留五类成员内容与媒体引用、笔迹及统一内部层序，资源仍复用', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape(), image = f.image(), stroke = f.stroke();
  const group = f.group([card.item.id, text.item.id, shape.item.id, image.item.id, stroke.item.id]);
  const before = f.state();
  const refs: Ref[] = [{ kind: 'group', id: group.id, copyId: 'g-copy' },
    { kind: 'card', id: card.id, copyId: 'card-copy' }, { kind: 'text', id: text.id, copyId: 'text-copy' },
    { kind: 'shape', id: shape.id, copyId: 'shape-copy' }, { kind: 'image', id: image.id, copyId: 'image-copy' }, { kind: 'stroke', id: stroke.id, copyId: 'stroke-copy' }];
  f.mapping.execute(duplicateCommand(before, [group.itemId], refs), f.human);
  const after = f.state(), contents = [...after.cards, ...after.texts!, ...after.shapes!, ...after.images!, ...after.strokes!];
  expect(contents.filter(v => v.id.endsWith('-copy')).sort((a, b) => a.item.createdOrder! - b.item.createdOrder!).map(v => v.id))
    .toEqual(['card-copy', 'text-copy', 'shape-copy', 'image-copy', 'stroke-copy']);
  expect(after.images!.find(v => v.id === 'image-copy')!.content).toEqual(image.content);
  expect(after.strokes!.find(v => v.id === 'stroke-copy')!.content).toEqual(stroke.content);
  expect(after.shapes!.find(v => v.id === 'shape-copy')!.content).toEqual(shape.content);
  expect(after.texts!.find(v => v.id === 'text-copy')!.content).toEqual(text.content);
  expect(Math.min(...contents.filter(v => v.id.endsWith('-copy')).map(v => v.item.createdOrder!)))
    .toBeGreaterThan(Math.max(...contents.filter(v => !v.id.endsWith('-copy')).map(v => v.item.createdOrder!)));
});

it('v1普通快照不能把连线伪装绑定到不存在的组或分区', () => {
  const f = groupFixture(), before = f.state();
  const card = { kind: 'card', copyId: 'plain', stack: 1, title: '', blocks: [{ id: 'p', type: 'text', text: '' }], tagIds: null, appearance: null, pose: { x: 0, y: 0, width: 280, height: 160 } };
  for (const targetKind of ['group', 'frame']) {
    expect(() => f.execute({ type: 'canvas.paste', expected: null, payload: { translation: { x: 0, y: 0 }, objects: [card],
      connectors: [{ copyId: 'line', path: 'straight', start: { kind: 'bound', copyId: 'plain', targetKind, side: 'left' }, end: { kind: 'free', point: { x: 400, y: 20 } } }] } })).toThrow();
    expect(f.state()).toEqual(before);
  }
});

it('复制校验源正文版本，但无关卡片正文更新不形成全项目内容锁', () => {
  const f = groupFixture(), { refs } = nested(f);
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'unrelated', title: '旁项', text: '旁项原文', x: 3000, y: 3000 } });
  const stale = duplicateCommand(f.state(), ['outer'], refs), source = f.state().cards.find(v => v.id === 'a')!;
  f.execute({ type: 'body.edit', expected: source.body.versionId, payload: { id: 'a', text: '源当前正文' } });
  const afterEdit = f.state();
  expect(() => f.mapping.execute(stale, f.human)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(afterEdit);
  const current = duplicateCommand(afterEdit, ['outer'], refs), unrelated = afterEdit.cards.find(v => v.id === 'unrelated')!;
  f.execute({ type: 'body.edit', expected: unrelated.body.versionId, payload: { id: unrelated.id, text: '旁项稍后更新' } });
  f.mapping.execute(current, f.human);
  expect(f.state().cards.find(v => v.id === 'a-copy')!.body.blocks[0]!.text).toBe('源当前正文');
  expect(f.state().cards.find(v => v.id === unrelated.id)!.body.blocks[0]!.text).toBe('旁项稍后更新');
});
