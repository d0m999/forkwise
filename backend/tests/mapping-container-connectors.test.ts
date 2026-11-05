import { afterEach, expect, it } from 'vitest';
import { groupFixture, closeGroupFixtures, groupDeleteExpected } from './group-fixture.js';
import { captureContainerEndpoints } from '../src/mapping/container-endpoints.js';

afterEach(closeGroupFixtures);

it('容器本体与成员分别可绑定，不自动扩成全部成员线', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b');
  const group = f.group([a.item.id, b.item.id]);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'group-line',
    start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' },
    end: { kind: 'free', point: { x: 900, y: 50 } } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'member-line',
    start: { kind: 'bound', itemId: a.item.id, side: 'left' },
    end: { kind: 'free', point: { x: 100, y: 50 } } } });
  expect(f.state().connectors).toHaveLength(2);
  expect(f.state().connectors![0]!.start).toEqual({ kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' });
});

it('解组冻结可见外框右边中点，保留另一端和样式，一次undo恢复绑定', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b');
  const group = f.group([a.item.id, b.item.id]);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', path: 'curve',
    start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' },
    end: { kind: 'free', point: { x: 900, y: 50 } } } });
  const before = f.state(), history = f.history(), line = before.connectors![0]!;
  const receipt = f.execute({ type: 'group.ungroup', expected: { ...f.structure(), endpoints: captureContainerEndpoints(before, [`group:${group.itemId}`]) }, payload: { id: group.id } });
  expect(f.state().connectors![0]).toMatchObject({ ...line, versionId: expect.any(String), start: { kind: 'free', point: { x: 410, y: 50 } } });
  expect(f.state().connectors![0]!.versionId).not.toBe(line.versionId);
  expect(receipt.deletedIds).not.toContain(line.id);
  expect(receipt.changedIds).toContain(line.id);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.travel('history.undo'); expect(f.state().connectors![0]!.start).toEqual(line.start);
  f.travel('history.redo'); expect(f.state().connectors![0]!.start).toEqual({ kind: 'free', point: { x: 410, y: 50 } });
  const final = f.state(); f.reopen(); expect(f.state()).toEqual(final);
});

it('两分区同一批移除同时冻结两端，保留标签样式并一次历史重开', () => {
  const f = groupFixture();
  for (const [id, x] of [['left', 100], ['right', 500]] as const)
    f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} },
      payload: { id, itemIds: [], pose: { x, y: 10, width: 100, height: 80 } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', path: 'elbow',
    start: { kind: 'bound', targetKind: 'frame', itemId: 'left', side: 'right' },
    end: { kind: 'bound', targetKind: 'frame', itemId: 'right', side: 'left' } } });
  f.execute({ type: 'connector.label', expected: f.state().connectors![0]!.versionId, payload: { id: 'line',
    label: { text: '保留普通含义', position: .3, fontSize: 18, color: '#123456', bold: true } } });
  f.execute({ type: 'connector.style', expected: f.state().connectors![0]!.versionId, payload: { id: 'line', style: { color: '#112233', dash: 'dashed', width: 7 } } });
  const before = f.state(), line = before.connectors![0]!, history = f.history();
  const receipt = f.execute({ type: 'canvas.delete-selection', expected: { groups: {}, frames: Object.fromEntries(before.frames!.map(frame => [frame.id, frame.versionId])),
    containment: {}, items: {}, connectors: {}, endpoints: captureContainerEndpoints(before, ['frame:left', 'frame:right']) },
    payload: { groupIds: [], directItemIds: [], frameIds: ['left', 'right'] } });
  expect(f.state().frames).toEqual([]);
  expect(f.state().connectors![0]).toMatchObject({ path: 'elbow', style: line.style, label: line.label,
    start: { kind: 'free', point: { x: 200, y: 50 } }, end: { kind: 'free', point: { x: 500, y: 50 } } });
  expect(receipt.deletedIds).toEqual(['left', 'right']);
  expect(f.history().undo).toHaveLength(history.undo.length + 1);
  f.travel('history.undo'); expect(f.state().frames).toHaveLength(2);
  expect(f.state().connectors![0]!.start).toEqual(line.start); expect(f.state().connectors![0]!.end).toEqual(line.end);
  expect(f.state().connectors![0]!.versionId).not.toBe(line.versionId);
  f.travel('history.redo'); const after = f.state(); f.reopen(); expect(f.state()).toEqual(after);
});

