import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

it('删除普通连线保留端点对象且一次撤销重开恢复线身份', () => {
  const f = lifecycleFixture({}, '删线保留对象');
  const { run, state, history, reopen } = f;
  try {
    for (const id of ['a', 'b']) run({ type: 'thought.create', expected: null, payload: { id, title: id, text: '保留原正文', x: 0, y: 0 } });
    const cards = state().cards;
    run({ type: 'connector.create', expected: null, payload: { id: 'bound-line',
      start: { kind: 'bound', itemId: cards[0]!.item.id, side: 'right' }, end: { kind: 'bound', itemId: cards[1]!.item.id, side: 'left' },
    } });
    const original = state().connectors![0]!;
    const historyBefore = history();
    const command = { commandId: randomUUID(), type: 'connector.delete', expected: original.versionId, payload: { id: original.id } };
    const receipt = run(command);
    expect(receipt).toMatchObject({ changedIds: ['bound-line'], deletedIds: ['bound-line'] });
    expect(state().connectors).toEqual([]);
    expect(state().cards).toEqual(cards);
    expect(history().undo).toHaveLength(historyBefore.undo.length + 1);
    expect(history().undo.at(-1)).toMatchObject({ label: 'connector.delete', target: { id: 'bound-line' } });
    const deletedState = state(), deletedHistory = history();
    reopen();
    expect(state()).toEqual(deletedState);
    expect(history()).toEqual(deletedHistory);
    expect(run(command)).toEqual(receipt);
    expect(state()).toEqual(deletedState);
    run({ type: 'history.undo', expected: state().project.revision, payload: {} });
    const restored = state().connectors![0]!;
    expect(restored).toEqual({ ...original, versionId: expect.any(String) });
    expect(restored.versionId).not.toBe(original.versionId);
    expect(state().cards).toEqual(cards);
    expect(history().undo).toEqual(historyBefore.undo);
    run({ type: 'history.redo', expected: state().project.revision, payload: {} });
    expect(state().connectors).toEqual([]);
    expect(state().cards).toEqual(cards);
    const finalState = state();
    reopen();
    expect(state()).toEqual(finalState);
  } finally { f.close(); }
});

it('删除卡片同一步删除关联普通连线并恢复原身份', () => {
  const f = lifecycleFixture();
  try {
    const host = f.card('host'), other = f.card('other'), third = f.card('third');
    const first = f.connector('first', f.bound(host.item.id), f.bound(other.item.id, 'left'));
    const second = f.connector('second', f.free(-100, 40), f.bound(host.item.id, 'top'));
    const unrelated = f.connector('unrelated', f.bound(other.item.id), f.bound(third.item.id));
    const historyBefore = f.history();
    const command = { commandId: randomUUID(), type: 'thought.delete', expected: { thought: host.versionId, body: host.body.versionId, pose: host.item.versionId, appearance: host.appearance?.versionId ?? null, cardTags: host.cardTags?.versionId ?? null, connectors: { first: first.versionId, second: second.versionId } }, payload: { id: host.id } };
    const receipt = f.run(command);
    const deletedIds = [host.id, host.body.id, host.item.id, ...(host.appearance ? [host.appearance.id] : []), ...(host.cardTags ? [host.cardTags.id] : []), 'first', 'second'].sort();
    expect([...receipt.changedIds].sort()).toEqual(deletedIds);
    expect([...receipt.deletedIds!].sort()).toEqual(deletedIds);
    expect(f.state().cards).toEqual([other, third]);
    expect(f.state().connectors).toEqual([unrelated]);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
    expect(f.history().undo.at(-1)).toMatchObject({ id: command.commandId, label: 'thought.delete', target: { id: host.id } });
    const deleted = f.state(); f.reopen(); expect(f.state()).toEqual(deleted);
    const undo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: { actionId: command.commandId } });
    const restored = f.state().cards.find(value => value.id === host.id)!;
    expect(restored).toMatchObject({ id: host.id, title: host.title, body: { id: host.body.id, blocks: host.body.blocks }, item: { id: host.item.id, pose: host.item.pose } });
    expect(restored.versionId).not.toBe(host.versionId);
    expect(f.state().connectors).toEqual([{ ...first, versionId: expect.any(String) }, { ...second, versionId: expect.any(String) }, unrelated]);
    expect(f.state().connectors![0]!.versionId).not.toBe(first.versionId);
    expect(undo.deletedIds).toEqual([]);
    expect(undo.historyTarget!.id).toBe(host.id);
    const redo = f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
    expect([...redo.deletedIds!].sort()).toEqual(deletedIds);
    expect(f.state().cards).toEqual([other, third]);
    expect(f.state().connectors).toEqual([unrelated]);
    const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
  } finally { f.close(); }
});

