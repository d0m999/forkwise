import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('替换失败重试完成后redo恢复新图完整JSON，原动作及不可变版本与资产保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-replacement-history-'));
  let host = openMapping(directory);
  let passed = false;
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
    const read = () => host.read({ type: 'project', projectId: 'p' }, actor);
    const history = () => host.read({ type: 'history', projectId: 'p' }, actor);
    const edit = (blocks: unknown[]) => run({
      type: 'body.edit', expected: read().cards[0]!.body.versionId,
      payload: { id: 'a', blocks },
    });
    run({ type: 'project.create', expected: null, payload: { name: '替换历史' } });
    run({ type: 'thought.create', expected: null,
      payload: { id: 'a', title: '原卡', text: '', x: 0, y: 0 } });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12" fill="red"/></svg>').toString('base64');
    run({ type: 'asset.save', expected: null,
      payload: { id: 'old', name: '原图.png', mime: 'image/png', base64: png } });
    const image = { id: 'image', inlineId: 'image-inline', type: 'image', assetId: 'old',
      name: '原图.png', mime: 'image/png', naturalWidth: 1, naturalHeight: 1,
      width: 177, caption: '原图注', alt: '原alt' };
    const neighbor = { id: 'neighbor', inlineId: 'neighbor-inline', type: 'text',
      text: '邻块完整格式', marks: [{ type: 'bold', start: 0, end: 2 }] };
    edit([image, neighbor]);
    const original = structuredClone(read().cards[0]!.body);
    const request = { id: 'request', type: 'imageTask', ticket: 'first',
      name: '新图.svg', mime: 'image/svg+xml', base64: svg,
      byteLength: Buffer.from(svg, 'base64').length, width: 320, height: 180, status: 'queued' };
    edit([{ ...image, request }, neighbor]);
    const actionHistory = history();
    run({ type: 'media.fail', expected: 'first',
      payload: { id: 'a', blockId: 'image', reason: '模拟保存失败' } });
    expect(read().cards[0]!.body.blocks).toEqual([
      { ...image, request: { ...request, status: 'failed', reason: '模拟保存失败' } }, neighbor,
    ]);
    run({ type: 'media.retry', expected: 'first',
      payload: { id: 'a', blockId: 'image', ticket: 'retry' } });
    const queued = structuredClone(read().cards[0]!.body);
    expect(queued.blocks).toEqual([{ ...image, request: { ...request, ticket: 'retry' } }, neighbor]);
    expect(history().undo).toEqual(actionHistory.undo);
    expect(history().redo).toEqual(actionHistory.redo);
    run({ type: 'asset.save', expected: null,
      payload: { id: 'new', name: '新图.svg', mime: 'image/svg+xml', base64: svg } });
    const beforeFinish = read().project.revision;
    const receipt = run({ type: 'media.finish', expected: 'retry',
      payload: { id: 'a', blockId: 'image', assetId: 'new' } });
    const completed = [{ ...image, assetId: 'new', name: '新图.svg', mime: 'image/svg+xml',
      naturalWidth: 24, naturalHeight: 12 }, neighbor];
    expect(read().cards[0]!.body.blocks).toEqual(completed);
    expect(host.observe({ projectId: 'p', afterRevision: beforeFinish }, actor).changes[0]!.revision).toBe(receipt.revision);
    expect(history().undo).toEqual(actionHistory.undo);
    expect(history().redo).toEqual(actionHistory.redo);
    const version = (body: typeof original) => host.read({ type: 'version', projectId: 'p',
      domain: 'body', id: body.id, versionId: body.versionId }, actor);
    expect(version(original)).toEqual(original);
    expect(version(queued)).toEqual(queued);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual([image, neighbor]);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(completed);
    const index = host.read({ type: 'map', view: 'index', projectId: 'p' }, actor);
    const detail = host.read({ type: 'map', view: 'detail', projectId: 'p', cardId: 'a', snapshot: index.snapshot }, actor);
    expect(detail.revision).toBe(read().project.revision);
    expect(JSON.parse(detail.items.map((item) => item.jsonText).join('')).blocks).toEqual(completed);
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body.blocks).toEqual(completed);
    expect(version(original)).toEqual(original);
    expect(version(queued)).toEqual(queued);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'old' }, actor).base64).toBe(png);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'new' }, actor).base64).toBe(svg);
    passed = true;
  } finally {
    host.close();
    if (passed) rmSync(directory, { recursive: true, force: true });
  }
});
