import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';
import { TITLE_COLORS } from '../src/mapping/presentation-values.js';
import type { Block } from '../src/mapping/contracts.js';

afterEach(closeGroupFixtures);
type Fixture = ReturnType<typeof groupFixture>;
type Kind = 'card' | 'text' | 'shape' | 'image' | 'stroke';

function all(f: Fixture) {
  const s = f.state();
  return [...s.cards, ...s.texts!, ...s.shapes!, ...s.images!, ...s.strokes!];
}
function item(f: Fixture, id: string) {
  return all(f).find(value => value.id === id)!;
}
function ordered(f: Fixture) {
  return [...all(f)].sort((a, b) => (a.item.createdOrder ?? 0) - (b.item.createdOrder ?? 0)).map(value => value.id);
}
function duplicate(f: Fixture, objects: { kind: Kind; id: string; copyId: string }[], connectors: { id: string; copyId: string }[] = [], anchors: string[] = []) {
  const s = f.state();
  const of = (kind: Kind) => objects.filter(value => value.kind === kind);
  const cardVersion = (id: string) => {
    const value = s.cards.find(card => card.id === id)!;
    return { thought: value.versionId, body: value.body.versionId, pose: value.item.versionId, appearance: value.appearance?.versionId ?? null, cardTags: value.cardTags?.versionId ?? null };
  };
  const pair = (id: string) => ({ content: item(f, id).versionId, pose: item(f, id).item.versionId });
  return f.execute({ type: 'canvas.duplicate', expected: {
    cards: Object.fromEntries(of('card').map(value => [value.id, cardVersion(value.id)])),
    texts: Object.fromEntries(of('text').map(value => [value.id, pair(value.id)])),
    shapes: Object.fromEntries(of('shape').map(value => [value.id, pair(value.id)])),
    images: Object.fromEntries(of('image').map(value => [value.id, pair(value.id)])),
    strokes: Object.fromEntries(of('stroke').map(value => [value.id, pair(value.id)])),
    connectors: Object.fromEntries(connectors.map(value => [value.id, s.connectors!.find(line => line.id === value.id)!.versionId])),
    anchors: Object.fromEntries(anchors.map(itemId => [itemId, all(f).find(value => value.item.id === itemId)!.item.versionId])),
  }, payload: { objects, connectors } });
}

