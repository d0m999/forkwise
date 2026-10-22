import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('已确认原件创建独立图片身份及世界外框，完整 JSON 经 SQLite 重开保留且不产生正文卡', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue24-'));
  let host = openMapping(directory);
  try {
    const token = host.access.issue('human', ['*']);
    const human = host.access.authenticate(token);
    const run = (command: Record<string, unknown>) => host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    run({ type: 'project.create', expected: null, payload: { name: '独立图片研究' } });
    const base64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="green"/></svg>').toString('base64');
    run({ type: 'asset.save', expected: null, payload: { id: 'original', name: '原图.svg', mime: 'image/svg+xml', base64 } });
    const content = { assetId: 'original', crop: { x: 0, y: 0, width: 1, height: 1 } };
    const pose = { x: -100, y: 240, width: 360, height: 240, rotation: 0 };
    run({ type: 'image.create', expected: null, payload: { id: 'picture', content, pose } });
    type State = { cards: unknown[]; images: { id: string; kind: string; content: typeof content; item: { id: string; pose: typeof pose } }[] };
    const saved = host.read({ type: 'project', projectId: 'p' }, human) as unknown as State;
    expect(saved.cards).toEqual([]);
    expect(saved.images).toHaveLength(1);
    expect(saved.images[0]).toMatchObject({ id: 'picture', kind: 'image', content, item: { id: expect.any(String), pose } });
    expect(saved.images[0]).not.toHaveProperty('body');
    host.close(); host = openMapping(directory);
    expect(host.read({ type: 'project', projectId: 'p' }, host.access.authenticate(token))).toMatchObject(saved);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'original' }, human).base64).toBe(base64);
  } finally { host.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('独立图片创建使用统一历史，原件不占研究步骤且撤销重做恢复相同身份', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue24-'));
  const host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) => host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '图片历史' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'protected', title: '保护卡片', text: '保留完整正文', x: 700, y: 80 } });
    const cards = read().cards;
    const base64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="green"/></svg>').toString('base64');
    run({ type: 'asset.save', expected: null, payload: { id: 'original', name: '原图.svg', mime: 'image/svg+xml', base64 } });
    run({ type: 'image.create', expected: null, payload: { id: 'picture', content: { assetId: 'original', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: -100, y: 240, width: 360, height: 240, rotation: 0 } } });
    const created = read().images![0]!;
    expect(host.read({ type: 'history', projectId: 'p' }, human).undo.map(a => a.label)).toEqual(['thought.create', 'image.create']);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().images).toEqual([]);
    expect(read().cards).toEqual(cards);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'original' }, human).base64).toBe(base64);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    const restored = read().images![0]!;
    expect(restored).toMatchObject({ id: created.id, kind: 'image', content: created.content, item: { id: created.item.id, pose: created.item.pose } });
    expect(restored.versionId).not.toBe(created.versionId);
    expect(restored.item.versionId).not.toBe(created.item.versionId);
  } finally { host.close(); rmSync(directory, { recursive: true, force: true }); }
});
