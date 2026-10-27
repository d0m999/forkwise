import { afterEach, expect, it } from 'vitest';
import { groupFixture, closeGroupFixtures } from './group-fixture.js';
afterEach(closeGroupFixtures);

it.each([['pen', '笔迹'], ['highlighter', '荧光笔']])('纯笔迹组合移动历史准确显示%s类型名称', (kind, title) => {
  const f = groupFixture(), a = f.stroke('a', kind), b = f.stroke('b', kind);
  f.group([a.item.id, b.item.id]);
  f.execute({ type: 'group.move', expected: { ...f.structure(), poses: { [a.item.id]: a.item.versionId, [b.item.id]: b.item.versionId } }, payload: { id: 'g', dx: 10, dy: 20 } });
  expect(f.history().undo.at(-1)!.target.title).toBe(title);
});

it('成员拖远保持归属，显式移出保内容几何顺序，一成员组保留且最后成员移出清空组', () => {
  const f = groupFixture(), values = [f.card(), f.text(), f.shape(), f.image(), f.stroke()];
  const group = f.group(values.map(value => value.item.id)), stroke = f.state().strokes![0]!;
  f.execute({ type: 'canvas.move', expected: { [stroke.item.id]: stroke.item.versionId }, payload: { targets: [{ kind: 'stroke', id: stroke.id, itemId: stroke.item.id, x: 1200, y: -500 }] } });
  expect(f.state().groups![0]!.memberItemIds).toContain(stroke.item.id);
  const before = f.state(), history = f.history();
  const detach = (itemId: string) => { const expected = f.structure(); return f.execute({ type: 'group.remove-member', expected: { group: expected.group, containment: expected.containment[itemId] }, payload: { id: 'g', itemId } }); };
  detach(stroke.item.id);
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) expect(f.state()[key]).toEqual(before[key]);
  expect(f.state().containment!.find(value => value.id === stroke.item.id)!.parent).toBeNull();
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.travel('history.undo'); expect(f.state().groups![0]!.memberItemIds).toEqual(group.memberItemIds);
  f.travel('history.redo');
  for (const value of values.slice(0, 3)) detach(value.item.id);
  expect(f.state().groups![0]!.memberItemIds).toEqual([values[3]!.item.id]);
  detach(values[3]!.item.id);
  expect(f.state().groups).toEqual([]); expect(f.state().containment!.every(value => value.parent === null)).toBe(true);
  const empty = f.state(); f.reopen(); expect(f.state()).toEqual(JSON.parse(JSON.stringify(empty)));
  f.travel('history.undo'); expect(f.state().groups![0]).toMatchObject({ id: group.id, itemId: group.itemId, memberItemIds: [values[3]!.item.id] });
  f.travel('history.redo'); expect(f.state().groups).toEqual([]);
});

it('解组只释放归属并保五类完整内容几何顺序，snapshot与历史重开完整恢复', () => {
  const f = groupFixture(), values = [f.card(), f.text(), f.shape(), f.image(), f.stroke()];
  const group = f.group(values.map(value => value.item.id)), before = f.state(), history = f.history();
  const receipt = f.execute({ type: 'group.ungroup', expected: f.structure(), payload: { id: group.id } });
  const after = f.state(); expect(after.groups).toEqual([]);
  expect(new Set(receipt.deletedIds)).toEqual(new Set([group.id, group.itemId]));
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
  expect(after.containment!.every(value => value.parent === null)).toBe(true);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  const map = f.mapping.read({ type: 'map', projectId: 'p', view: 'containment' }, f.human);
  expect(map.items).toEqual(after.containment);
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(delta.changes[0]!.domains).toEqual([{ domain: 'group', id: group.id }, ...values.map(value => ({ domain: 'containment', id: value.item.id }))]);
  f.travel('history.undo'); expect(f.state().groups![0]).toMatchObject({ id: group.id, itemId: group.itemId, memberItemIds: group.memberItemIds });
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
});

it('同editGroup文字改写清空后删除仍一步，undo恢复原文归属空组及incident线', () => {
  const f = groupFixture(), text = f.text(), shape = f.shape();
  const group = f.group([text.item.id, shape.item.id]);
  f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.structure().containment[shape.item.id] }, payload: { id: 'g', itemId: shape.item.id } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', itemId: text.item.id, side: 'right' }, end: { kind: 'bound', itemId: shape.item.id, side: 'left' } } });
  const membership = f.membership(text.item.id), history = f.history();
  for (const value of ['临时内容', '']) {
    const current = f.state().texts![0]!;
    f.execute({ type: 'text.edit', editGroup: 'typing', expected: current.versionId, payload: { id: text.id, content: { ...current.content, runs: [{ text: value }] } } });
  }
  const current = f.state().texts![0]!, line = f.state().connectors![0]!;
  f.execute({ type: 'text.delete', editGroup: 'typing', expected: { text: current.versionId, pose: current.item.versionId, membership, connectors: { [line.id]: line.versionId } }, payload: { id: text.id } });
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  expect(f.state().groups).toEqual([]); expect(f.state().texts).toEqual([]);
  expect(f.state().containment!.find(value => value.id === text.item.id)).toBeUndefined();
  expect(f.state().containment!.find(value => value.id === shape.item.id)!.parent).toBeNull();
  f.travel('history.undo');
  expect(f.state().texts![0]!.content).toEqual(text.content);
  expect(f.state().groups![0]).toMatchObject({ id: group.id, itemId: group.itemId, memberItemIds: [text.item.id] });
  expect(f.state().connectors![0]!.id).toBe(line.id);
  f.travel('history.redo'); expect(f.state().texts).toEqual([]); expect(f.state().groups).toEqual([]);
});

it('旧无组删除DTO兼容，已释放成员删除后活投影不留归属；现有text.copy副本独立在组外', () => {
  const f = groupFixture(), text = f.text(), shape = f.shape(); f.group([text.item.id, shape.item.id]);
  const grouped = f.state();
  f.execute({ type: 'text.copy', expected: { text: text.versionId, pose: text.item.versionId }, payload: { id: text.id, copyId: 'copy' } });
  const copy = f.state().texts!.find(t => t.id === 'copy')!;
  expect(f.state().groups).toEqual(grouped.groups);
  expect(f.state().containment!.find(c => c.id === copy.item.id)).toBeUndefined();
  expect(copy.item.pose).toEqual({ ...text.item.pose, x: text.item.pose.x + 24, y: text.item.pose.y + 24 });
  f.execute({ type: 'text.delete', expected: { text: copy.versionId, pose: copy.item.versionId }, payload: { id: copy.id } });
  f.execute({ type: 'group.ungroup', expected: f.structure(), payload: { id: 'g' } });
  const free = f.state().texts![0]!;
  f.execute({ type: 'text.delete', expected: { text: free.versionId, pose: free.item.versionId }, payload: { id: free.id } });
  expect(f.state().containment!.find(c => c.id === free.item.id)).toBeUndefined();
  f.travel('history.undo'); expect(f.state().containment!.find(c => c.id === free.item.id)!.parent).toBeNull();
  f.reopen(); expect(f.state().groups).toEqual([]);
});