it('复制冻结正文、未知块、媒体引用和标签顺序，原件后改不影响副本', () => {
  const f = groupFixture();
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'macro', name: '宏观' } });
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'cycle', name: '周期' } });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'a', title: '市场观察', text: '需求增长', x: 10, y: 20 } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: 'a', tagIds: ['macro', 'cycle'] } });
  f.execute({ type: 'card.appearance', expected: null, payload: { id: 'a', titleColor: TITLE_COLORS.杏色, showPreview: false } });
  const base64 = createCanvas(2, 3).toBuffer('image/png').toString('base64');
  f.execute({ type: 'asset.save', expected: null, payload: { id: 'asset', name: '图.png', mime: 'image/png', base64 } });
  const blocks: Block[] = [
    { id: 'p', type: 'text', text: '需求增长' },
    { id: 'pic', type: 'image', assetId: 'asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 },
    { id: 'parent', type: 'listItem', listType: 'bullet', text: '父项' },
    { id: 'child', type: 'listItem', listType: 'bullet', text: '子项', parentId: 'parent' },
  ];
  f.execute({ type: 'body.edit', expected: f.state().cards[0]!.body.versionId, payload: { id: 'a', blocks } });
  const source = f.state().cards[0]!, beforeOrder = source.item.versionId, history = f.history().undo.length;
  duplicate(f, [{ kind: 'card', id: 'a', copyId: 'copy' }]);
  const copy = f.state().cards.find(value => value.id === 'copy')!;
  expect(copy.title).toBe('市场观察');
  expect(copy.body.id).not.toBe(source.body.id);
  expect(copy.body.blocks.map(block => block.type)).toEqual(blocks.map(block => block.type));
  expect(copy.body.blocks.map(block => block.id)).not.toEqual(expect.arrayContaining(['p', 'pic', 'parent', 'child']));
  expect(copy.body.blocks.find(block => block.type === 'image')).toMatchObject({ assetId: 'asset' });
  expect(copy.body.blocks.find(block => block.text === '子项')!.parentId).toBe(copy.body.blocks.find(block => block.text === '父项')!.id);
  expect(copy.cardTags!.tagIds).toEqual(['macro', 'cycle']);
  expect(copy.appearance).toMatchObject({ titleColor: TITLE_COLORS.杏色, showPreview: false });
  expect(copy.item.pose).toEqual({ x: 34, y: 44, width: 280, height: 160 });
  expect(item(f, 'a').item.versionId).toBe(beforeOrder);
  expect(f.history().undo).toHaveLength(history + 1);
  const edited = f.state().cards.find(value => value.id === 'a')!;
  f.execute({ type: 'body.edit', expected: edited.body.versionId, payload: { id: 'a', blocks: edited.body.blocks.map(block => block.id === 'p' ? { ...block, text: '需求下降' } : block) } });
  f.execute({ type: 'card.tags', expected: f.state().cards.find(value => value.id === 'a')!.cardTags!.versionId, payload: { id: 'a', tagIds: ['cycle'] } });
  const pasted = f.state().cards.find(value => value.id === 'copy')!;
  expect(pasted.body.blocks.find(block => block.type === 'text')!.text).toBe('需求增长');
  expect(pasted.cardTags!.tagIds).toEqual(['macro', 'cycle']);
  expect(f.state().cards.find(value => value.id === 'a')!.cardTags!.tagIds).toEqual(['cycle']);
});

it('多对象复制保持相对位置和前后顺序，只选中语义由新身份表达，一次撤销整批', () => {
  const f = groupFixture();
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'back', content: { shapeType: 'ellipse', shortText: '后' }, pose: { x: 0, y: 0, width: 40, height: 30 } } });
  f.execute({ type: 'text.create', expected: null, payload: { id: 'front', content: { runs: [{ text: '前' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 80 }, pose: { x: 100, y: 40, width: 80, height: 30 } } });
  const history = f.history().undo.length;
  duplicate(f, [{ kind: 'shape', id: 'back', copyId: 'back-copy' }, { kind: 'text', id: 'front', copyId: 'front-copy' }]);
  expect(item(f, 'back-copy').item.pose).toEqual({ x: 24, y: 24, width: 40, height: 30 });
  expect(item(f, 'front-copy').item.pose).toEqual({ x: 124, y: 64, width: 80, height: 30 });
  expect(ordered(f)).toEqual(['back', 'front', 'back-copy', 'front-copy']);
  expect(f.history().undo).toHaveLength(history + 1);
  f.execute({ type: 'text.move', expected: item(f, 'front-copy').item.versionId, payload: { id: 'front-copy', x: 400, y: 10 } });
  duplicate(f, [{ kind: 'text', id: 'front-copy', copyId: 'again' }]);
  expect(item(f, 'again').item.pose).toEqual({ x: 424, y: 34, width: 80, height: 30 });
  f.travel('history.undo');
  expect(f.state().texts!.map(value => value.id)).not.toContain('again');
  f.travel('history.undo');
  expect(ordered(f)).toEqual(['back', 'front', 'back-copy', 'front-copy']);
  f.travel('history.undo');
  expect(ordered(f)).toEqual(['back', 'front']);
  f.travel('history.redo');
  expect(ordered(f)).toEqual(['back', 'front', 'back-copy', 'front-copy']);
  f.reopen();
  expect(ordered(f)).toEqual(['back', 'front', 'back-copy', 'front-copy']);
});