it('删除基础形状同一步删除关联普通连线并恢复原身份', () => {
  const f = lifecycleFixture();
  try {
    const other = f.card('other');
    f.run({ type: 'shape.create', expected: null, payload: { id: 'shape', content: { shapeType: 'ellipse', shortText: '原形状' }, pose: { x: 40, y: 80, width: 160, height: 100 } } });
    const host = f.state().shapes![0]!;
    const line = f.connector('shape-line', f.bound(host.item.id, 'top'), f.bound(other.item.id));
    const historyBefore = f.history();
    const command = { commandId: randomUUID(), type: 'shape.delete', expected: { shape: host.versionId, pose: host.item.versionId, connectors: { 'shape-line': line.versionId } }, payload: { id: host.id } };
    const receipt = f.run(command), ids = [host.id, host.item.id, line.id].sort();
    expect([...receipt.changedIds].sort()).toEqual(ids); expect([...receipt.deletedIds!].sort()).toEqual(ids);
    expect(f.state().shapes).toEqual([]); expect(f.state().connectors).toEqual([]); expect(f.state().cards).toEqual([other]);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
    expect(f.history().undo.at(-1)!.target.id).toBe(host.id);
    f.reopen();
    const undo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: { actionId: command.commandId } });
    expect(f.state().shapes![0]).toMatchObject({ id: host.id, content: host.content, item: { id: host.item.id, pose: host.item.pose } });
    expect(f.state().shapes![0]!.versionId).not.toBe(host.versionId);
    expect(f.state().connectors).toEqual([{ ...line, versionId: expect.any(String) }]);
    expect(undo.historyTarget!.id).toBe(host.id); expect(undo.deletedIds).toEqual([]);
    const redo = f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
    expect([...redo.deletedIds!].sort()).toEqual(ids);
    expect(f.state().shapes).toEqual([]); expect(f.state().connectors).toEqual([]); expect(f.state().cards).toEqual([other]);
    const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
  } finally { f.close(); }
});

it('删除独立文字同一步删除关联普通连线并恢复原身份', () => {
  const f = lifecycleFixture();
  try {
    const other = f.card('other');
    f.run({ type: 'text.create', expected: null, payload: { id: 'text', content: { runs: [{ text: '原文字', bold: true }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 30, y: 40, width: 180, height: 60 } } });
    const host = f.state().texts![0]!;
    const line = f.connector('text-line', f.bound(other.item.id), f.bound(host.item.id, 'left'));
    const historyBefore = f.history();
    const command = { commandId: randomUUID(), type: 'text.delete', expected: { text: host.versionId, pose: host.item.versionId, connectors: { 'text-line': line.versionId } }, payload: { id: host.id } };
    const receipt = f.run(command), ids = [host.id, host.item.id, line.id].sort();
    expect([...receipt.changedIds].sort()).toEqual(ids); expect([...receipt.deletedIds!].sort()).toEqual(ids);
    expect(f.state().texts).toEqual([]); expect(f.state().connectors).toEqual([]); expect(f.state().cards).toEqual([other]);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1); expect(f.history().undo.at(-1)!.target.id).toBe(host.id);
    f.reopen();
    const undo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: { actionId: command.commandId } });
    expect(f.state().texts![0]).toMatchObject({ id: host.id, content: host.content, item: { id: host.item.id, pose: host.item.pose } });
    expect(f.state().texts![0]!.versionId).not.toBe(host.versionId); expect(f.state().texts![0]!.item.versionId).not.toBe(host.item.versionId);
    expect(f.state().connectors).toEqual([{ ...line, versionId: expect.any(String) }]);
    expect([...undo.changedIds].sort()).toEqual(ids); expect(undo.historyTarget!.id).toBe(host.id); expect(undo.deletedIds).toEqual([]);
    const redo = f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
    expect([...redo.deletedIds!].sort()).toEqual(ids);
    expect(f.state().texts).toEqual([]); expect(f.state().connectors).toEqual([]); expect(f.state().cards).toEqual([other]);
    const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
  } finally { f.close(); }
});

