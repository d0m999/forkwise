import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';

it('普通连线保存一个多行纯文标签及整段样式并持久重开', () => {
  const f = lifecycleFixture({}, '连线文字');
  try {
    const original = f.connector('line', f.free(0, 0), f.free(200, 120));
    const label = { text: '第一行\n第二行 <b>保持字面</b>', position: 0.35, fontSize: 16, color: '#403b36', bold: true };
    const history = f.history();
    const receipt = f.run({ type: 'connector.label', expected: original.versionId, payload: { id: original.id, label } });
    const changed = f.state().connectors![0]!;
    expect(changed).toEqual({ ...original, label, versionId: expect.any(String) });
    expect(changed.versionId).not.toBe(original.versionId);
    expect(receipt.connectorVersions).toEqual({ line: changed.versionId });
    expect(f.history().undo).toHaveLength(history.undo.length + 1);
    f.reopen();
    expect(f.state().connectors).toEqual([changed]);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors).toEqual([{ ...original, versionId: expect.any(String) }]);
  } finally { f.close(); }
});

it('同一连线标签编辑组的多次保存合并为一次撤销且被其他动作截断', () => {
  const f = lifecycleFixture({}, '标签连续编辑');
  try {
    let line = f.connector('line', f.free(0, 0), f.free(200, 120));
    const original = line, history = f.history();
    const base = { position: 0.5, fontSize: 16, color: '#403b36', bold: false };
    for (const text of ['第', '第一行\n第二行']) {
      f.run({ type: 'connector.label', editGroup: 'session:editing', expected: line.versionId,
        payload: { id: line.id, label: { ...base, text } } });
      line = f.state().connectors![0]!;
    }
    expect(f.history().undo).toHaveLength(history.undo.length + 1);
    f.run({ type: 'connector.path', expected: line.versionId, payload: { id: line.id, path: 'curve' } });
    line = f.state().connectors![0]!;
    f.run({ type: 'connector.label', editGroup: 'session:editing', expected: line.versionId,
      payload: { id: line.id, label: { ...base, text: '第三次输入' } } });
    expect(f.history().undo).toHaveLength(history.undo.length + 3);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors![0]!.label?.text).toBe('第一行\n第二行');
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors).toEqual([{ ...original, versionId: expect.any(String) }]);
  } finally { f.close(); }
});

it('清空连线标签仅移除标签并可一步撤销恢复', () => {
  const f = lifecycleFixture({}, '清空连线文字');
  try {
    let line = f.connector('line', f.free(0, 0), f.free(200, 120));
    const label = { text: '第一行\n第二行', position: 0.8, fontSize: 20, color: '#403b36', bold: false };
    f.run({ type: 'connector.label', expected: line.versionId, payload: { id: line.id, label } });
    line = f.state().connectors![0]!;
    const history = f.history();
    f.run({ type: 'connector.label', expected: line.versionId, payload: { id: line.id, label: { ...label, text: '' } } });
    expect(f.state().connectors).toEqual([{ ...line, label: null, versionId: expect.any(String) }]);
    expect(f.history().undo).toHaveLength(history.undo.length + 1);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors).toEqual([{ ...line, versionId: expect.any(String) }]);
  } finally { f.close(); }
});
