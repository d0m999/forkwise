import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('段落身份、块内换行和末尾空段通过真实Mapping保存、撤销和重开无损往返', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-paragraphs-'));
  let host: ReturnType<typeof openMapping> | undefined;
  try {
    host = openMapping(directory);
    const token = host.access.issue('human', ['*']);
    let human = host.access.authenticate(token);
    const run = (command: Record<string, unknown>) => host!.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '段落' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'a', title: '标题', text: '原文\n原块内换行', x: 10, y: 20 } });
    const original = read().cards[0]!;
    const blocks = [
      { ...original.body.blocks[0]!, text: '第一段\n软换行', inlineId: 'inline-original' },
      { id: 'paragraph-two', type: 'text', text: '第二段中文', inlineId: 'inline-two' },
      { id: 'paragraph-empty', type: 'text', text: '', inlineId: 'inline-empty' },
    ];
    const command = { commandId: 'original-paragraph-request', type: 'body.edit', expected: original.body.versionId, payload: { id: 'a', blocks } };
    const receipt = run(command);
    const saved = read().cards[0]!;
    expect(saved.body.blocks).toEqual(blocks);
    expect(saved.item).toEqual(original.item);
    const snapshot = host.read({ type: 'map', projectId: 'p', view: 'index' }, human);
    expect(host.read({ type: 'map', projectId: 'p', view: 'body', cardId: 'a', snapshot: snapshot.snapshot }, human).items[0]!.text).toContain('第一段');
    expect(host.observe({ projectId: 'p', afterRevision: receipt.revision - 1 }, human).changes[0]!.domains).toContainEqual({ domain: 'body', id: original.body.id });
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(original.body.blocks);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(blocks);
    host.close();
    host = openMapping(directory);
    human = host.access.authenticate(token);
    expect(run(command)).toEqual(receipt);
    expect(read().cards[0]!.body.blocks).toEqual(blocks);
  } finally {
    host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('完整段落请求保持既有200000文字保存边界，拒绝超限仍保留原文和历史', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-paragraph-limit-'));
  let host: ReturnType<typeof openMapping> | undefined;
  try {
    host = openMapping(directory);
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) => host!.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '边界' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'a', title: '原卡', text: '完整原文', x: 10, y: 20 } });
    const original = read();
    expect(() => run({ type: 'body.edit', expected: original.cards[0]!.body.versionId, payload: { id: 'a', blocks: [{ ...original.cards[0]!.body.blocks[0]!, text: '字'.repeat(200001) }] } })).toThrow();
    expect(read()).toEqual(original);
    expect(host.read({ type: 'history', projectId: 'p' }, human).undo).toHaveLength(1);
  } finally { host?.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('段落和行内身份不能借用另一正文的身份，也不能跨版本复用已归属的身份', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-paragraph-ownership-'));
  let host: ReturnType<typeof openMapping> | undefined;
  try {
    host = openMapping(directory);
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) => host!.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '身份' } });
    for (const id of ['a', 'b']) run({ type: 'thought.create', expected: null, payload: { id, title: id, text: '原文', x: 10, y: 20 } });
    const [a, b] = read().cards;
    const original = read();
    expect(() => run({ type: 'body.edit', expected: a!.body.versionId, payload: { id: 'a', blocks: [{ ...b!.body.blocks[0]!, text: '借用身份' }] } })).toThrow('身份');
    expect(read()).toEqual(original);
    run({ type: 'body.edit', expected: b!.body.versionId, payload: { id: 'b', blocks: [{ ...b!.body.blocks[0]!, text: '真实变更建立身份归属', inlineId: 'owned-inline' }] } });
    expect(() => run({ type: 'body.edit', expected: a!.body.versionId, payload: { id: 'a', blocks: [{ ...a!.body.blocks[0]!, inlineId: 'owned-inline' }] } })).toThrow('身份');
    const now = read().cards.find(c => c.id === 'b')!;
    run({ type: 'body.edit', expected: now.body.versionId, payload: { id: 'b', blocks: [{ id: 'new-b', type: 'text', text: '保留旧版本', inlineId: 'new-b-inline' }] } });
    expect(() => run({ type: 'body.edit', expected: a!.body.versionId, payload: { id: 'a', blocks: [{ ...a!.body.blocks[0]!, inlineId: 'owned-inline' }] } })).toThrow('身份');
  } finally { host?.close(); rmSync(directory, { recursive: true, force: true }); }
});


it('完整段落与布局沿既有card.edit原子更新，任何版本冲突均不写部分结果', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-paragraph-atomic-'));
  let host: ReturnType<typeof openMapping> | undefined;
  try {
    host = openMapping(directory);
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (c: Record<string, unknown>) => host!.execute({ commandId: randomUUID(), projectId: 'p', ...c }, human);
    const read = () => host!.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '原子完整正文' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'a', title: '原卡', text: '完整原文', x: 10, y: 20 } });
    const original = read(), card = original.cards[0]!;
    const blocks = [{ ...card.body.blocks[0]!, inlineId: 'atomic-inline', text: '原子第一段' }, { id: 'atomic-second', type: 'text', text: '原子第二段', inlineId: 'atomic-second-inline' }];
    const command = { type: 'card.edit', expected: { body: card.body.versionId, pose: card.item.versionId }, payload: { id: 'a', blocks, x: 30, y: 40 } };
    expect(() => run({ ...command, expected: { ...command.expected, pose: 'stale-pose' } })).toThrow();
    expect(read()).toEqual(original);
    const receipt = run(command), saved = read();
    expect(saved.cards[0]!.body.blocks).toEqual(blocks);
    expect(saved.cards[0]!.item.pose).toEqual({ ...card.item.pose, x: 30, y: 40 });
    expect(receipt.changedIds).toEqual([card.body.id, card.item.id]);
    expect(saved.project.revision).toBe(original.project.revision + 1);
    run({ type: 'history.undo', expected: saved.project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(card.body.blocks);
    expect(read().cards[0]!.item.pose).toEqual(card.item.pose);
  } finally { host?.close(); rmSync(directory, { recursive: true, force: true }); }
});
