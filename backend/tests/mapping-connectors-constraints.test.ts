import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { expect, it } from 'vitest';

function connectorMap() {
  const f = lifecycleFixture({}, '普通连线约束');
  const { run, state } = f;
  const card = (id: string) => {
    run({ type: 'thought.create', expected: null, payload: { id, title: id, text: '', x: 0, y: 0 } });
    return state().cards.find(value => value.id === id)!;
  };
  return Object.assign(f, { card });
}

it('普通连线拒绝两端绑定同一对象', () => {
  const f = connectorMap();
  try {
    const card = f.card('card');
    const before = f.state(), historyBefore = f.history();
    expect(() => f.run({ type: 'connector.create', expected: null, payload: { id: 'self-line',
      start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' },
    } })).toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
    expect(f.state()).toEqual(before);
    expect(f.history()).toEqual(historyBefore);
  } finally { f.close(); }
});

it('普通连线拒绝绑定其他项目的画布项', () => {
  const f = connectorMap();
  try {
    const local = f.card('local');
    f.run({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '其他项目' } });
    f.run({ projectId: 'q', type: 'thought.create', expected: null, payload: { id: 'foreign', title: '外部卡', text: '', x: 0, y: 0 } });
    const foreignState = f.mapping.read({ type: 'project', projectId: 'q' }, f.human);
    const foreign = foreignState.cards[0]!;
    const before = f.state(), historyBefore = f.history();
    expect(() => f.run({ type: 'connector.create', expected: null, payload: { id: 'cross-line',
      start: { kind: 'bound', itemId: foreign.item.id, side: 'right' }, end: { kind: 'bound', itemId: local.item.id, side: 'left' },
    } })).toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
    expect(f.state()).toEqual(before);
    expect(f.history()).toEqual(historyBefore);
    expect(f.mapping.read({ type: 'project', projectId: 'q' }, f.human)).toEqual(foreignState);
  } finally { f.close(); }
});

it('普通连线拒绝绑定已删除或不存在的画布项', () => {
  const f = connectorMap();
  try {
    const deleted = f.card('deleted');
    f.run({ type: 'thought.delete', expected: { thought: deleted.versionId, body: deleted.body.versionId, pose: deleted.item.versionId, appearance: deleted.appearance?.versionId ?? null, cardTags: deleted.cardTags?.versionId ?? null }, payload: { id: deleted.id } });
    const before = f.state(), historyBefore = f.history();
    for (const itemId of [deleted.item.id, 'never-created-item']) {
      expect(() => f.run({ type: 'connector.create', expected: null, payload: { id: 'invalid-' + itemId,
        start: { kind: 'bound', itemId, side: 'right' }, end: { kind: 'free', point: { x: 300, y: 40 } },
      } })).toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
      expect(f.state()).toEqual(before);
      expect(f.history()).toEqual(historyBefore);
    }
  } finally { f.close(); }
});

it('普通连线拒绝绑定笔迹画布项', () => {
  const f = connectorMap();
  try {
    for (const penKind of ['pen', 'highlighter']) f.run({ type: 'stroke.create', expected: null, payload: { id: penKind,
      content: { penKind, path: [{ x: 0, y: 0 }, { x: 20, y: 10 }], color: '#654321', width: 2, opacity: penKind === 'pen' ? 1 : 0.35 },
      pose: { x: 0, y: 0, width: 20, height: 10 },
    } });
    const before = f.state(), historyBefore = f.history();
    for (const stroke of before.strokes!) {
      expect(() => f.run({ type: 'connector.create', expected: null, payload: { id: 'stroke-line-' + stroke.id,
        start: { kind: 'bound', itemId: stroke.item.id, side: 'right' }, end: { kind: 'free', point: { x: 300, y: 40 } },
      } })).toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
      expect(f.state()).toEqual(before);
      expect(f.history()).toEqual(historyBefore);
    }
  } finally { f.close(); }
});

