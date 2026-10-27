import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { openMapping } from '../src/mapping/storage.js';

const fixtures: { mapping: ReturnType<typeof openMapping>; directory: string }[] = [];
function resource(event: string, directory: string) {
  const log = process.env.FORKWISE_ISSUE28_RESOURCE_LOG;
  if (log) appendFileSync(log, JSON.stringify({ event, directory, pid: process.pid, at: new Date().toISOString(), exists: existsSync(directory) }) + '\n');
}
afterEach(() => {
  for (const value of fixtures.splice(0)) {
    value.mapping.close();
    rmSync(value.directory, { recursive: true, force: true });
    resource('closed-and-removed', value.directory);
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-groups-'));
  const host = openMapping(directory);
  resource('allocated', directory);
  const token = host.access.issue('human', ['*']);
  const value = {
    directory,
    mapping: host,
    human: host.access.authenticate(token),
    token,
    execute(command: Record<string, unknown>) {
      return value.mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, value.human);
    },
    state() { return value.mapping.read({ type: 'project', projectId: 'p' }, value.human); },
    history() { return value.mapping.read({ type: 'history', projectId: 'p' }, value.human); },
    reopen() {
      value.mapping.close();
      value.mapping = openMapping(directory);
      value.human = value.mapping.access.authenticate(token);
    },
  };
  fixtures.push(value);
  value.execute({ type: 'project.create', expected: null, payload: { name: '一层组合' } });
  return value;
}

function mixed(f: ReturnType<typeof fixture>) {
  f.execute({ type: 'thought.create', expected: null, payload: { id: 'card', title: '独立卡片', text: '完整正文不合并', x: 10, y: 20 } });
  f.execute({ type: 'text.create', expected: null, payload: { id: 'text', content: {
    runs: [{ text: '独立说明' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 100,
  }, pose: { x: 400, y: 60, width: 100, height: 27 } } });
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'shape', content: { shapeType: 'ellipse', shortText: '形状' }, pose: { x: -60, y: 200, width: 140, height: 80 } } });
  f.execute({ type: 'asset.save', expected: null, payload: { id: 'asset', name: 'fixture.png', mime: 'image/png', base64: createCanvas(2, 3).toBuffer('image/png').toString('base64') } });
  f.execute({ type: 'image.create', expected: null, payload: { id: 'image', content: { assetId: 'asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 600, y: 100, width: 60, height: 40, rotation: 90 } } });
  f.execute({ type: 'stroke.create', expected: null, payload: { id: 'stroke', content: { penKind: 'highlighter', path: [{ x: 6, y: 6 }, { x: 74, y: 16 }], color: '#ffe08a', width: 12, opacity: 0.4 }, pose: { x: 80, y: -35, width: 80, height: 22 } } });
  const s = f.state();
  return [s.cards[0]!, s.texts![0]!, s.shapes![0]!, s.images![0]!, s.strokes![0]!];
}

it('五类对象建成一层组合，经同revision投影、不可变版本、序列化重开与一步撤销重做保留身份和内容', () => {
  const f = fixture(), values = mixed(f), before = f.state(), history = f.history();
  const ids = values.map(value => value.item.id);
  const oldMap = f.mapping.read({ type: 'map', projectId: 'p', view: 'index' }, f.human);
  const command = { commandId: randomUUID(), type: 'group.create', expected: {
    groups: { group: null }, containment: Object.fromEntries(ids.map(id => [id, null])),
  }, payload: { id: 'group', itemIds: ids } };
  const receipt = f.execute(command), created = f.state(), group = created.groups![0]!;
  expect(created.project.revision).toBe(before.project.revision + 1);
  expect(created.cards).toEqual(before.cards);
  for (const key of ['texts', 'shapes', 'images', 'strokes'] as const) expect(created[key]).toEqual(before[key]);
  expect(group).toMatchObject({ id: 'group', kind: 'group', memberItemIds: ids });
  expect(created.containment).toEqual(ids.map(id => ({ id, versionId: expect.any(String), parent: { kind: 'group', id: group.itemId } })));
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  const map = f.mapping.read({ type: 'map', projectId: 'p', view: 'group-index' }, f.human);
  const memberships = f.mapping.read({ type: 'map', projectId: 'p', view: 'containment', snapshot: map.snapshot }, f.human);
  expect(map.revision).toBe(created.project.revision);
  expect(map.items).toEqual([{ id: group.id, type: 'group', versionId: group.versionId, itemId: group.itemId, createdOrder: group.createdOrder, bounds: group.bounds, memberCount: 5 }]);
  expect(memberships.items).toEqual(created.containment);
  expect(memberships.revision).toBe(map.revision);
  expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'group-index', snapshot: oldMap.snapshot }, f.human).items).toEqual([]);
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(delta.changes).toHaveLength(1);
  expect(delta.changes[0]!.domains).toEqual([{ domain: 'group', id: group.id }, ...ids.map(id => ({ domain: 'containment', id }))]);
  const groupVersion = f.mapping.read({ type: 'version', projectId: 'p', domain: 'group', id: group.id, versionId: group.versionId }, f.human);
  expect(groupVersion).toEqual({ id: group.id, versionId: group.versionId, itemId: group.itemId, createdOrder: group.createdOrder });
  const serialized = JSON.parse(JSON.stringify(created));
  f.reopen();
  expect(f.state()).toEqual(serialized);
  expect(f.execute(command)).toEqual(receipt);
  f.execute({ type: 'history.undo', expected: created.project.revision, payload: {} });
  expect(f.state().groups).toEqual([]);
  expect(f.state().containment).toEqual([]);
  expect(f.state().cards).toEqual(before.cards);
  f.execute({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  const restored = f.state();
  expect(restored.groups![0]).toMatchObject({ id: group.id, itemId: group.itemId, memberItemIds: ids, bounds: group.bounds });
  expect(restored.groups![0]!.versionId).not.toBe(group.versionId);
  expect(restored.containment!.map(value => value.versionId)).not.toEqual(created.containment!.map(value => value.versionId));
  expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'group', id: group.id, versionId: group.versionId }, f.human)).toEqual(groupVersion);
});

