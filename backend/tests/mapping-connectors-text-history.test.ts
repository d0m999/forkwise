import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';

it('独立文字连续编辑后删除的合并历史同时恢复宿主和连线', () => {
  const f = lifecycleFixture();
  try {
    const other = f.card('other');
    f.run({ type: 'text.create', expected: null, payload: { id: 'text', content: { runs: [{ text: '编辑前文字', bold: true }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 30, y: 40, width: 180, height: 60 } } });
    const original = f.state().texts![0]!;
    const line = f.connector('line', f.bound(original.item.id, 'left'), f.bound(other.item.id));
    const historyBefore = f.history(), editId = randomUUID(), editGroup = 'continuous-text-edit';
    f.run({ commandId: editId, type: 'text.edit', editGroup, expected: original.versionId, payload: { id: original.id, content: { ...original.content, runs: [{ text: '编辑中' }] } } });
    const edited = f.state().texts![0]!;
    f.run({ type: 'text.edit', editGroup, expected: edited.versionId, payload: { id: original.id, content: { ...original.content, runs: [{ text: '   ' }] } } });
    const blank = f.state().texts![0]!;
    expect(blank.content.runs).toEqual([{ text: '   ' }]); expect(f.state().connectors).toEqual([line]);
    const command = { commandId: randomUUID(), type: 'text.delete', editGroup, expected: { text: blank.versionId, pose: blank.item.versionId, connectors: { line: line.versionId } }, payload: { id: original.id } };
    const receipt = f.run(command), ids = [original.id, original.item.id, line.id].sort();
    expect([...receipt.deletedIds!].sort()).toEqual(ids);
    expect(f.state().texts).toEqual([]); expect(f.state().connectors).toEqual([]);
    expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
    expect(f.history().undo.at(-1)).toMatchObject({ id: editId, label: 'text.edit', target: { id: original.id } });
    f.reopen(); expect(f.run(command)).toEqual(receipt);
    const undo = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: { actionId: editId } });
    const restored = f.state().texts![0]!;
    expect(restored).toMatchObject({ id: original.id, content: original.content, item: { id: original.item.id, pose: original.item.pose } });
    expect(restored.versionId).not.toBe(original.versionId); expect(restored.item.versionId).not.toBe(original.item.versionId);
    const restoredLine = f.state().connectors![0]!;
    expect(restoredLine).toEqual({ ...line, versionId: expect.any(String) }); expect(restoredLine.versionId).not.toBe(line.versionId);
    expect([...undo.changedIds].sort()).toEqual(ids); expect(undo.historyTarget!.id).toBe(original.id);
    expect(undo.connectorVersions).toEqual({ line: restoredLine.versionId }); expect(undo.deletedIds).toEqual([]);
    expect(f.history().undo).toEqual(historyBefore.undo);
    const restoredState = f.state(); f.reopen(); expect(f.state()).toEqual(restoredState);
    const redo = f.run({ type: 'history.redo', expected: f.state().project.revision, payload: { actionId: editId } });
    expect([...redo.deletedIds!].sort()).toEqual(ids); expect(redo.historyTarget!.id).toBe(original.id);
    expect(f.state().texts).toEqual([]); expect(f.state().connectors).toEqual([]); expect(f.state().cards).toEqual([other]);
    f.reopen();
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: { actionId: editId } });
    expect(f.state().texts![0]!.content).toEqual(original.content); expect(f.state().connectors![0]!.start).toEqual(line.start);
  } finally { f.close(); }
});