it('单线复制将未复制Group端冻结为复制时世界点而非源容器身份', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), group = f.group([a.item.id, b.item.id]);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line',
    start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' },
    end: { kind: 'free', point: { x: 900, y: 50 } } } });
  const before = f.state(), line = before.connectors![0]!;
  f.execute({ type: 'canvas.duplicate', expected: { cards: {}, texts: {}, shapes: {}, images: {}, strokes: {},
    connectors: { [line.id]: line.versionId }, anchors: { [`group:${group.itemId}`]: group.versionId },
    endpoints: captureContainerEndpoints(before, [`group:${group.itemId}`]) },
    payload: { objects: [], connectors: [{ id: 'line', copyId: 'copy' }] } });
  const copy = f.state().connectors!.find(line => line.id === 'copy')!;
  expect(copy.start).toEqual({ kind: 'free', point: { x: 434, y: 74 } });
  expect(copy.end).toEqual({ kind: 'free', point: { x: 924, y: 74 } });
  f.execute({ type: 'group.ungroup', expected: { ...f.structure(), endpoints: captureContainerEndpoints(f.state(), [`group:${group.itemId}`]) }, payload: { id: group.id } });
  expect(f.state().connectors!.find(line => line.id === 'copy')).toEqual(copy);
});

it('删除整个组及成员时删除组本体线，优先于保内容冻结，undo完整恢复', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), group = f.group([a.item.id, b.item.id]);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line',
    start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' },
    end: { kind: 'free', point: { x: 900, y: 50 } } } });
  const before = f.state(), line = before.connectors![0]!;
  f.execute({ type: 'group.delete', expected: { ...groupDeleteExpected(f), endpoints: captureContainerEndpoints(before, [`group:${group.itemId}`]) }, payload: { id: group.id } });
  expect(f.state().groups).toEqual([]); expect(f.state().shapes).toEqual([]); expect(f.state().connectors).toEqual([]);
  f.travel('history.undo'); expect(f.state().groups).toHaveLength(1); expect(f.state().shapes).toHaveLength(2);
  expect(f.state().connectors![0]).toMatchObject({ start: line.start, end: line.end });
  f.travel('history.redo'); expect(f.state().connectors).toEqual([]);
});

it.each(['remove-last', 'delete-last', 'merge', 'explicit-line', 'delete-other'] as const)('移除路径%s使用操作前组边界且删除优先', mode => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), c = f.shape('c');
  const group = f.group([a.item.id, b.item.id]);
  if (mode === 'remove-last' || mode === 'delete-last')
    f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.structure().containment[b.item.id] }, payload: { id: 'g', itemId: b.item.id } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'bound', itemId: c.item.id, side: 'left' } } });
  const before = f.state(), endpoints = captureContainerEndpoints(before, [`group:${group.itemId}`]), line = before.connectors![0]!;
  if (mode === 'remove-last') f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.structure().containment[a.item.id], endpoints }, payload: { id: 'g', itemId: a.item.id } });
  if (mode === 'delete-last') f.execute({ type: 'shape.delete', expected: { shape: a.versionId, pose: a.item.versionId, connectors: {}, membership: { ...f.membership(a.item.id), endpoints } }, payload: { id: a.id } });
  if (mode === 'merge') f.execute({ type: 'group.create', expected: { groups: { g: before.groups![0]!.versionId, next: null },
    containment: { ...f.structure().containment, [c.item.id]: null }, endpoints }, payload: { id: 'next', itemIds: [group.itemId, c.item.id] } });
  if (mode === 'explicit-line' || mode === 'delete-other') f.execute({ type: 'canvas.delete-selection', expected: {
    groups: { g: before.groups![0]!.versionId }, containment: { ...f.structure().containment, ...(mode === 'delete-other' ? { [c.item.id]: null } : {}) },
    items: mode === 'delete-other' ? { [c.item.id]: { kind: 'shape', shape: c.versionId, pose: c.item.versionId } } : {},
    connectors: { [line.id]: line.versionId }, endpoints }, payload: { groupIds: [], directItemIds: mode === 'delete-other' ? [c.item.id] : [],
      ungroupIds: ['g'], ...(mode === 'explicit-line' ? { connectorIds: ['line'] } : {}) } });
  if (mode === 'explicit-line' || mode === 'delete-other') expect(f.state().connectors).toEqual([]);
  else expect(f.state().connectors![0]!.start).toEqual({ kind: 'free', point: { x: 410, y: 50 } });
  f.travel('history.undo'); expect(f.state().groups!.find(value => value.id === 'g')).toBeDefined();
  expect(f.state().connectors![0]!.start).toEqual(line.start);
  f.travel('history.redo'); const final = f.state(); f.reopen(); expect(f.state()).toEqual(final);
});