it('旧组加成员重新组合扁平合并，原组剩一成员保留且归属唯一，撤销恢复旧边界', () => {
  const f = fixture(), values = mixed(f), ids = values.map(value => value.item.id);
  for (const [id, members] of [['ab', ids.slice(0, 2)], ['cd', ids.slice(2, 4)]] as const)
    f.execute({ type: 'group.create', expected: { groups: { [id]: null }, containment: Object.fromEntries(members.map(item => [item, null])) }, payload: { id, itemIds: members } });
  const before = f.state(), ab = before.groups!.find(g => g.id === 'ab')!, cd = before.groups!.find(g => g.id === 'cd')!;
  const selected = [ids[0]!, ids[1]!, ids[2]!, ids[4]!];
  const command = { type: 'group.create', expected: { groups: { merged: null, ab: ab.versionId, cd: cd.versionId },
    containment: Object.fromEntries(selected.map(id => [id, before.containment!.find(value => value.id === id)?.versionId ?? null])),
  }, payload: { id: 'merged', itemIds: [ab.itemId, ids[2]!, ids[4]!] } };
  const history = f.history(); f.execute(command);
  const merged = f.state(), group = merged.groups!.find(value => value.id === 'merged')!;
  expect(merged.groups).toHaveLength(2);
  expect(merged.groups!.find(value => value.id === 'ab')).toBeUndefined();
  expect(group.memberItemIds).toEqual(selected);
  expect(merged.groups!.find(value => value.id === 'cd')!.memberItemIds).toEqual([ids[3]]);
  expect(new Set(merged.containment!.map(value => value.id)).size).toBe(5);
  for (const id of selected) expect(merged.containment!.find(value => value.id === id)!.parent).toEqual({ kind: 'group', id: group.itemId });
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) expect(merged[key]).toEqual(before[key]);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.execute({ type: 'history.undo', expected: merged.project.revision, payload: {} });
  expect(f.state().groups!.map(value => [value.id, value.itemId, value.memberItemIds])).toEqual(before.groups!.map(value => [value.id, value.itemId, value.memberItemIds]));
  expect(f.state().containment!.map(value => [value.id, value.parent])).toEqual(before.containment!.map(value => [value.id, value.parent]));
  f.execute({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  expect(f.state().groups!.find(value => value.id === 'merged')).toMatchObject({ itemId: group.itemId, memberItemIds: selected });
  f.reopen();
  expect(f.state().groups!.find(value => value.id === 'merged')!.memberItemIds).toEqual(selected);
});

it('捕获的组归属被同行重新组合后返回409且不半写，失败commandId可用明确新依据重试', () => {
  const f = fixture(), values = mixed(f), ids = values.map(value => value.item.id);
  f.execute({ type: 'group.create', expected: { groups: { ab: null }, containment: { [ids[0]!]: null, [ids[1]!]: null } }, payload: { id: 'ab', itemIds: ids.slice(0, 2) } });
  const captured = f.state(), ab = captured.groups![0]!;
  const command = { commandId: randomUUID(), type: 'group.create', expected: { groups: { pending: null, ab: ab.versionId },
    containment: Object.fromEntries([ids[0]!, ids[1]!, ids[4]!].map(id => [id, captured.containment!.find(value => value.id === id)?.versionId ?? null])),
  }, payload: { id: 'pending', itemIds: [ids[0]!, ids[1]!, ids[4]!] } };
  f.execute({ type: 'group.create', expected: { groups: { peer: null, ab: ab.versionId }, containment: { [ids[0]!]: captured.containment![0]!.versionId, [ids[2]!]: null } }, payload: { id: 'peer', itemIds: [ids[0]!, ids[2]!] } });
  const peer = f.state(), history = f.history();
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
  expect(f.state()).toEqual(peer); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: peer.project.revision }, f.human).changes).toEqual([]);
  const fresh = { ...command, expected: { groups: { pending: null, ...Object.fromEntries(peer.groups!.map(group => [group.id, group.versionId])) },
    containment: Object.fromEntries(command.payload.itemIds.map(id => [id, peer.containment!.find(value => value.id === id)?.versionId ?? null])),
  } };
  f.execute(fresh);
  expect(f.state().groups!.find(group => group.id === 'pending')!.memberItemIds).toEqual(command.payload.itemIds);
  expect(f.state().groups!.find(group => group.id === 'peer')!.memberItemIds).toEqual([ids[2]]);
});

