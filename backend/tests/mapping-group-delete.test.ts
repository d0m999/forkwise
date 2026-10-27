import { afterEach, expect, it } from 'vitest';
import { groupFixture, closeGroupFixtures, cardExpected, groupDeleteExpected } from './group-fixture.js';
afterEach(closeGroupFixtures);

it.each(['card', 'text', 'shape', 'image', 'stroke'] as const)('删除组内%s只删除成员及相连线，活动归属清理，历史完整恢复', kind => {
  const f = groupFixture(), values = { card: f.card(), text: f.text(), shape: f.shape(), image: f.image(), stroke: f.stroke() };
  const value = values[kind], group = f.group(Object.values(values).map(v => v.item.id)), outside = f.card('outside');
  if (kind !== 'stroke') f.execute({ type: 'connector.create', expected: null, payload: { id: 'incident', start: { kind: 'bound', itemId: value.item.id, side: 'right' }, end: { kind: 'bound', itemId: outside.item.id, side: 'left' } } });
  const before = f.state(), history = f.history();
  const expected = kind === 'card' ? cardExpected(values.card) : kind === 'text' ? { text: values.text.versionId, pose: value.item.versionId } : kind === 'shape' ? { shape: values.shape.versionId, pose: value.item.versionId } : kind === 'image' ? { image: values.image.versionId, pose: value.item.versionId } : { stroke: values.stroke.versionId, pose: value.item.versionId };
  const receipt = f.execute({ type: kind === 'card' ? 'thought.delete' : kind + '.delete', expected: { ...expected, membership: f.membership(value.item.id), ...(kind === 'stroke' ? {} : { connectors: Object.fromEntries(before.connectors!.map(c => [c.id, c.versionId])) }) }, payload: { id: value.id } });
  const after = f.state();
  expect(after.groups![0]!.memberItemIds).not.toContain(value.item.id);
  expect(after.containment!.find(c => c.id === value.item.id)).toBeUndefined();
  expect(after.connectors).toEqual([]); expect(receipt.deletedIds).toContain(value.item.id);
  expect(receipt.deletedIds).not.toContain(group.id);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  const domains = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes[0]!.domains;
  expect(domains).toContainEqual({ domain: 'group', id: group.id });
  expect(domains).toContainEqual({ domain: 'containment', id: value.item.id });
  expect(domains).toContainEqual({ domain: kind === 'card' ? 'thought' : kind, id: value.id });
  expect(domains).toContainEqual({ domain: 'pose', id: value.item.id });
  f.travel('history.undo'); const restored = f.state();
  expect(restored.groups![0]).toMatchObject({ id: group.id, itemId: group.itemId, memberItemIds: group.memberItemIds });
  expect(restored.containment!.find(c => c.id === value.item.id)!.parent).toEqual({ kind: 'group', id: group.itemId });
  expect(restored.connectors!.map(c => c.id)).toEqual(before.connectors!.map(c => c.id));
  const restoredValue = kind === 'card' ? restored.cards.find(v => v.id === value.id)! : kind === 'text' ? restored.texts![0]! : kind === 'shape' ? restored.shapes![0]! : kind === 'image' ? restored.images![0]! : restored.strokes![0]!;
  expect(restoredValue.item).toMatchObject({ id: value.item.id, pose: value.item.pose });
  if ('body' in value) expect(restored.cards.find(v => v.id === value.id)!.body.blocks).toEqual(value.body.blocks);
  else expect('content' in restoredValue && restoredValue.content).toEqual(value.content);
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(JSON.parse(JSON.stringify(redone)));
  expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'containment' }, f.human).items.some(c => c.id === value.item.id)).toBe(false);
});