it('Group和Frame跨类型同一批移除，两个端点来自同一before世界快照', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), group = f.group([a.item.id, b.item.id]);
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', itemIds: [], pose: { x: 700, y: 0, width: 100, height: 80 } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'bound', targetKind: 'frame', itemId: 'frame', side: 'left' } } });
  const before = f.state();
  f.execute({ type: 'canvas.delete-selection', expected: { groups: { g: group.versionId }, frames: { frame: before.frames![0]!.versionId },
    containment: f.structure().containment, items: {}, connectors: {}, endpoints: captureContainerEndpoints(before, [`group:${group.itemId}`, 'frame:frame']) },
    payload: { groupIds: [], directItemIds: [], ungroupIds: ['g'], frameIds: ['frame'] } });
  expect(f.state().connectors![0]).toMatchObject({ start: { kind: 'free', point: { x: 410, y: 50 } }, end: { kind: 'free', point: { x: 700, y: 40 } } });
  f.travel('history.undo'); expect(f.state().groups).toHaveLength(1); expect(f.state().frames).toHaveLength(1);
});

it.each(['member-pose', 'membership', 'label', 'reconnect', 'incident', 'other-pose'] as const)('冻结读依赖%s按细域拒绝冲突且不写半状态', mode => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), other = f.shape('other'), group = f.group([a.item.id, b.item.id]);
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'bound', itemId: other.item.id, side: 'left' } } });
  const captured = f.state(), commandId = 'captured-ungroup', command = { commandId, type: 'group.ungroup', expected: { ...f.structure(), endpoints: captureContainerEndpoints(captured, [`group:${group.itemId}`]) }, payload: { id: 'g' } };
  if (mode === 'member-pose' || mode === 'other-pose') {
    const value = mode === 'member-pose' ? a : other;
    f.execute({ type: 'canvas.move', expected: { [value.item.id]: value.item.versionId }, payload: { targets: [{ kind: 'shape', id: value.id, itemId: value.item.id, x: 600, y: 60 }] } });
  } else if (mode === 'membership') f.execute({ type: 'group.remove-member', expected: { group: f.structure().group, containment: f.structure().containment[b.item.id] }, payload: { id: 'g', itemId: b.item.id } });
  else if (mode === 'label') f.execute({ type: 'connector.label', expected: captured.connectors![0]!.versionId, payload: { id: 'line', label: { text: 'peer', position: .5, fontSize: 18, color: '#123456', bold: false } } });
  else if (mode === 'reconnect') f.execute({ type: 'connector.reconnect', expected: captured.connectors![0]!.versionId, payload: { id: 'line', endpoint: 'end', value: { kind: 'free', point: { x: 999, y: 888 } } } });
  else f.execute({ type: 'connector.create', expected: null, payload: { id: 'new-line', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'left' }, end: { kind: 'free', point: { x: 0, y: 0 } } } });
  const before = f.state(), history = f.history();
  if (mode === 'other-pose') { f.execute(command); expect(f.state().connectors![0]!.start).toEqual({ kind: 'free', point: { x: 410, y: 50 } }); return; }
  expect(() => f.execute(command)).toThrow(/更新/);
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes).toEqual([]);
  // A rejected request did not consume its command ID or write a receipt.
  expect(() => f.execute({ ...command, expected: { ...f.structure(), endpoints: captureContainerEndpoints(f.state(), [`group:${group.itemId}`]) } })).not.toThrow();
});