it('普通连线拒绝绑定另一条普通连线', () => {
  const f = connectorMap();
  try {
    f.run({ type: 'connector.create', expected: null, payload: { id: 'existing-line',
      start: { kind: 'free', point: { x: 0, y: 0 } }, end: { kind: 'free', point: { x: 100, y: 50 } },
    } });
    const before = f.state(), historyBefore = f.history();
    expect(() => f.run({ type: 'connector.create', expected: null, payload: { id: 'line-to-line',
      start: { kind: 'bound', itemId: before.connectors![0]!.id, side: 'right' }, end: { kind: 'free', point: { x: 300, y: 40 } },
    } })).toThrowError(expect.objectContaining({ code: 'INVALID_ENDPOINT' }));
    expect(f.state()).toEqual(before);
    expect(f.history()).toEqual(historyBefore);
  } finally { f.close(); }
});

it('同一对对象允许重复普通连线', () => {
  const f = connectorMap();
  try {
    const a = f.card('a'), b = f.card('b');
    const before = f.state(), historyBefore = f.history();
    for (const id of ['first-line', 'second-line']) f.run({ type: 'connector.create', expected: null, payload: { id,
      start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' },
    } });
    const lines = f.state().connectors!;
    expect(lines.map(line => line.id)).toEqual(['first-line', 'second-line']);
    expect(lines[0]!.start).toEqual({ kind: 'bound', itemId: a.item.id, side: 'right' });
    expect(lines[1]!.start).toEqual(lines[0]!.start);
    expect(lines[0]!.end).toEqual({ kind: 'bound', itemId: b.item.id, side: 'left' });
    expect(lines[1]!.end).toEqual(lines[0]!.end);
    expect(f.state().cards).toEqual(before.cards);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 2);
  } finally { f.close(); }
});

it('同一对对象允许反向普通连线', () => {
  const f = connectorMap();
  try {
    const a = f.card('a'), b = f.card('b');
    const before = f.state();
    f.run({ type: 'connector.create', expected: null, payload: { id: 'a-to-b', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
    f.run({ type: 'connector.create', expected: null, payload: { id: 'b-to-a', start: { kind: 'bound', itemId: b.item.id, side: 'left' }, end: { kind: 'bound', itemId: a.item.id, side: 'right' } } });
    const lines = f.state().connectors!;
    expect(lines.map(line => line.id)).toEqual(['a-to-b', 'b-to-a']);
    expect(lines[0]!.start).toEqual({ kind: 'bound', itemId: a.item.id, side: 'right' });
    expect(lines[0]!.end).toEqual({ kind: 'bound', itemId: b.item.id, side: 'left' });
    expect(lines[1]!.start).toEqual({ kind: 'bound', itemId: b.item.id, side: 'left' });
    expect(lines[1]!.end).toEqual({ kind: 'bound', itemId: a.item.id, side: 'right' });
    expect(f.state().cards).toEqual(before.cards);
  } finally { f.close(); }
});

it('三个对象允许普通连线形成几何闭环', () => {
  const f = connectorMap();
  try {
    const a = f.card('a'), b = f.card('b'), c = f.card('c');
    const before = f.state(), historyBefore = f.history();
    f.run({ type: 'connector.create', expected: null, payload: { id: 'a-b', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
    f.run({ type: 'connector.create', expected: null, payload: { id: 'b-c', start: { kind: 'bound', itemId: b.item.id, side: 'bottom' }, end: { kind: 'bound', itemId: c.item.id, side: 'top' } } });
    f.run({ type: 'connector.create', expected: null, payload: { id: 'c-a', start: { kind: 'bound', itemId: c.item.id, side: 'left' }, end: { kind: 'bound', itemId: a.item.id, side: 'bottom' } } });
    expect(f.state().connectors!.map(line => [line.id, line.start, line.end])).toEqual([
      ['a-b', { kind: 'bound', itemId: a.item.id, side: 'right' }, { kind: 'bound', itemId: b.item.id, side: 'left' }],
      ['b-c', { kind: 'bound', itemId: b.item.id, side: 'bottom' }, { kind: 'bound', itemId: c.item.id, side: 'top' }],
      ['c-a', { kind: 'bound', itemId: c.item.id, side: 'left' }, { kind: 'bound', itemId: a.item.id, side: 'bottom' }],
    ]);
    expect(f.state().cards).toEqual(before.cards);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 3);
  } finally { f.close(); }
});
