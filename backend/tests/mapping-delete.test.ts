import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('真实删除检查全部版本并保留原身份，直接撤销只绑定当前历史顶的此次删除，晚到正文不能复活', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-delete-'));
  let host: ReturnType<typeof openMapping> | undefined;
  try {
    host = openMapping(directory);
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) => host!.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '删除' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'a', title: '原卡', text: '不可丢失的完整正文', x: 10, y: 20 } });
    const original = read().cards[0]!;
    const deletion = { commandId: 'this-deletion', type: 'thought.delete', expected: { thought: original.versionId, body: original.body.versionId, pose: original.item.versionId, appearance: null }, payload: { id: 'a' } };
    const receipt = run(deletion);
    expect(receipt.deletedIds).toEqual([original.id, original.body.id, original.item.id]);
    expect(read().cards).toEqual([]);
    expect(host.read({ type: 'card.identity', projectId: 'p', id: 'a' }, human).availability).toBe('deleted');
    expect(() => run({ type: 'body.edit', expected: original.body.versionId, payload: { id: 'a', text: '晚到' } })).toThrow('卡片不存在');
    run({ type: 'project.rename', expected: read().project.versionId, payload: { name: '更晚操作' } });
    const before = read();
    expect(() => run({ type: 'history.undo', expected: before.project.revision, payload: { actionId: 'this-deletion' } })).toThrow('历史目标');
    expect(read()).toEqual(before);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    run({ type: 'history.undo', expected: read().project.revision, payload: { actionId: 'this-deletion' } });
    const restored = read().cards[0]!;
    expect(restored).toMatchObject({ id: original.id, title: original.title, body: { id: original.body.id, blocks: original.body.blocks }, item: { id: original.item.id, pose: original.item.pose } });
    expect(restored.body.versionId).not.toBe(original.body.versionId);
    expect(() => run({ ...deletion, commandId: 'stale-delete' })).toThrow('删除依据');
    expect(run(deletion)).toEqual(receipt);
    expect(read().cards).toHaveLength(1);
  } finally {
    host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
