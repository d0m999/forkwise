import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { groupFixture, closeGroupFixtures, cardExpected } from './group-fixture.js';
import { groupHttp } from './group-protocol-fixture.js';

afterEach(closeGroupFixtures);

function capture(f: ReturnType<typeof groupFixture>, groupIds: string[], directItemIds: string[]) {
  const s = f.state(), ids = new Set(directItemIds), groups = new Set(groupIds);
  for (const id of groupIds) for (const itemId of s.groups!.find(g => g.id === id)!.memberItemIds) ids.add(itemId);
  for (const itemId of ids) {
    const parent = s.containment!.find(c => c.id === itemId)?.parent;
    if (parent) groups.add(s.groups!.find(g => g.itemId === parent.id)!.id);
  }
  const items: Record<string, unknown> = {};
  for (const v of s.cards.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind: 'card', ...cardExpected(v) };
  for (const [kind, values] of [['text', s.texts!], ['shape', s.shapes!], ['image', s.images!], ['stroke', s.strokes!]] as const)
    for (const v of values.filter(v => ids.has(v.item.id))) items[v.item.id] = { kind, [kind]: v.versionId, pose: v.item.versionId };
  return { commandId: randomUUID(), projectId: 'p', type: 'canvas.delete-selection', payload: { groupIds, directItemIds }, expected: {
    groups: Object.fromEntries([...groups].map(id => [id, s.groups!.find(g => g.id === id)!.versionId])),
    containment: Object.fromEntries([...ids].map(id => [id, s.containment!.find(c => c.id === id)?.versionId ?? null])), items,
    connectors: Object.fromEntries(s.connectors!.filter(c => c.start.kind === 'bound' && ids.has(c.start.itemId) || c.end.kind === 'bound' && ids.has(c.end.itemId)).map(c => [c.id, c.versionId])),
  } };
}