it('两端都在范围内时重建内部线；单端和单线变成复制偏移后的自由端', () => {
  const f = groupFixture();
  const box = { x: 10, y: 20, width: 100, height: 80 };
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'jia', content: { shapeType: 'rectangle', shortText: '甲' }, pose: box } });
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'yi', content: { shapeType: 'rectangle', shortText: '乙' }, pose: { x: 200, y: 20, width: 100, height: 80 } } });
  const jia = item(f, 'jia'), yi = item(f, 'yi');
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'inside', start: { kind: 'bound', itemId: jia.item.id, side: 'right' }, end: { kind: 'bound', itemId: yi.item.id, side: 'left' } } });
  f.execute({ type: 'connector.label', expected: f.state().connectors![0]!.versionId, payload: { id: 'inside', label: { text: '影响', position: 0.5, fontSize: 14, color: '#112233', bold: true } } });
  f.execute({ type: 'connector.style', expected: f.state().connectors![0]!.versionId, payload: { id: 'inside', style: { dash: 'dashed' } } });
  const stale = f.state();
  expect(() => duplicate(f, [{ kind: 'shape', id: 'jia', copyId: 'jia2' }, { kind: 'shape', id: 'yi', copyId: 'yi2' }])).toThrowError(expect.objectContaining({ code: 'EXPECTED_DOMAINS' }));
  expect(f.state().connectors).toEqual(stale.connectors);
  expect(f.state().project.revision).toBe(stale.project.revision);
  duplicate(f, [{ kind: 'shape', id: 'jia', copyId: 'jia2' }, { kind: 'shape', id: 'yi', copyId: 'yi2' }], [{ id: 'inside', copyId: 'inside2' }]);
  const line = f.state().connectors!.find(value => value.id === 'inside2')!;
  expect(line.start).toEqual({ kind: 'bound', itemId: item(f, 'jia2').item.id, side: 'right' });
  expect(line.end).toEqual({ kind: 'bound', itemId: item(f, 'yi2').item.id, side: 'left' });
  expect(line.label).toMatchObject({ text: '影响' });
  expect(line.style).toMatchObject({ dash: 'dashed' });
  expect(JSON.stringify(line)).not.toContain(jia.item.id);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'one', start: { kind: 'bound', itemId: jia.item.id, side: 'right' }, end: { kind: 'bound', itemId: yi.item.id, side: 'left' } } });
  duplicate(f, [{ kind: 'shape', id: 'jia', copyId: 'jia3' }], [{ id: 'one', copyId: 'one2' }], [yi.item.id]);
  const single = f.state().connectors!.find(value => value.id === 'one2')!;
  expect(single.start).toEqual({ kind: 'bound', itemId: item(f, 'jia3').item.id, side: 'right' });
  expect(single.end).toEqual({ kind: 'free', point: { x: 224, y: 84 } });
  expect(JSON.stringify(single)).not.toContain(yi.item.id);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'lone', start: { kind: 'bound', itemId: jia.item.id, side: 'left' }, end: { kind: 'bound', itemId: yi.item.id, side: 'top' } } });
  duplicate(f, [], [{ id: 'lone', copyId: 'lone2' }], [jia.item.id, yi.item.id]);
  const free = f.state().connectors!.find(value => value.id === 'lone2')!;
  expect(free.start).toEqual({ kind: 'free', point: { x: 34, y: 84 } });
  expect(free.end).toEqual({ kind: 'free', point: { x: 274, y: 44 } });
  expect(JSON.stringify(free)).not.toContain(jia.item.id);
  expect(f.state().connectors!.find(value => value.id === 'lone')!.start).toEqual({ kind: 'bound', itemId: jia.item.id, side: 'left' });
});