it('删除五类整组同事务移除全部成员归属和incident线，保留原件与自由线，一步历史完整恢复', () => {
  const f = groupFixture(), values = [f.card(), f.text(), f.shape(), f.image(), f.stroke()] as const, outside = f.card('outside');
  f.execute({ type: 'card.appearance', expected: null, payload: { id: values[0].id, titleColor: '#f7e9bd', showPreview: false } });
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'tag1', name: '第一标签' } });
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'tag2', name: '第二标签' } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: values[0].id, tagIds: ['tag2', 'tag1'] } });
  const group = f.group(values.map(v => v.item.id));
  for (const payload of [
    { id: 'internal', start: { kind: 'bound', itemId: values[0]!.item.id, side: 'right' }, end: { kind: 'bound', itemId: values[2]!.item.id, side: 'left' } },
    { id: 'external', start: { kind: 'bound', itemId: values[3]!.item.id, side: 'right' }, end: { kind: 'bound', itemId: outside.item.id, side: 'left' } },
    { id: 'free', start: { kind: 'free', point: { x: 5, y: 5 } }, end: { kind: 'free', point: { x: 50, y: 60 } } },
  ]) f.execute({ type: 'connector.create', expected: null, payload });
  const before = f.state(), history = f.history(), assetId = before.images![0]!.content.assetId;
  const beforeCard = before.cards.find(value => value.id === values[0].id)!;
  expect(beforeCard.appearance).toMatchObject({ titleColor: '#f7e9bd', showPreview: false });
  expect(beforeCard.cardTags!.tagIds).toEqual(['tag2', 'tag1']);
  const asset = f.mapping.read({ type: 'asset', projectId: 'p', id: assetId }, f.human);
  const expectedDeleted = new Set([group.id, group.itemId, ...values.flatMap(v => [v.id, v.item.id]), beforeCard.body.id,
    beforeCard.appearance!.id, beforeCard.cardTags!.id, 'internal', 'external']);
  const receipt = f.execute({ type: 'group.delete', expected: groupDeleteExpected(f), payload: { id: 'g' } }), after = f.state();
  expect(new Set(receipt.deletedIds)).toEqual(expectedDeleted);
  expect(after.groups).toEqual([]); expect(after.containment).toEqual([]);
  expect(after.cards).toEqual([outside]);
  expect(after.tags).toEqual(before.tags);
  for (const key of ['texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual([]);
  expect(after.connectors).toEqual(before.connectors!.filter(v => v.id === 'free'));
  expect(f.mapping.read({ type: 'asset', projectId: 'p', id: assetId }, f.human)).toEqual(asset);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(delta.changes).toHaveLength(1); expect(new Set(delta.changes[0]!.deletedIds)).toEqual(expectedDeleted);
  for (const [index, domain] of ['thought', 'text', 'shape', 'image', 'stroke'].entries()) {
    expect(delta.changes[0]!.domains).toContainEqual({ domain, id: values[index]!.id });
    expect(delta.changes[0]!.domains).toContainEqual({ domain: 'containment', id: values[index]!.item.id });
  }
  f.travel('history.undo'); const restored = f.state();
  const restoredCard = restored.cards.find(value => value.id === beforeCard.id)!;
  expect(restored.groups![0]).toMatchObject({ id: group.id, itemId: group.itemId, memberItemIds: group.memberItemIds });
  expect(restoredCard.body.blocks).toEqual(beforeCard.body.blocks);
  expect(restoredCard.title).toBe(beforeCard.title);
  expect(restoredCard.item).toMatchObject({ id: beforeCard.item.id, pose: beforeCard.item.pose });
  expect(restoredCard.appearance).toEqual({ ...beforeCard.appearance, versionId: expect.any(String) });
  expect(restoredCard.cardTags).toEqual({ ...beforeCard.cardTags, versionId: expect.any(String) });
  expect(restoredCard.appearance!.versionId).not.toBe(beforeCard.appearance!.versionId);
  expect(restoredCard.cardTags!.versionId).not.toBe(beforeCard.cardTags!.versionId);
  for (const key of ['texts', 'shapes', 'images', 'strokes'] as const) {
    expect(restored[key]![0]!.content).toEqual(before[key]![0]!.content);
    expect(restored[key]![0]!.item).toMatchObject({ id: before[key]![0]!.item.id, pose: before[key]![0]!.item.pose });
  }
  expect(restored.connectors!.map(v => v.id)).toEqual(before.connectors!.map(v => v.id));
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(JSON.parse(JSON.stringify(redone)));
  expect(f.state().tags).toEqual(before.tags);
  expect(f.mapping.read({ type: 'asset', projectId: 'p', id: assetId }, f.human)).toEqual(asset);
  expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'containment' }, f.human).items).toEqual([]);
  f.travel('history.undo'); const final = f.state(); f.reopen(); expect(f.state()).toEqual(final);
  expect(f.state().cards.find(value => value.id === beforeCard.id)!.appearance).toMatchObject({ titleColor: '#f7e9bd', showPreview: false });
  expect(f.state().cards.find(value => value.id === beforeCard.id)!.cardTags!.tagIds).toEqual(['tag2', 'tag1']);
});

it.each(['membership', 'pose', 'content', 'connector'] as const)('整组删除捕获后%s被同行修改返回409，无半写或新历史且失败ID不占用', domain => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape();
  f.group([card.item.id, text.item.id, shape.item.id]);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: shape.item.id, side: 'left' } } });
  const command = { commandId: 'captured-delete', type: 'group.delete', expected: groupDeleteExpected(f), payload: { id: 'g' } };
  if (domain === 'membership') f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.structure().containment[shape.item.id] }, payload: { id: 'g', itemId: shape.item.id } });
  else if (domain === 'pose') f.execute({ type: 'shape.move', expected: shape.item.versionId, payload: { id: shape.id, x: 800, y: 900 } });
  else if (domain === 'content') f.execute({ type: 'text.edit', expected: text.versionId, payload: { id: text.id, content: { ...text.content, runs: [{ text: '同行修改' }] } } });
  else f.execute({ type: 'connector.style', expected: f.state().connectors![0]!.versionId, payload: { id: 'line', style: { width: 7 } } });
  const peer = f.state(), history = f.history();
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
  expect(f.state()).toEqual(peer); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: peer.project.revision }, f.human).changes).toEqual([]);
  f.execute({ ...command, expected: groupDeleteExpected(f) }); expect(f.state().groups).toEqual([]);
});