it('普通item和Frame同字符串身份仍按类型匹配，自连接、删除和复制不混淆', () => {
  const f = groupFixture(), shape = f.shape();
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: shape.item.id, itemIds: [], pose: { x: 100, y: 10, width: 100, height: 80 } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'mixed', start: { kind: 'bound', itemId: shape.item.id, side: 'left' }, end: { kind: 'bound', targetKind: 'frame', itemId: shape.item.id, side: 'right' } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'frame-only', start: { kind: 'bound', targetKind: 'frame', itemId: shape.item.id, side: 'right' }, end: { kind: 'free', point: { x: 900, y: 50 } } } });
  const before = f.state(), frameLine = before.connectors!.find(line => line.id === 'frame-only')!, mixed = before.connectors!.find(line => line.id === 'mixed')!;
  f.execute({ type: 'canvas.duplicate', expected: { cards: {}, texts: {}, shapes: {}, images: {}, strokes: {}, connectors: { [frameLine.id]: frameLine.versionId },
    anchors: { [`frame:${shape.item.id}`]: before.frames![0]!.versionId }, endpoints: captureContainerEndpoints({ ...before, connectors: [frameLine] }, [`frame:${shape.item.id}`]) },
    payload: { objects: [], connectors: [{ id: frameLine.id, copyId: 'frame-copy' }] } });
  expect(f.state().connectors!.find(line => line.id === 'frame-copy')!.start).toEqual({ kind: 'free', point: { x: 224, y: 74 } });
  f.execute({ type: 'shape.delete', expected: { shape: shape.versionId, pose: shape.item.versionId, connectors: { mixed: mixed.versionId } }, payload: { id: shape.id } });
  expect(f.state().connectors!.map(line => line.id)).toEqual(['frame-only', 'frame-copy']);
  expect(f.state().connectors![0]).toEqual(frameLine);
});

it('Group和Frame同字符串端点身份使用各自几何，重复或冲突的新集合在边界拒绝', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.stroke('b'), group = f.group([a.item.id, b.item.id]);
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: group.itemId, itemIds: [], pose: { x: 100, y: 10, width: 100, height: 80 } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'mixed', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'bound', targetKind: 'frame', itemId: group.itemId, side: 'right' } } });
  const s = f.state(), command = { type: 'canvas.delete-selection', expected: { groups: { g: group.versionId }, frames: { [group.itemId]: s.frames![0]!.versionId },
    containment: f.structure().containment, items: {}, connectors: {}, endpoints: captureContainerEndpoints(s, [`group:${group.itemId}`, `frame:${group.itemId}`]) }, payload: { groupIds: [], directItemIds: [], ungroupIds: ['g'], frameIds: [group.itemId] } };
  expect(() => f.execute({ ...command, payload: { ...command.payload, ungroupIds: ['g', 'g'] } })).toThrow();
  expect(() => f.execute({ ...command, payload: { ...command.payload, groupIds: ['g'] } })).toThrow();
  f.execute(command);
  // Stroke pose extends the visible group to x450; Frame stays independent at x200.
  expect(f.state().connectors![0]).toMatchObject({ start: { kind: 'free', point: { x: 450, y: 50 } }, end: { kind: 'free', point: { x: 200, y: 50 } } });
});

it('跨项目Group或Frame不是有效端点，legacy普通成功回执重开重试保持原表示', () => {
  const f = groupFixture(), shape = f.shape();
  f.execute({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '另一项目' } });
  f.execute({ projectId: 'q', type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'foreign', itemIds: [], pose: { x: 1, y: 2, width: 100, height: 80 } } });
  for (const id of ['qa', 'qb']) f.execute({ projectId: 'q', type: 'shape.create', expected: null, payload: { id, content: { shapeType: 'rectangle', shortText: id }, pose: { x: 10, y: 20, width: 100, height: 60 } } });
  const q = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
  f.execute({ projectId: 'q', type: 'group.create', expected: { groups: { 'foreign-group': null }, containment: Object.fromEntries(q.shapes!.map(shape => [shape.item.id, q.containment!.find(v => v.id === shape.item.id)?.versionId ?? null])) }, payload: { id: 'foreign-group', itemIds: q.shapes!.map(shape => shape.item.id) } });
  const foreignGroup = f.mapping.read({ type: 'project', projectId: 'q' }, f.human).groups![0]!;
  expect(() => f.execute({ type: 'connector.create', expected: null, payload: { id: 'invalid', start: { kind: 'bound', targetKind: 'frame', itemId: 'foreign', side: 'left' }, end: { kind: 'free', point: { x: 0, y: 0 } } } })).toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
  expect(() => f.execute({ type: 'connector.create', expected: null, payload: { id: 'invalid-group', start: { kind: 'bound', targetKind: 'group', itemId: foreignGroup.itemId, side: 'left' }, end: { kind: 'free', point: { x: 0, y: 0 } } } })).toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
  const command = { commandId: 'legacy-retry', type: 'connector.create', expected: null, payload: { id: 'legacy', start: { kind: 'bound', itemId: shape.item.id, side: 'left' }, end: { kind: 'free', point: { x: 0, y: 0 } } } };
  const receipt = f.execute(command); f.reopen(); expect(f.execute(command)).toEqual(receipt);
  expect(f.state().connectors![0]!.start).not.toHaveProperty('targetKind');
});

