import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';

it('批量反向中任一连线版本或范围失效时整批拒绝', () => {
  const f = lifecycleFixture({}, '反向版本保护');
  try {
    const a = f.connector('a', f.free(0, 0), f.free(100, 50));
    const b = f.connector('b', f.free(10, 80), f.free(80, 100));
    f.run({ type: 'connector.path', expected: b.versionId, payload: { id: b.id, path: 'curve' } });
    const current = f.state(), history = f.history();
    for (const expected of [{ a: a.versionId, b: b.versionId }, { a: a.versionId },
      { a: a.versionId, b: current.connectors![1]!.versionId, other: 'unexpected' }]) {
      expect(() => f.run({ type: 'connector.reverse', expected, payload: { ids: ['a', 'b'] } }))
        .toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
      expect(f.state()).toEqual(current);
      expect(f.history()).toEqual(history);
    }
  } finally { f.close(); }
});

it('五种连线端标可独立设置且非法外观不会部分写入', () => {
  const f = lifecycleFixture({}, '端标与样式校验');
  try {
    let line = f.connector('line', f.free(0, 0), f.free(100, 50));
    for (const marker of ['none', 'open-arrow', 'triangle', 'dot', 'diamond']) {
      f.run({ type: 'connector.style', expected: line.versionId, payload: { id: line.id, style: { startMarker: marker } } });
      line = f.state().connectors![0]!;
      expect(line.style).toMatchObject({ startMarker: marker, endMarker: 'open-arrow' });
    }
    for (const marker of ['none', 'open-arrow', 'triangle', 'dot', 'diamond']) {
      f.run({ type: 'connector.style', expected: line.versionId, payload: { id: line.id, style: { endMarker: marker } } });
      line = f.state().connectors![0]!;
      expect(line.style).toMatchObject({ startMarker: 'diamond', endMarker: marker });
    }
    const current = f.state(), history = f.history();
    for (const style of [{ startMarker: 'unsupported' }, { color: 'url(https://invalid.test)' }, { width: 0 }, { width: Infinity }, { dash: 'dotted' }]) {
      expect(() => f.run({ type: 'connector.style', expected: line.versionId, payload: { id: line.id, style } })).toThrow();
      expect(f.state()).toEqual(current); expect(f.history()).toEqual(history);
    }
    const noop = f.run({ type: 'connector.reverse', expected: { line: line.versionId }, payload: { ids: [line.id] } });
    expect(noop.changedIds).toEqual([]);
    expect(f.state()).toEqual(current); expect(f.history()).toEqual(history);
  } finally { f.close(); }
});
