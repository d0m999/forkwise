import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import type { Card } from '../src/mapping/contracts.js';

const deletion = (host: Card, connectors: Record<string, string>) => ({
  commandId: randomUUID(), type: 'thought.delete',
  expected: { thought: host.versionId, body: host.body.versionId, pose: host.item.versionId, appearance: host.appearance?.versionId ?? null, cardTags: host.cardTags?.versionId ?? null, connectors },
  payload: { id: host.id },
});
function incidentFixture() {
  const f = lifecycleFixture(), host = f.card('host'), other = f.card('other');
  const line = f.connector('line', f.bound(host.item.id), f.bound(other.item.id, 'left'));
  return { f, host, other, line };
}
function rejectsWithoutChange(f: ReturnType<typeof lifecycleFixture>, command: Record<string, unknown>) {
  const state = f.state(), history = f.history();
  expect(() => f.run(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(state); expect(f.history()).toEqual(history);
}

it('删除宿主拒绝遗漏或多报关联连线闭包', () => {
  const { f, host, line } = incidentFixture();
  try {
    for (const connectors of [{}, { line: line.versionId, missing: 'not-a-version' }]) {
      const command = deletion(host, connectors);
      rejectsWithoutChange(f, command);
      rejectsWithoutChange(f, command);
    }
    const command = deletion(host, { line: line.versionId });
    const receipt = f.run(command); expect(receipt.deletedIds).toContain(line.id);
    expect(f.state().cards.map(value => value.id)).toEqual(['other']); expect(f.state().connectors).toEqual([]);
    f.reopen(); expect(f.run(command)).toEqual(receipt);
  } finally { f.close(); }
});


it('删除宿主检测关联连线新增竞态并整体拒绝', () => {
  const { f, host, line } = incidentFixture();
  try {
    const command = deletion(host, { line: line.versionId });
    const added = f.connector('added', f.free(-20, 80), f.bound(host.item.id, 'top'));
    rejectsWithoutChange(f, command);
    const receipt = f.run({ ...command, expected: { ...command.expected, connectors: { line: line.versionId, added: added.versionId } } });
    expect([...receipt.deletedIds!]).toEqual(expect.arrayContaining([host.id, host.item.id, 'line', 'added']));
    expect(f.state().cards.map(value => value.id)).toEqual(['other']); expect(f.state().connectors).toEqual([]);
  } finally { f.close(); }
});


it('删除宿主检测关联连线删除竞态并整体拒绝', () => {
  const { f, host, line } = incidentFixture();
  try {
    const command = deletion(host, { line: line.versionId });
    f.run({ type: 'connector.delete', expected: line.versionId, payload: { id: line.id } });
    rejectsWithoutChange(f, command);
    const receipt = f.run({ ...command, expected: { ...command.expected, connectors: {} } });
    expect(receipt.deletedIds).toContain(host.id); expect(receipt.deletedIds).not.toContain(line.id);
    expect(f.state().cards.map(value => value.id)).toEqual(['other']); expect(f.state().connectors).toEqual([]);
  } finally { f.close(); }
});


it('删除宿主检测关联连线重接版本变化并整体拒绝', () => {
  const { f, host, line } = incidentFixture();
  try {
    const command = deletion(host, { line: line.versionId });
    f.run({ type: 'connector.reconnect', expected: line.versionId, payload: { id: line.id, endpoint: 'start', value: f.bound(host.item.id, 'bottom') } });
    const reconnected = f.state().connectors![0]!;
    expect(reconnected.versionId).not.toBe(line.versionId);
    rejectsWithoutChange(f, command);
    const receipt = f.run({ ...command, expected: { ...command.expected, connectors: { line: reconnected.versionId } } });
    expect(receipt.deletedIds).toContain(line.id); expect(f.state().connectors).toEqual([]);
    expect(f.state().cards.map(value => value.id)).toEqual(['other']);
  } finally { f.close(); }
});


it('删除宿主检测关联连线重接离开造成的集合变化', () => {
  const { f, host, line } = incidentFixture();
  try {
    const command = deletion(host, { line: line.versionId });
    f.run({ type: 'connector.reconnect', expected: line.versionId, payload: { id: line.id, endpoint: 'start', value: f.free(400, 80) } });
    const detached = f.state().connectors![0]!;
    rejectsWithoutChange(f, command);
    const receipt = f.run({ ...command, expected: { ...command.expected, connectors: {} } });
    expect(receipt.deletedIds).not.toContain(line.id); expect(f.state().connectors).toEqual([detached]);
    expect(f.state().cards.map(value => value.id)).toEqual(['other']);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().cards.some(value => value.id === host.id)).toBe(true); expect(f.state().connectors).toEqual([detached]);
  } finally { f.close(); }
});


it('删除宿主不被无关连线变化阻塞', () => {
  const { f, host, other, line } = incidentFixture();
  try {
    const unrelated = f.connector('unrelated', f.free(-20, 10), f.bound(other.item.id));
    const command = deletion(host, { line: line.versionId });
    f.run({ type: 'connector.path', expected: unrelated.versionId, payload: { id: unrelated.id, path: 'curve' } });
    const changed = f.state().connectors!.find(value => value.id === unrelated.id)!;
    f.run({ type: 'connector.reconnect', expected: changed.versionId, payload: { id: unrelated.id, endpoint: 'end', value: f.bound(other.item.id, 'top') } });
    const retained = f.state().connectors!.find(value => value.id === unrelated.id)!;
    const receipt = f.run(command);
    expect(receipt.deletedIds).toContain(line.id); expect(receipt.deletedIds).not.toContain(retained.id);
    expect(f.state().cards).toEqual([other]); expect(f.state().connectors).toEqual([retained]);
    f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    expect(f.state().connectors).toEqual([{ ...line, versionId: expect.any(String) }, retained]);
  } finally { f.close(); }
});


it('宿主与关联线删除在存储失败后整体回滚且原命令可重试', () => {
  for (const failAt of ['versions', 'history', 'receipt'] as const) {
    let armed = false;
    const f = lifecycleFixture({ checkpoint: phase => { if (armed && phase === failAt) throw new Error(`storage failure: ${failAt}`); } });
    try {
      const host = f.card('host'), other = f.card('other');
      const line = f.connector('line', f.bound(host.item.id), f.bound(other.item.id));
      const command = deletion(host, { line: line.versionId });
      const before = f.state(), historyBefore = f.history();
      armed = true;
      expect(() => f.run(command)).toThrow(`storage failure: ${failAt}`);
      expect(f.state()).toEqual(before); expect(f.history()).toEqual(historyBefore);
      f.reopen(); expect(f.state()).toEqual(before); expect(f.history()).toEqual(historyBefore);
      armed = false;
      const receipt = f.run(command);
      expect(receipt.revision).toBe(before.project.revision + 1);
      expect(receipt.deletedIds).toContain(host.id); expect(receipt.deletedIds).toContain(line.id);
      expect(f.state().cards).toEqual([other]); expect(f.state().connectors).toEqual([]);
      expect(f.history().undo).toHaveLength(historyBefore.undo.length + 1);
      f.reopen(); expect(f.run(command)).toEqual(receipt);
      f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
      expect(f.state().cards.find(value => value.id === host.id)).toMatchObject({ id: host.id, title: host.title });
      expect(f.state().connectors).toEqual([{ ...line, versionId: expect.any(String) }]);
    } finally { f.close(); }
  }
});