it('删除独立图片同一步删除关联普通连线并恢复原身份', () => {
  const f = lifecycleFixture();
  try {
    const other = f.card('other');
    const base64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="green"/></svg>').toString('base64');
    f.run({ type: 'asset.save', expected: null, payload: { id: 'source', name: '原图.svg', mime: 'image/svg+xml', base64 } });
    f.run({ type: 'image.create', expected: null, payload: { id: 'image', content: { assetId: 'source', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 60, y: 90, width: 160, height: 240, rotation: 90 } } });
    const host = f.state().images![0]!, originalAsset = f.asset('source');
    const line = f.connector('image-line', f.bound(host.item.id, 'bottom'), f.bound(other.item.id));
    const historyBefore = f.history();
    const command = { commandId: randomUUID(), type: 'image.delete', expected: { image: host.versionId, pose: host.item.versionId, connectors: { 'image-line': line.versionId } }, payload: { id: host.id } };
    const receipt = f.run(command), ids = [host.id, host.item.id, line.id].sort();
    expect([...receipt.changedIds].sort()).toEqual(ids); expect([...receipt.deletedIds!].sort()).toEqual(ids);
    expect(f.state().images).toEqual([]); expect(f.state().connectors).toEqual([]); expect(f.state().cards).toEqual([other]);
    expect(f.asset('source')).toEqual(originalAsset); expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1); expect(f.history().undo.at(-1)!.target.id).toBe(host.id);
    f.reopen();
    const undo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: { actionId: command.commandId } });
    expect(f.state().images![0]).toMatchObject({ id: host.id, content: host.content, item: { id: host.item.id, pose: host.item.pose } });
    expect(f.state().images![0]!.versionId).not.toBe(host.versionId);
    expect(f.state().connectors).toEqual([{ ...line, versionId: expect.any(String) }]);
    expect(undo.historyTarget!.id).toBe(host.id); expect(undo.deletedIds).toEqual([]);
    const redo = f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
    expect([...redo.deletedIds!].sort()).toEqual(ids);
    expect(f.state().images).toEqual([]); expect(f.state().connectors).toEqual([]); expect(f.state().cards).toEqual([other]); expect(f.asset('source')).toEqual(originalAsset);
    const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
  } finally { f.close(); }
});


it('无关联线的宿主删除保持既有历史目标和空闭包语义', () => {
  for (const includeEmpty of [false, true]) {
    const f = lifecycleFixture();
    try {
      const card = f.card('card');
      f.run({ type: 'shape.create', expected: null, payload: { id: 'shape', content: { shapeType: 'rectangle', shortText: '' }, pose: { x: 0, y: 0, width: 100, height: 80 } } });
      f.run({ type: 'text.create', expected: null, payload: { id: 'text', content: { runs: [{ text: '保留文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 0, y: 0, width: 180, height: 60 } } });
      const base64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>').toString('base64');
      f.run({ type: 'asset.save', expected: null, payload: { id: 'source', name: '图.svg', mime: 'image/svg+xml', base64 } });
      f.run({ type: 'image.create', expected: null, payload: { id: 'image', content: { assetId: 'source', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 0, y: 0, width: 100, height: 100, rotation: 0 } } });
      const state = f.state();
      const cases = [
        { type: 'thought.delete', id: card.id, expected: { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null } },
        { type: 'shape.delete', id: state.shapes![0]!.id, expected: { shape: state.shapes![0]!.versionId, pose: state.shapes![0]!.item.versionId } },
        { type: 'text.delete', id: state.texts![0]!.id, expected: { text: state.texts![0]!.versionId, pose: state.texts![0]!.item.versionId } },
        { type: 'image.delete', id: state.images![0]!.id, expected: { image: state.images![0]!.versionId, pose: state.images![0]!.item.versionId } },
      ];
      for (const item of cases) {
        const before = f.state(), historyBefore = f.history();
        const command = { commandId: randomUUID(), type: item.type, expected: { ...item.expected, ...(includeEmpty ? { connectors: {} } : {}) }, payload: { id: item.id } };
        const receipt = f.run(command);
        expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
        expect(f.history().undo.at(-1)!.target.id).toBe(item.id);
        expect(receipt.deletedIds).not.toContain(undefined); expect(f.state().connectors).toEqual([]);
        expect(f.run(command)).toEqual(receipt);
        expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
        const undo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: { actionId: command.commandId } });
        expect(undo.historyTarget!.id).toBe(item.id); expect(undo.deletedIds).toEqual([]);
        const field = item.type === 'thought.delete' ? 'cards' : item.type === 'shape.delete' ? 'shapes' : item.type === 'text.delete' ? 'texts' : 'images';
        expect(f.state()[field]!.map(value => value.id)).toEqual(before[field]!.map(value => value.id));
      }
    } finally { f.close(); }
  }
});