it('整组删除中的pending媒体恢复先失败化再保留不可变版本，旧ticket拒绝且完成结果更新批量历史快照', () => {
  const f = groupFixture(), card = f.card(), shape = f.shape(), image = f.image('source');
  const asset = f.mapping.read({ type: 'asset', projectId: 'p', id: image.content.assetId }, f.human);
  f.execute({ type: 'body.edit', expected: card.body.versionId, payload: { id: card.id, blocks: [{ id: 'pending', type: 'imageTask', ticket: 'old-ticket', status: 'queued', name: asset.name, mime: asset.mime, base64: asset.base64, byteLength: Buffer.from(asset.base64, 'base64').length, width: 2, height: 3 }] } });
  f.group([card.item.id, shape.item.id]);
  const before = f.state().cards[0]!;
  f.execute({ type: 'group.delete', expected: groupDeleteExpected(f), payload: { id: 'g' } });
  expect(f.state().cards).toEqual([]);
  f.travel('history.undo'); const restored = f.state().cards[0]!;
  expect(restored.body.blocks[0]).toMatchObject({ type: 'imageTask', ticket: 'old-ticket', status: 'failed' });
  expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'body', id: restored.body.id, versionId: restored.body.versionId }, f.human)).toEqual(restored.body);
  expect(() => f.execute({ type: 'media.finish', expected: 'old-ticket', payload: { id: card.id, blockId: 'pending', assetId: asset.id } })).toThrowError(expect.objectContaining({ code: 'MEDIA_TASK_STALE' }));
  expect(f.state().cards[0]).toEqual(restored);
  f.execute({ type: 'media.retry', expected: 'old-ticket', payload: { id: card.id, blockId: 'pending', ticket: 'new-ticket' } });
  f.execute({ type: 'media.finish', expected: 'new-ticket', payload: { id: card.id, blockId: 'pending', assetId: asset.id } });
  expect(f.state().cards[0]!.body.blocks[0]).toMatchObject({ type: 'image', assetId: asset.id });
  expect(f.history().redo).toHaveLength(1);
  f.travel('history.redo'); expect(f.state().cards).toEqual([]);
  f.travel('history.undo'); const completed = f.state().cards[0]!;
  expect(completed.body.blocks[0]).toMatchObject({ type: 'image', assetId: asset.id });
  expect(completed.body.blocks[0]).not.toHaveProperty('ticket');
  expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'body', id: before.body.id, versionId: before.body.versionId }, f.human).blocks[0]).toMatchObject({ status: 'queued', ticket: 'old-ticket' });
  const end = f.state(); f.reopen(); expect(f.state()).toEqual(end);
});

it('历史摘要从单卡和整组真实删除派生deletedCardIds，非删除省略且重开undo-redo保持动作身份', () => {
  const f = groupFixture(), a = f.card('a'), b = f.card('b'), shape = f.shape();
  f.group([a.item.id, b.item.id, shape.item.id]);
  expect(f.history().undo.at(-1)).not.toHaveProperty('deletedCardIds');
  f.execute({ type: 'group.delete', expected: groupDeleteExpected(f), payload: { id: 'g' } });
  const action = f.history().undo.at(-1)!;
  expect(action.deletedCardIds).toEqual(['a', 'b']);
  f.reopen(); expect(f.history().undo.at(-1)).toEqual(action);
  f.travel('history.undo'); expect(f.history().redo.at(-1)).toEqual(action);
  f.travel('history.redo'); expect(f.history().undo.at(-1)).toEqual(action);
  const single = f.card('single');
  f.execute({ type: 'thought.delete', expected: cardExpected(single), payload: { id: single.id } });
  expect(f.history().undo.at(-1)!.deletedCardIds).toEqual(['single']);
  const c = f.card('c'), d = f.card('d'); f.group([c.item.id, d.item.id], 'other');
  f.execute({ type: 'group.ungroup', expected: f.structure('other'), payload: { id: 'other' } });
  expect(f.history().undo.at(-1)).not.toHaveProperty('deletedCardIds');
  f.execute({ type: 'pose.move', expected: c.item.versionId, payload: { id: c.id, x: 70, y: 80 } });
  expect(f.history().undo.at(-1)).not.toHaveProperty('deletedCardIds');
});