it('两个Group加loose和未选父组成员含重复根，五类与incident原子删除且一保零清并完整撤销', () => {
  const f = groupFixture(), card = f.card(), text = f.text(), shape = f.shape(), image = f.image(), stroke = f.stroke();
  f.execute({ type: 'card.appearance', expected: null, payload: { id: card.id, titleColor: '#f7e9bd', showPreview: false } });
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'tag1', name: '第一标签' } });
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'tag2', name: '第二标签' } });
  f.execute({ type: 'card.tags', expected: null, payload: { id: card.id, tagIds: ['tag2', 'tag1'] } });
  const g1 = f.group([card.item.id, text.item.id], 'g1'), g2 = f.group([shape.item.id, stroke.item.id], 'g2');
  const victim = f.card('victim'), sibling = f.shape('sibling'), parent = f.group([victim.item.id, sibling.item.id], 'parent'), outside = f.card('outside');
  for (const payload of [
    { id: 'internal', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: shape.item.id, side: 'left' } },
    { id: 'cross', start: { kind: 'bound', itemId: image.item.id, side: 'right' }, end: { kind: 'bound', itemId: outside.item.id, side: 'left' } },
    { id: 'unrelated', start: { kind: 'bound', itemId: sibling.item.id, side: 'right' }, end: { kind: 'bound', itemId: outside.item.id, side: 'left' } },
    { id: 'free', start: { kind: 'free', point: { x: 2, y: 3 } }, end: { kind: 'free', point: { x: 80, y: 90 } } },
  ]) f.execute({ type: 'connector.create', expected: null, payload });
  const before = f.state(), history = f.history(), values = [card, text, shape, image, stroke, victim];
  const beforeCard = before.cards.find(v => v.id === card.id)!;
  expect(beforeCard.appearance).toMatchObject({ titleColor: '#f7e9bd', showPreview: false });
  expect(beforeCard.cardTags!.tagIds).toEqual(['tag2', 'tag1']);
  const command = capture(f, ['g1', 'g2', 'g1'], [image.item.id, victim.item.id, card.item.id, victim.item.id]);
  expect(Object.keys(command.expected.groups).sort()).toEqual(['g1', 'g2', 'parent']);
  expect(new Set(Object.keys(command.expected.items))).toEqual(new Set(values.map(v => v.item.id)));
  expect(Object.keys(command.expected.connectors).sort()).toEqual(['cross', 'internal']);
  expect(command.expected.containment[image.item.id]).toBeNull();
  expect(before.containment!.find(c => c.id === victim.item.id)!.parent).toEqual({ kind: 'group', id: parent.itemId });
  const receipt = f.execute(command), after = f.state();
  expect(after.project.revision).toBe(before.project.revision + 1); expect(after.groups).toHaveLength(1);
  expect(after.groups![0]).toMatchObject({ id: 'parent', itemId: parent.itemId, memberItemIds: [sibling.item.id] });
  expect(after.containment!.map(c => c.id)).toEqual([sibling.item.id]);
  expect(after.cards).toEqual([outside]); expect(after.shapes).toEqual([sibling]);
  for (const key of ['texts', 'images', 'strokes'] as const) expect(after[key]).toEqual([]);
  expect(after.connectors).toEqual(before.connectors!.filter(c => ['unrelated', 'free'].includes(c.id)));
  const expectedDeleted = new Set([g1.id, g1.itemId, g2.id, g2.itemId, ...values.flatMap(v => [v.id, v.item.id]), card.body.id, victim.body.id,
    beforeCard.appearance!.id, beforeCard.cardTags!.id, 'internal', 'cross']);
  expect(new Set(receipt.deletedIds)).toEqual(expectedDeleted); expect(receipt.deletedIds).not.toContain(parent.id);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  expect(new Set(f.history().undo.at(-1)!.deletedCardIds)).toEqual(new Set([card.id, victim.id]));
  expect([g1.id, g2.id, ...values.map(v => v.id)]).toContain(f.history().undo.at(-1)!.target.id);
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(delta.changes).toHaveLength(1); expect(new Set(delta.changes[0]!.deletedIds)).toEqual(expectedDeleted);
  expect(f.execute(command)).toEqual(receipt); expect(f.state()).toEqual(after); expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.travel('history.undo'); const restored = f.state();
  expect(restored.groups!.map(g => [g.id, g.itemId, g.memberItemIds])).toEqual(before.groups!.map(g => [g.id, g.itemId, g.memberItemIds]));
  expect(restored.connectors!.map(c => [c.id, c.start, c.end])).toEqual(before.connectors!.map(c => [c.id, c.start, c.end]));
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const)
    for (const v of before[key]!) {
      const actual = restored[key]!.find(x => x.id === v.id)!;
      if (!values.some(deleted => deleted.id === v.id)) { expect(actual).toEqual(v); continue; }
      expect(actual.item).toEqual({ ...v.item, versionId: expect.any(String) });
      expect(actual.item.versionId).not.toBe(v.item.versionId); expect(actual.versionId).not.toBe(v.versionId);
      if ('body' in v && 'body' in actual) {
        expect(actual.title).toBe(v.title); expect(actual.body.blocks).toEqual(v.body.blocks);
        expect(actual.body.versionId).not.toBe(v.body.versionId);
      }
      else if ('content' in v && 'content' in actual) expect(actual.content).toEqual(v.content);
    }
  const restoredCard = restored.cards.find(v => v.id === card.id)!;
  expect(restoredCard.appearance).toEqual({ ...beforeCard.appearance, versionId: expect.any(String) });
  expect(restoredCard.cardTags).toEqual({ ...beforeCard.cardTags, versionId: expect.any(String) });
  expect(restoredCard.appearance!.versionId).not.toBe(beforeCard.appearance!.versionId);
  expect(restoredCard.cardTags!.versionId).not.toBe(beforeCard.cardTags!.versionId);
  expect(restored.tags).toEqual(before.tags);
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
  expect(f.state().tags).toEqual(before.tags);
  expect(f.mapping.read({ type: 'asset', projectId: 'p', id: image.content.assetId }, f.human).id).toBe(image.content.assetId);
});

it.each([false, true])('only-loose Card和Text、incident且parent-null记录=%s，一次历史删除并重开撤销恢复', released => {
  const f = groupFixture(), card = f.card(), text = f.text();
  if (released) { f.group([card.item.id, text.item.id]); f.execute({ type: 'group.ungroup', expected: f.structure(), payload: { id: 'g' } }); }
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: text.item.id, side: 'left' } } });
  const before = f.state(), timeline = f.history(), command = capture(f, [], [card.item.id, text.item.id]);
  expect(command.expected.groups).toEqual({}); expect(before.groups).toEqual([]);
  for (const id of [card.item.id, text.item.id]) {
    if (released) { expect(before.containment!.find(c => c.id === id)!.parent).toBeNull(); expect(command.expected.containment[id]).toEqual(expect.any(String)); }
    else expect(command.expected.containment[id]).toBeNull();
  }
  f.execute(command); expect(f.state().cards).toEqual([]); expect(f.state().texts).toEqual([]); expect(f.state().containment).toEqual([]);
  expect(f.history().undo).toHaveLength(timeline.undo.length + 1); expect(f.history().undo.at(-1)!.deletedCardIds).toEqual([card.id]);
  expect([card.id, text.id]).toContain(f.history().undo.at(-1)!.target.id);
  f.reopen(); f.travel('history.undo'); const restored = f.state();
  expect(restored.cards[0]!.body.blocks).toEqual(card.body.blocks); expect(restored.texts![0]!.content).toEqual(text.content);
  expect(restored.connectors![0]!.id).toBe('line');
  expect(restored.containment!.map(c => [c.id, c.parent])).toEqual(before.containment!.map(c => [c.id, c.parent]));
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
});