it('五类组合原子平移保内容笔迹与普通线自由端，明确外框坐标、同快照、零位移和一步历史重开一致', () => {
  const f = fixture(); mixed(f);
  const card = f.state().cards[0]!;
  f.execute({ type: 'pose.batch', expected: { [card.id]: card.item.versionId }, payload: { poses: [{ id: card.id, x: 10, y: 20, width: 120, height: 120 }] } });
  const original = f.state(), values = [original.cards[0]!, original.texts![0]!, original.shapes![0]!, original.images![0]!, original.strokes![0]!];
  const ids = values.map(value => value.item.id);
  f.execute({ type: 'group.create', expected: { groups: { moving: null }, containment: Object.fromEntries(ids.map(id => [id, null])) }, payload: { id: 'moving', itemIds: ids } });
  for (const payload of [
    { id: 'internal', start: { kind: 'bound', itemId: ids[0], side: 'right' }, end: { kind: 'bound', itemId: ids[2], side: 'top' } },
    { id: 'mixed-line', start: { kind: 'bound', itemId: ids[1], side: 'bottom' }, end: { kind: 'free', point: { x: 1000, y: 1000 } } },
    { id: 'free-line', start: { kind: 'free', point: { x: 1000, y: 30 } }, end: { kind: 'free', point: { x: 1100, y: 100 } } },
  ]) f.execute({ type: 'connector.create', expected: null, payload });
  const before = f.state(), group = before.groups![0]!, history = f.history();
  expect(group.bounds).toEqual({ x: -60, y: -35, width: 720, height: 315 });
  const pinned = f.mapping.read({ type: 'map', projectId: 'p', view: 'group-index' }, f.human);
  const command = { commandId: randomUUID(), type: 'group.move', expected: { group: group.versionId,
    containment: Object.fromEntries(before.containment!.map(value => [value.id, value.versionId])),
    poses: Object.fromEntries(values.map(value => [value.item.id, value.item.versionId])),
  }, payload: { id: group.id, dx: 80, dy: 50 } };
  const receipt = f.execute(command), moved = f.state();
  const movedValues = [moved.cards[0]!, moved.texts![0]!, moved.shapes![0]!, moved.images![0]!, moved.strokes![0]!];
  const positions = [{ x: 90, y: 70 }, { x: 480, y: 110 }, { x: 20, y: 250 }, { x: 680, y: 150 }, { x: 160, y: 15 }];
  movedValues.forEach((value, index) => expect(value).toEqual({ ...values[index], item: { ...values[index]!.item, versionId: expect.any(String), pose: { ...values[index]!.item.pose, ...positions[index] } } }));
  expect(moved.strokes![0]!.versionId).toBe(before.strokes![0]!.versionId);
  expect(moved.groups![0]).toEqual({ ...group, bounds: { x: 20, y: 15, width: 720, height: 315 } });
  expect(moved.containment).toEqual(before.containment); expect(moved.connectors).toEqual(before.connectors);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  const map = f.mapping.read({ type: 'map', projectId: 'p', view: 'group-index' }, f.human);
  expect(map.revision).toBe(moved.project.revision);
  expect(map.items[0]).toMatchObject({ bounds: { x: 20, y: 15, width: 720, height: 315 } });
  expect(f.mapping.read({ type: 'map', projectId: 'p', view: 'group-index', snapshot: pinned.snapshot }, f.human).items).toEqual(pinned.items);
  const delta = f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
  expect(delta.changes).toHaveLength(1); expect(delta.changes[0]!.domains).toEqual(ids.map(id => ({ domain: 'pose', id })));
  f.reopen(); expect(f.state()).toEqual(moved); expect(f.execute(command)).toEqual(receipt);
  f.execute({ ...command, commandId: randomUUID(), expected: { ...command.expected, poses: Object.fromEntries(movedValues.map(value => [value.item.id, value.item.versionId])) }, payload: { ...command.payload, dx: 0, dy: 0 } });
  expect(f.state()).toEqual(moved); expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.execute({ type: 'history.undo', expected: moved.project.revision, payload: {} });
  expect(f.state().groups![0]!.bounds).toEqual({ x: -60, y: -35, width: 720, height: 315 });
  expect(f.state().strokes![0]!.content).toEqual(before.strokes![0]!.content);
  expect(f.state().strokes![0]!.versionId).toBe(before.strokes![0]!.versionId);
  f.execute({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
  expect(f.state().groups![0]!.bounds).toEqual({ x: 20, y: 15, width: 720, height: 315 });
});

it('两个已有组合重组后全部普通成员在同一层，成员Pose同行更新让整组移动原子拒绝', () => {
  const f = fixture(), values = mixed(f), ids = values.map(value => value.item.id);
  for (const [id, members] of [['ab', ids.slice(0, 2)], ['cd', ids.slice(2, 4)]] as const)
    f.execute({ type: 'group.create', expected: { groups: { [id]: null }, containment: Object.fromEntries(members.map(item => [item, null])) }, payload: { id, itemIds: members } });
  const before = f.state();
  f.execute({ type: 'group.create', expected: { groups: { flat: null, ...Object.fromEntries(before.groups!.map(value => [value.id, value.versionId])) },
    containment: Object.fromEntries(ids.map(id => [id, before.containment!.find(value => value.id === id)?.versionId ?? null])),
  }, payload: { id: 'flat', itemIds: [...before.groups!.map(value => value.itemId), ids[4]] } });
  const flat = f.state(), group = flat.groups![0]!;
  expect(flat.groups).toHaveLength(1); expect(group.memberItemIds).toEqual(ids);
  const command = { type: 'group.move', expected: { group: group.versionId,
    containment: Object.fromEntries(flat.containment!.map(value => [value.id, value.versionId])),
    poses: Object.fromEntries(values.map(value => [value.item.id, value.item.versionId])),
  }, payload: { id: group.id, dx: 100, dy: 200 } };
  f.execute({ type: 'shape.move', expected: flat.shapes![0]!.item.versionId, payload: { id: 'shape', x: 50, y: 70 } });
  const peer = f.state(), history = f.history();
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT', status: 409 }));
  expect(f.state()).toEqual(peer); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: peer.project.revision }, f.human).changes).toEqual([]);
});