it('只复制一个组员时副本在组外，原组成员和顺序不变', () => {
  const f = groupFixture();
  const text = f.text('note');
  const shape = f.shape('mark');
  const before = f.state();
  f.group([text.item.id, shape.item.id], 'bundle');
  const membership = f.state().containment;
  duplicate(f, [{ kind: 'text', id: 'note', copyId: 'note-copy' }]);
  const copy = f.state().texts!.find(value => value.id === 'note-copy')!;
  expect(copy.item.pose).toEqual({ x: text.item.pose.x + 24, y: text.item.pose.y + 24, width: text.item.pose.width, height: text.item.pose.height });
  expect(f.state().containment!.find(value => value.id === copy.item.id)).toBeUndefined();
  expect(f.state().groups![0]!.memberItemIds).toEqual([text.item.id, shape.item.id]);
  expect(f.state().containment!.filter(value => value.id !== copy.item.id).map(value => value.id).sort())
    .toEqual(membership!.map(value => value.id).sort());
  expect(item(f, 'note').item.createdOrder).toBe(before.texts![0]!.item.createdOrder);
  expect(item(f, 'mark').item.createdOrder).toBe(before.shapes![0]!.item.createdOrder);
});

it('粘贴使用冻结快照而不重读原件，失败不写历史，重复命令不复活', () => {
  const f = groupFixture();
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'macro', name: '宏观' } });
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'a', title: '市场观察', text: '需求增长', x: 0, y: 0 } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: 'a', tagIds: ['macro'] } });
  const source = f.state().cards[0]!;
  f.execute({ type: 'body.edit', expected: source.body.versionId, payload: { id: 'a', text: '需求下降' } });
  const frozen = {
    kind: 'card' as const, copyId: 'frozen', stack: 1, title: '市场观察',
    blocks: [{ id: 'old', type: 'text', text: '需求增长' }, { id: 'vendor', type: 'vendorWidget', keep: true }],
    tagIds: ['macro'], appearance: { titleColor: TITLE_COLORS.杏色, showPreview: false },
    pose: { x: 0, y: 0, width: 280, height: 160 },
  };
  const command = { commandId: 'paste-1', projectId: 'p', type: 'canvas.paste', expected: null, payload: { translation: { x: 50, y: 70 }, objects: [frozen], connectors: [] } };
  const receipt = f.mapping.execute(command, f.human);
  const copy = f.state().cards.find(value => value.id === 'frozen')!;
  expect(copy.item.pose).toEqual({ x: 50, y: 70, width: 280, height: 160 });
  expect(copy.body.blocks.find(block => block.type === 'text')!.text).toBe('需求增长');
  expect(copy.body.blocks.find(block => block.type === 'vendorWidget')).toMatchObject({ keep: true });
  expect(copy.body.blocks.every(block => block.id !== 'old' && block.id !== 'vendor')).toBe(true);
  expect(copy.cardTags!.tagIds).toEqual(['macro']);
  expect(f.state().cards.find(value => value.id === 'a')!.body.blocks[0]!.text).toBe('需求下降');
  duplicate(f, [{ kind: 'card', id: 'frozen', copyId: 'frozen-again' }]);
  const again = f.state().cards.find(value => value.id === 'frozen-again')!;
  expect(again.body.blocks.find(block => block.type === 'vendorWidget')).toMatchObject({ keep: true });
  expect(again.body.blocks.find(block => block.type === 'vendorWidget')!.id).not.toBe(copy.body.blocks.find(block => block.type === 'vendorWidget')!.id);
  const saved = f.state();
  f.reopen();
  expect(f.state().cards.map(value => value.id).sort()).toEqual(saved.cards.map(value => value.id).sort());
  f.travel('history.undo');
  f.travel('history.undo');
  expect(f.state().cards.map(value => value.id)).toEqual(['a']);
  expect(f.mapping.execute(command, f.human)).toEqual(receipt);
  expect(f.state().cards.map(value => value.id)).toEqual(['a']);
  const history = f.history().undo.length, revision = f.state().project.revision;
  expect(() => f.execute({ type: 'canvas.paste', expected: null, payload: { translation: { x: 0, y: 0 }, objects: [{ ...frozen, copyId: 'missing-tag', tagIds: ['absent'] }], connectors: [] } }))
    .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  expect(f.state().project.revision).toBe(revision);
  expect(f.history().undo).toHaveLength(history);
  expect(f.state().cards.map(value => value.id)).toEqual(['a']);
});