it('Frame自身pose版本变化使旧冻结命令原子拒绝，合法重叠冻结不套新建零长度校验', () => {
  const f = groupFixture();
  for (const id of ['a', 'b']) f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id, itemIds: [], parentId: null, pose: { x: 100, y: 10, width: 100, height: 80 } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'overlap', start: { kind: 'bound', targetKind: 'frame', itemId: 'a', side: 'right' }, end: { kind: 'bound', targetKind: 'frame', itemId: 'b', side: 'right' } } });
  const initial = f.state(), captured = { type: 'frame.delete', expected: { frame: initial.frames![0]!.versionId, containment: {}, endpoints: captureContainerEndpoints(initial, ['frame:a']) }, payload: { id: 'a' } };
  f.execute({ type: 'frame.move', expected: { frame: initial.frames![0]!.versionId, groups: {}, containment: {}, poses: {} }, payload: { id: 'a', dx: 20, dy: 0 } });
  const moved = f.state(), history = f.history(); expect(() => f.execute(captured)).toThrow(/更新/); expect(f.state()).toEqual(moved); expect(f.history()).toEqual(history);
  f.travel('history.undo'); const restored = f.state();
  f.execute({ type: 'canvas.delete-selection', expected: { groups: {}, frames: Object.fromEntries(restored.frames!.map(frame => [frame.id, frame.versionId])), containment: {}, items: {}, connectors: {}, endpoints: captureContainerEndpoints(restored, ['frame:a', 'frame:b']) }, payload: { groupIds: [], directItemIds: [], frameIds: ['a', 'b'] } });
  expect(f.state().connectors![0]).toMatchObject({ start: { kind: 'free', point: { x: 200, y: 50 } }, end: { kind: 'free', point: { x: 200, y: 50 } } });
});

it.each(['group', 'frame'] as const)('普通单端加线复制仅绑定新副本，未复制%s端冻结', kind => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), loose = f.shape('loose'), group = f.group([a.item.id, b.item.id]);
  if (kind === 'frame') f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', itemIds: [], pose: { x: 100, y: 10, width: 100, height: 80 } } });
  const itemId = kind === 'group' ? group.itemId : 'frame';
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', targetKind: kind, itemId, side: 'right' }, end: { kind: 'bound', itemId: loose.item.id, side: 'left' } } });
  const s = f.state(), line = s.connectors![0]!;
  f.execute({ type: 'canvas.duplicate', expected: { cards: {}, texts: {}, shapes: { loose: { content: loose.versionId, pose: loose.item.versionId } }, images: {}, strokes: {},
    connectors: { line: line.versionId }, anchors: { [`${kind}:${itemId}`]: kind === 'group' ? group.versionId : s.frames![0]!.versionId }, endpoints: captureContainerEndpoints(s, [`${kind}:${itemId}`]) },
    payload: { objects: [{ kind: 'shape', id: loose.id, copyId: 'loose-copy' }], connectors: [{ id: 'line', copyId: 'line-copy' }] } });
  const copy = f.state().connectors!.find(line => line.id === 'line-copy')!, copiedItem = f.state().shapes!.find(shape => shape.id === 'loose-copy')!;
  expect(copy.start).toEqual({ kind: 'free', point: { x: kind === 'group' ? 434 : 224, y: 74 } });
  expect(copy.end).toEqual({ kind: 'bound', itemId: copiedItem.item.id, side: 'left' });
  expect(copiedItem.item.id).not.toBe(loose.item.id);
});

it('合法160字符Frame身份的typed复制依赖键可表达且无截断', () => {
  const f = groupFixture(), id = 'f'.repeat(160);
  f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id, itemIds: [], pose: { x: 100, y: 10, width: 100, height: 80 } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'bound', targetKind: 'frame', itemId: id, side: 'right' }, end: { kind: 'free', point: { x: 900, y: 50 } } } });
  const s = f.state();
  f.execute({ type: 'canvas.duplicate', expected: { cards: {}, texts: {}, shapes: {}, images: {}, strokes: {}, connectors: { line: s.connectors![0]!.versionId },
    anchors: { [`frame:${id}`]: s.frames![0]!.versionId }, endpoints: captureContainerEndpoints(s, [`frame:${id}`]) }, payload: { objects: [], connectors: [{ id: 'line', copyId: 'copy' }] } });
  expect(f.state().connectors![1]!.start).toEqual({ kind: 'free', point: { x: 224, y: 74 } });
});