it('真实HTTP与SQLite接受同一full-selection命令，幂等重放只产生一次revision/history', async () => {
  const f = groupFixture(), card = f.card(), shape = f.shape(); f.group([card.item.id, shape.item.id]);
  const before = f.state(), history = f.history(), command = capture(f, ['g'], []), http = groupHttp(f);
  const token = f.mapping.access.issue('human', ['p']); await http.start();
  try {
    const send = () => fetch(http.origin + '/api/mapping/execute', { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: http.origin,
      'Content-Type': 'application/json', 'Idempotency-Key': command.commandId }, body: JSON.stringify(command) });
    expect((await http.get('/api/mapping/projects/p')).status).toBe(200);
    const response = await send(); expect(response.status).toBe(200); const receipt = await response.json();
    expect(f.state().project.revision).toBe(before.project.revision + 1); expect(f.state().groups).toEqual([]);
    const replay = await send(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt);
    expect(f.history().undo).toHaveLength(history.undo.length + 1);
    const stale = { ...command, commandId: randomUUID() }, stable = f.state();
    const conflict = await fetch(http.origin + '/api/mapping/execute', { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: http.origin,
      'Content-Type': 'application/json', 'Idempotency-Key': stale.commandId }, body: JSON.stringify(stale) });
    expect(conflict.status).toBe(409); expect(f.state()).toEqual(stable); expect(f.history().undo).toHaveLength(history.undo.length + 1);
  } finally { await http.close(); }
});

it('仅直选未选父组的最后Card会清组，target仍是Card，撤销以新版本恢复组与全部内容身份', () => {
  const f = groupFixture(), card = f.card(), spare = f.shape(); f.group([card.item.id, spare.item.id]);
  f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.structure().containment[spare.item.id] }, payload: { id: 'g', itemId: spare.item.id } });
  const before = f.state(), group = before.groups![0]!, command = capture(f, [], [card.item.id]);
  expect(group.memberItemIds).toEqual([card.item.id]); expect(command.payload.groupIds).toEqual([]);
  expect(Object.keys(command.expected.groups)).toEqual(['g']);
  const receipt = f.execute(command);
  expect(f.state().groups).toEqual([]); expect(receipt.deletedIds).toContain(group.id);
  expect(f.state().containment).toEqual(before.containment!.filter(c => c.id === spare.item.id));
  expect(f.history().undo.at(-1)!.target.id).toBe(card.id);
  f.travel('history.undo'); const restored = f.state(), actual = restored.cards[0]!;
  expect(restored.groups![0]).toEqual({ ...group, versionId: expect.any(String) });
  expect(restored.groups![0]!.versionId).not.toBe(group.versionId);
  expect(restored.containment!.find(c => c.id === card.item.id)!.parent).toEqual({ kind: 'group', id: group.itemId });
  expect(restored.containment!.find(c => c.id === card.item.id)!.versionId).not.toBe(command.expected.containment[card.item.id]);
  expect(actual.title).toBe(card.title); expect(actual.body.blocks).toEqual(card.body.blocks); expect(actual.item.pose).toEqual(card.item.pose);
  expect(actual.versionId).not.toBe(card.versionId); expect(actual.body.versionId).not.toBe(card.body.versionId);
  expect(actual.item.versionId).not.toBe(card.item.versionId);
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
});

it.each([
  ['card', 'thought'], ['card', 'body'], ['card', 'pose'], ['card', 'appearance'], ['card', 'cardTags'],
  ['text', 'text'], ['text', 'pose'], ['shape', 'shape'], ['shape', 'pose'],
  ['image', 'image'], ['image', 'pose'], ['stroke', 'stroke'], ['stroke', 'pose'],
] as const)('五类删除%s.%s版本不匹配返回409，较晚成员冲突也回滚先前primitive与history', (kind, domain) => {
  const f = groupFixture(), values = { card: f.card(), text: f.text(), shape: f.shape(), image: f.image(), stroke: f.stroke() };
  f.execute({ type: 'card.appearance', expected: null, payload: { id: values.card.id, titleColor: '#f7e9bd', showPreview: false } });
  f.execute({ type: 'tag.create', expected: { cardTags: null }, payload: { id: 'tag', name: '标签', cardId: values.card.id } });
  f.group(Object.values(values).map(v => v.item.id));
  const command = capture(f, ['g'], []), before = f.state(), history = f.history();
  const expected = command.expected.items[values[kind].item.id] as Record<string, unknown>;
  expect(expected[domain]).toEqual(expect.any(String)); expected[domain] = 'stale-domain-version';
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes).toEqual([]);
  f.execute({ ...command, expected: capture(f, ['g'], []).expected }); expect(f.state().groups).toEqual([]);
});

