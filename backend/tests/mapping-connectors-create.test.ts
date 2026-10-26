import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { imageFixture } from './canvas-image-fixture.js';
import { expect, it } from 'vitest';

it('两端自由普通连线默认直线并以一步历史持久恢复', () => {
  const f = lifecycleFixture({}, '普通连线');
  const { run, state, history, reopen } = f;
  try {
    const before = state();
    const historyBefore = history();
    const receipt = run({ type: 'connector.create', expected: null, payload: {
      id: 'free-line',
      start: { kind: 'free', point: { x: -40.5, y: 20.25 } },
      end: { kind: 'free', point: { x: 160.5, y: 120.25 } },
    } });
    const createdState = state();
    expect(createdState.connectors).toHaveLength(1);
    const created = createdState.connectors![0]!;
    expect(created).toMatchObject({ id: 'free-line', kind: 'connector', path: 'straight',
      start: { kind: 'free', point: { x: -40.5, y: 20.25 } },
      end: { kind: 'free', point: { x: 160.5, y: 120.25 } },
    });
    expect(created.versionId).toEqual(expect.any(String));
    expect(receipt).toMatchObject({ revision: before.project.revision + 1, changedIds: ['free-line'] });
    expect(history().undo).toHaveLength(historyBefore.undo.length + 1);
    expect(history().undo.at(-1)).toMatchObject({ id: receipt.commandId, label: 'connector.create', target: { id: 'free-line' } });
    expect([createdState.cards, createdState.texts, createdState.shapes, createdState.images, createdState.strokes]).toEqual([[], [], [], [], []]);
    const createdHistory = history();
    reopen();
    expect(state()).toEqual(createdState);
    expect(history()).toEqual(createdHistory);

    const undone = run({ type: 'history.undo', expected: state().project.revision, payload: {} });
    expect(undone.deletedIds).toEqual(['free-line']);
    expect(state().connectors).toEqual([]);
    expect(history().undo).toEqual(historyBefore.undo);
    expect(history().redo).toHaveLength(1);
    const undoneState = state();
    reopen();
    expect(state()).toEqual(undoneState);
    run({ type: 'history.redo', expected: state().project.revision, payload: {} });
    const restored = state().connectors![0]!;
    expect(restored).toEqual({ ...created, versionId: expect.any(String) });
    expect(restored.versionId).not.toBe(created.versionId);
    expect(history().undo).toHaveLength(historyBefore.undo.length + 1);
    expect(history().redo).toEqual([]);
    const restoredState = state();
    reopen();
    expect(state()).toEqual(restoredState);
  } finally { f.close(); }
});

it('卡片画布项可绑定普通连线的固定边', () => {
  const f = lifecycleFixture({}, '卡片端点');
  const { run, state } = f;
  try {
    run({ type: 'thought.create', expected: null, payload: { id: 'card', title: '原卡', text: '保留正文', x: 10, y: 20 } });
    const card = state().cards[0]!;
    const sides = ['top', 'right', 'bottom', 'left'] as const;
    for (const side of sides) run({ type: 'connector.create', expected: null, payload: {
      id: 'line-' + side, start: { kind: 'bound', itemId: card.item.id, side },
      end: { kind: 'free', point: { x: -200, y: 400 } },
    } });
    const bound = state();
    expect(bound.connectors!.map(line => line.start)).toEqual(sides.map(side => ({ kind: 'bound', itemId: card.item.id, side })));
    expect(bound.connectors!.map(line => line.end)).toEqual(sides.map(() => ({ kind: 'free', point: { x: -200, y: 400 } })));
    expect(bound.cards).toEqual([card]);
    f.reopen();
    expect(state()).toEqual(bound);
  } finally { f.close(); }
});

it('基础形状画布项可绑定普通连线端点', () => {
  const f = lifecycleFixture({}, '形状端点');
  const { run, state } = f;
  try {
    run({ type: 'shape.create', expected: null, payload: { id: 'shape', content: { shapeType: 'triangle', shortText: '原形状' }, pose: { x: 30, y: -80, width: 140, height: 120 } } });
    const shape = state().shapes![0]!;
    run({ type: 'connector.create', expected: null, payload: { id: 'shape-line',
      start: { kind: 'free', point: { x: -100, y: 200 } }, end: { kind: 'bound', itemId: shape.item.id, side: 'left' },
    } });
    expect(state().connectors![0]).toMatchObject({ id: 'shape-line', path: 'straight', start: { kind: 'free', point: { x: -100, y: 200 } }, end: { kind: 'bound', itemId: shape.item.id, side: 'left' } });
    expect(state().shapes).toEqual([shape]);
    expect(state().cards).toEqual([]);
  } finally { f.close(); }
});

it('独立文字画布项可绑定普通连线端点', () => {
  const f = lifecycleFixture({}, '文字端点');
  const { run, state } = f;
  try {
    run({ type: 'text.create', expected: null, payload: { id: 'text', content: { runs: [{ text: '原独立文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 50, y: 80, width: 180, height: 60 } } });
    const text = state().texts![0]!;
    run({ type: 'connector.create', expected: null, payload: { id: 'text-line',
      start: { kind: 'bound', itemId: text.item.id, side: 'bottom' }, end: { kind: 'free', point: { x: 500, y: 100 } },
    } });
    expect(state().connectors![0]).toMatchObject({ id: 'text-line', path: 'straight', start: { kind: 'bound', itemId: text.item.id, side: 'bottom' }, end: { kind: 'free', point: { x: 500, y: 100 } } });
    expect(state().texts).toEqual([text]);
    expect(state().cards).toEqual([]);
  } finally { f.close(); }
});

it('独立图片画布项可绑定普通连线端点', () => {
  const fixture = imageFixture();
  try {
    fixture.create();
    const image = fixture.read().images![0]!;
    fixture.run({ type: 'connector.create', expected: null, payload: { id: 'image-line',
      start: { kind: 'bound', itemId: image.item.id, side: 'top' }, end: { kind: 'free', point: { x: 90, y: 40 } },
    } });
    expect(fixture.read().connectors![0]).toMatchObject({ id: 'image-line', path: 'straight',
      start: { kind: 'bound', itemId: image.item.id, side: 'top' }, end: { kind: 'free', point: { x: 90, y: 40 } },
    });
    expect(fixture.read().images).toEqual([image]);
    expect(fixture.read().cards).toEqual([]);
  } finally { fixture.close(); }
});