it.each(['group', 'frame'] as const)('%s重接后移动容器、移除后再移动另一端，绑定与自由端历史各自正确', kind => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), other = f.shape('other'), group = f.group([a.item.id, b.item.id]);
  if (kind === 'frame') f.execute({ type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', itemIds: [], pose: { x: 100, y: 10, width: 100, height: 80 } } });
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: { kind: 'free', point: { x: 0, y: 0 } }, end: { kind: 'bound', itemId: other.item.id, side: 'left' } } });
  const itemId = kind === 'group' ? group.itemId : 'frame';
  f.execute({ type: 'connector.reconnect', expected: f.state().connectors![0]!.versionId, payload: { id: 'line', endpoint: 'start', value: { kind: 'bound', targetKind: kind, itemId, side: 'right' } } });
  const connected = f.state(), line = connected.connectors![0]!;
  if (kind === 'group') f.execute({ type: 'group.move', expected: { ...f.structure(), poses: { [a.item.id]: a.item.versionId, [b.item.id]: b.item.versionId } }, payload: { id: 'g', dx: 100, dy: 20 } });
  else f.execute({ type: 'frame.move', expected: { frame: connected.frames![0]!.versionId, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', dx: 100, dy: 20 } });
  expect(f.state().connectors![0]).toEqual(line);
  const moved = f.state(), endpoints = captureContainerEndpoints(moved, [`${kind}:${itemId}`]);
  if (kind === 'group') f.execute({ type: 'group.ungroup', expected: { ...f.structure(), endpoints }, payload: { id: 'g' } });
  else f.execute({ type: 'frame.delete', expected: { frame: moved.frames![0]!.versionId, containment: {}, endpoints }, payload: { id: 'frame' } });
  const point = { x: kind === 'group' ? 510 : 300, y: 70 };
  expect(f.state().connectors![0]!.start).toEqual({ kind: 'free', point });
  f.execute({ type: 'canvas.move', expected: { [other.item.id]: other.item.versionId }, payload: { targets: [{ kind: 'shape', id: other.id, itemId: other.item.id, x: 1000, y: 200 }] } });
  expect(f.state().connectors![0]!.start).toEqual({ kind: 'free', point }); expect(f.state().connectors![0]!.end).toEqual(line.end);
  f.travel('history.undo'); f.travel('history.undo'); expect(f.state().connectors![0]!.start).toEqual(line.start);
  f.travel('history.redo'); f.travel('history.redo'); const final = f.state(); f.reopen(); expect(f.state()).toEqual(final);
});

it.each([false, true])('普通端点缺省item与显式item互换不占历史且保redo（原显式=%s）', explicit => {
  const f = groupFixture(), shape = f.shape();
  const start = { kind: 'bound', itemId: shape.item.id, side: 'right', ...(explicit ? { targetKind: 'item' } : {}) };
  f.execute({ type: 'connector.create', expected: null, payload: { id: 'line', start, end: { kind: 'free', point: { x: 900, y: 50 } } } });
  f.execute({ type: 'connector.path', expected: f.state().connectors![0]!.versionId, payload: { id: 'line', path: 'curve' } });
  f.travel('history.undo');
  const before = f.state(), history = f.history();
  const command = { commandId: 'representation-only', type: 'connector.reconnect', expected: before.connectors![0]!.versionId,
    payload: { id: 'line', endpoint: 'start', value: { kind: 'bound', itemId: shape.item.id, side: 'right', ...(!explicit ? { targetKind: 'item' } : {}) } } };
  const receipt = f.execute(command);
  expect(receipt.changedIds).toEqual([]); expect(receipt.revision).toBe(before.project.revision);
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  f.reopen(); expect(f.execute(command)).toEqual(receipt); expect(f.state()).toEqual(before);
  f.travel('history.redo'); expect(f.state().connectors![0]!.path).toBe('curve'); expect(f.state().connectors![0]!.start).toEqual(start);
});