it.each(['selected-group', 'parent-group', 'absent-row', 'null-row', 'kind', 'missing-item', 'extra-group', 'incident-add', 'incident-style', 'incident-remove'] as const)(
  '捕获后%s关系或闭包变化返回409而无半写，不重授权到新范围', trigger => {
    const f = groupFixture(), card = f.card(), text = f.text(), sibling = f.shape();
    if (trigger !== 'absent-row') f.group([card.item.id, text.item.id, sibling.item.id]);
    if (trigger === 'null-row') f.execute({ type: 'group.ungroup', expected: f.structure(), payload: { id: 'g' } });
    f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: sibling.item.id, side: 'left' } } });
    const roots = trigger === 'selected-group' ? ['g'] : [], command = capture(f, roots, [card.item.id, text.item.id]);
    if (trigger === 'selected-group' || trigger === 'parent-group')
      f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.structure().containment[sibling.item.id] }, payload: { id: 'g', itemId: sibling.item.id } });
    else if (trigger === 'absent-row' || trigger === 'null-row') {
      f.group([card.item.id, text.item.id], 'later');
      f.execute({ type: 'group.ungroup', expected: f.structure('later'), payload: { id: 'later' } });
      expect(f.state().containment!.find(c => c.id === card.item.id)!.parent).toBeNull();
      expect(f.state().containment!.find(c => c.id === card.item.id)!.versionId).not.toBe(command.expected.containment[card.item.id]);
    } else if (trigger === 'kind') command.expected.items[card.item.id] = { kind: 'shape', shape: 'wrong-kind', pose: card.item.versionId };
    else if (trigger === 'missing-item') delete command.expected.items[text.item.id];
    else if (trigger === 'extra-group') command.expected.groups.extra = 'unselected-group-version';
    else if (trigger === 'incident-add') f.execute({ type: 'connector.create', expected: null, payload: { id: 'new-line', start: { kind: 'bound', itemId: text.item.id, side: 'right' }, end: { kind: 'free', point: { x: 900, y: 100 } } } });
    else f.execute({ type: trigger === 'incident-style' ? 'connector.style' : 'connector.delete', expected: f.state().connectors![0]!.versionId,
      payload: trigger === 'incident-style' ? { id: 'line', style: { width: 7 } } : { id: 'line' } });
    const peer = f.state(), history = f.history();
    expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
    expect(f.state()).toEqual(peer); expect(f.history()).toEqual(history);
    expect(f.mapping.observe({ projectId: 'p', afterRevision: peer.project.revision }, f.human).changes).toEqual([]);
  });

it('未删兄弟内容和Pose、无关连线及Tag同行变化不锁住捕获删除，保留同行结果', () => {
  const f = groupFixture(), card = f.card(), sibling = f.shape(); f.group([card.item.id, sibling.item.id]);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'unrelated', start: { kind: 'bound', itemId: sibling.item.id, side: 'right' }, end: { kind: 'free', point: { x: 900, y: 200 } } } });
  const command = capture(f, [], [card.item.id]); expect(command.expected.connectors).toEqual({});
  f.execute({ type: 'shape.edit', expected: sibling.versionId, payload: { id: sibling.id, content: { ...sibling.content, shortText: '同行兄弟' } } });
  f.execute({ type: 'shape.move', expected: sibling.item.versionId, payload: { id: sibling.id, x: 800, y: 300 } });
  f.execute({ type: 'connector.style', expected: f.state().connectors![0]!.versionId, payload: { id: 'unrelated', style: { width: 7 } } });
  f.execute({ type: 'tag.create', expected: null, payload: { id: 'peer-tag', name: '同行标签' } });
  const peer = f.state(), history = f.history(); f.execute(command); const after = f.state();
  expect(after.project.revision).toBe(peer.project.revision + 1); expect(f.history().undo).toHaveLength(history.undo.length + 1);
  expect(after.shapes).toEqual(peer.shapes); expect(after.connectors).toEqual(peer.connectors); expect(after.tags).toEqual(peer.tags);
  expect(after.groups![0]!.memberItemIds).toEqual([sibling.item.id]); expect(after.cards).toEqual([]);
});
