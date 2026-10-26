import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

function connectorMap() {
  const f = lifecycleFixture({}, '连线编辑');
  const { run, state } = f;
  for (const id of ['a', 'b', 'c']) run({ type: 'thought.create', expected: null, payload: { id, title: id, text: '保留正文', x: 0, y: 0 } });
  const cards = state().cards;
  const bound = (index: number, side = 'right') => ({ kind: 'bound', itemId: cards[index]!.item.id, side });
  const free = (x: number, y: number) => ({ kind: 'free', point: { x, y } });
  const line = (start: unknown, end: unknown) => {
    run({ type: 'connector.create', expected: null, payload: { id: 'line', start, end } });
    return state().connectors![0]!;
  };
  return Object.assign(f, { cards, bound, free, line });
}

it('普通连线重接一端到新对象并保持另一端', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.bound(0), f.bound(1, 'left'));
    const historyBefore = f.history();
    const receipt = f.run({ type: 'connector.reconnect', expected: original.versionId, payload: { id: original.id, endpoint: 'start', value: f.bound(2, 'top') } });
    const changed = f.state().connectors![0]!;
    expect(changed).toEqual({ ...original, versionId: expect.any(String), start: { kind: 'bound', itemId: f.cards[2]!.item.id, side: 'top' } });
    expect(changed.versionId).not.toBe(original.versionId);
    expect(receipt.connectorVersions).toEqual({ line: changed.versionId });
    expect(f.state().cards).toEqual(f.cards);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors![0]).toEqual({ ...original, versionId: expect.any(String) });
  } finally { f.close(); }
});

it('普通连线重接到原对象另一边保持绑定身份', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.bound(0), f.bound(1, 'left'));
    const historyBefore = f.history();
    f.run({ type: 'connector.reconnect', expected: original.versionId, payload: { id: original.id, endpoint: 'start', value: f.bound(0, 'top') } });
    const changed = f.state().connectors![0]!;
    expect(changed).toEqual({ ...original, versionId: expect.any(String), start: { kind: 'bound', itemId: f.cards[0]!.item.id, side: 'top' } });
    expect(changed.versionId).not.toBe(original.versionId);
    expect(f.state().cards).toEqual(f.cards);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
  } finally { f.close(); }
});

it('普通连线单端拖到空白解除绑定并保持另一端', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.bound(0), f.bound(1, 'left'));
    f.run({ type: 'connector.reconnect', expected: original.versionId, payload: { id: original.id, endpoint: 'end', value: f.free(-25.5, 360.25) } });
    expect(f.state().connectors![0]).toEqual({ ...original, versionId: expect.any(String), end: { kind: 'free', point: { x: -25.5, y: 360.25 } } });
    expect(f.state().cards).toEqual(f.cards);
    expect(f.history().undo.at(-1)).toMatchObject({ label: 'connector.reconnect', target: { id: 'line' } });
  } finally { f.close(); }
});

it('普通连线路径可在直折曲之间切换且保持端点', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.bound(0, 'top'), f.free(60, -80));
    const historyBefore = f.history();
    for (const path of ['elbow', 'curve', 'straight']) {
      const current = f.state().connectors![0]!;
      const receipt = f.run({ type: 'connector.path', expected: current.versionId, payload: { id: current.id, path } });
      const changed = f.state().connectors![0]!;
      expect(changed).toEqual({ ...original, path, versionId: expect.any(String) });
      expect(changed.versionId).not.toBe(current.versionId);
      expect(receipt.connectorVersions).toEqual({ line: changed.versionId });
      expect(f.state().cards).toEqual(f.cards);
    }
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 3);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors![0]!.path).toBe('curve');
  } finally { f.close(); }
});

it('两端自由普通连线整体拖动只平移端点', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.free(-40.5, 20.25), f.free(160.5, 120.25));
    const historyBefore = f.history();
    f.run({ type: 'connector.move', expected: original.versionId, payload: { id: original.id, dx: 12.5, dy: -30.25 } });
    expect(f.state().connectors![0]).toEqual({ ...original, versionId: expect.any(String),
      start: { kind: 'free', point: { x: -28, y: -10 } }, end: { kind: 'free', point: { x: 173, y: 90 } },
    });
    expect(f.state().cards).toEqual(f.cards);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors![0]).toEqual({ ...original, versionId: expect.any(String) });
  } finally { f.close(); }
});

