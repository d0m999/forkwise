import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';

it('普通连线默认端标和线条外观随创建版本持久重开', () => {
  const f = lifecycleFixture({}, '连线样式');
  try {
    const line = f.connector('line', f.free(20, 30), f.free(220, 130));
    expect(line).toMatchObject({
      style: { startMarker: 'none', endMarker: 'open-arrow', color: '#626e81', width: 4, dash: 'solid' },
    });
    const version = f.mapping.read({ type: 'version', projectId: 'p', domain: 'connector', id: line.id, versionId: line.versionId }, f.human);
    expect(version).toEqual(line);
    f.reopen();
    expect(f.state().connectors).toEqual([line]);
    expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'connector', id: line.id, versionId: line.versionId }, f.human)).toEqual(line);
  } finally { f.close(); }
});

it('连线样式省略的字段不会清空默认值或制造历史', () => {
  const f = lifecycleFixture({}, '样式无变化');
  try {
    const line = f.connector('line', f.free(20, 30), f.free(220, 130));
    const state = f.state(), history = f.history();
    const receipt = f.run({ type: 'connector.style', expected: line.versionId,
      payload: { id: line.id, style: { startMarker: undefined, color: undefined, width: undefined } } });
    expect(f.state()).toEqual(state);
    expect(f.history()).toEqual(history);
    expect(receipt).toMatchObject({ revision: state.project.revision, changedIds: [] });
  } finally { f.close(); }
});

it('多选普通连线逐条交换自己的端标并以一次撤销恢复', () => {
  const f = lifecycleFixture({}, '逐线反向');
  try {
    const a = f.connector('a', f.free(0, 0), f.free(100, 50));
    const b = f.connector('b', f.free(10, 80), f.free(80, 100));
    f.run({ type: 'connector.style', expected: b.versionId,
      payload: { id: b.id, style: { startMarker: 'dot', endMarker: 'triangle', color: '#abcdef', width: 2, dash: 'dashed' } } });
    const originals = f.state().connectors!;
    const history = f.history();
    const command = { commandId: 'reverse-pair', type: 'connector.reverse',
      expected: { a: a.versionId, b: originals[1]!.versionId }, payload: { ids: ['a', 'b'] } };
    const receipt = f.run(command);
    const changed = f.state().connectors!;
    expect(changed).toEqual([
      { ...originals[0], versionId: expect.any(String), style: { startMarker: 'open-arrow', endMarker: 'none', color: '#626e81', width: 4, dash: 'solid' } },
      { ...originals[1], versionId: expect.any(String), style: { startMarker: 'triangle', endMarker: 'dot', color: '#abcdef', width: 2, dash: 'dashed' } },
    ]);
    expect(receipt.changedIds).toEqual(['a', 'b']);
    expect(f.history().undo).toHaveLength(history.undo.length + 1);
    expect(f.run(command)).toEqual(receipt);
    expect(f.state().connectors).toEqual(changed);
    f.reopen();
    expect(f.state().connectors).toEqual(changed);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors).toEqual(originals.map(value => ({ ...value, versionId: expect.any(String) })));
  } finally { f.close(); }
});

it('普通连线独立修改端标和外观只产生一个可撤销动作', () => {
  const f = lifecycleFixture({}, '连线样式');
  try {
    const card = f.card('card');
    const original = f.connector('line', f.bound(card.item.id), f.free(220, 130));
    const history = f.history();
    const receipt = f.run({ type: 'connector.style', expected: original.versionId,
      payload: { id: original.id, style: { startMarker: 'diamond', color: '#ab1234', width: 6, dash: 'dashed' } } });
    const changed = f.state().connectors![0]!;
    expect(changed).toEqual({ ...original, versionId: expect.any(String),
      style: { startMarker: 'diamond', endMarker: 'open-arrow', color: '#ab1234', width: 6, dash: 'dashed' } });
    expect(changed.versionId).not.toBe(original.versionId);
    expect(receipt.connectorVersions).toEqual({ line: changed.versionId });
    expect(f.state().cards).toEqual([card]);
    expect(f.history().undo).toHaveLength(history.undo.length + 1);
    f.reopen();
    expect(f.state().connectors).toEqual([changed]);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors).toEqual([{ ...original, versionId: expect.any(String) }]);
    f.run({ type: 'history.redo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors).toEqual([{ ...changed, versionId: expect.any(String) }]);
  } finally { f.close(); }
});