it('一端绑定普通连线整体拖动只平移自由端', () => {
  const f = connectorMap();
  try {
    const inputs = [
      { id: 'bound-start', start: f.bound(0), end: f.free(100, 50), dx: 20, dy: -10, expectedStart: f.bound(0), expectedEnd: f.free(120, 40) },
      { id: 'bound-end', start: f.free(10, 20), end: f.bound(1, 'left'), dx: -5, dy: 7, expectedStart: f.free(5, 27), expectedEnd: f.bound(1, 'left') },
    ];
    for (const value of inputs) {
      f.run({ type: 'connector.create', expected: null, payload: { id: value.id, start: value.start, end: value.end } });
      const original = f.state().connectors!.find(line => line.id === value.id)!;
      f.run({ type: 'connector.move', expected: original.versionId, payload: { id: original.id, dx: value.dx, dy: value.dy } });
      expect(f.state().connectors!.find(line => line.id === value.id)).toEqual({ ...original, versionId: expect.any(String), start: value.expectedStart, end: value.expectedEnd });
      expect(f.state().cards).toEqual(f.cards);
    }
  } finally { f.close(); }
});

it('两端绑定普通连线整体拖动不拆绑且不新增历史', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.bound(0, 'top'), f.bound(1, 'bottom'));
    const before = f.state(), historyBefore = f.history();
    const receipt = f.run({ type: 'connector.move', expected: original.versionId, payload: { id: original.id, dx: 500, dy: -200 } });
    expect(receipt).toMatchObject({ revision: before.project.revision, changedIds: [] });
    expect(f.state()).toEqual(before);
    expect(f.history()).toEqual(historyBefore);
  } finally { f.close(); }
});

it('普通连线重接拒绝同对象自连且不留下半写', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.bound(0), f.bound(1, 'left'));
    const before = f.state(), historyBefore = f.history();
    expect(() => f.run({ type: 'connector.reconnect', expected: original.versionId, payload: { id: original.id, endpoint: 'start', value: f.bound(1, 'top') } }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
    expect(f.state()).toEqual(before);
    expect(f.history()).toEqual(historyBefore);
  } finally { f.close(); }
});

it('普通连线旧版本写入拒绝且失败命令编号可重试', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.free(0, 0), f.free(10, 20));
    f.run({ type: 'connector.path', expected: original.versionId, payload: { id: original.id, path: 'elbow' } });
    const current = f.state().connectors![0]!;
    const before = f.state(), historyBefore = f.history();
    const command = { commandId: randomUUID(), type: 'connector.move', expected: original.versionId, payload: { id: original.id, dx: 5, dy: 5 } };
    expect(() => f.run(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(f.state()).toEqual(before);
    expect(f.history()).toEqual(historyBefore);
    const corrected = { ...command, expected: current.versionId };
    const receipt = f.run(corrected);
    const moved = f.state();
    expect(moved.connectors![0]).toMatchObject({ path: 'elbow', start: { kind: 'free', point: { x: 5, y: 5 } }, end: { kind: 'free', point: { x: 15, y: 25 } } });
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
    expect(f.run(corrected)).toEqual(receipt);
    expect(f.state()).toEqual(moved);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
  } finally { f.close(); }
});

it('普通连线无变化重接路径或零位移不新增历史', () => {
  const f = connectorMap();
  try {
    const original = f.line(f.bound(0), f.free(100, 50));
    const before = f.state(), historyBefore = f.history();
    const commands = [
      { type: 'connector.reconnect', payload: { id: original.id, endpoint: 'start', value: f.bound(0) } },
      { type: 'connector.path', payload: { id: original.id, path: 'straight' } },
      { type: 'connector.move', payload: { id: original.id, dx: 0, dy: 0 } },
    ];
    for (const command of commands) {
      const receipt = f.run({ ...command, expected: original.versionId });
      expect(receipt).toMatchObject({ revision: before.project.revision, changedIds: [] });
      expect(f.state()).toEqual(before);
      expect(f.history()).toEqual(historyBefore);
    }
  } finally { f.close(); }
});
