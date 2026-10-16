import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('正文图片说明与期望宽经真实Mapping/revision/版本/重开保真，替换晚到保留当前字段且40步统一历史有效', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-image-reading-'));
  let host = openMapping(directory),
    passed = false;
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
    const read = () => host.read({ type: 'project', projectId: 'p' }, actor);
    const edit = (blocks: unknown[]) =>
      run({
        type: 'body.edit',
        expected: read().cards[0]!.body.versionId,
        payload: { id: 'a', blocks },
      });
    run({ type: 'project.create', expected: null, payload: { name: '图片阅读合同' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '图片', text: '', x: 0, y: 0 },
    });
    const base64 = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="green"/></svg>',
    ).toString('base64');
    for (const id of ['original', 'replacement'])
      run({
        type: 'asset.save',
        expected: null,
        payload: { id, name: `${id}.svg`, mime: 'image/svg+xml', base64 },
      });
    const image = {
      id: 'image',
      inlineId: 'inline-image',
      type: 'image',
      assetId: 'original',
      name: 'original.svg',
      mime: 'image/svg+xml',
      naturalWidth: 1200,
      naturalHeight: 600,
      width: 640.5,
      caption: '用户图注\n保留换行',
      alt: '用户 alt\n原文',
    };
    const text = { id: 'text', type: 'text', text: '原正文', inlineId: 'inline-text' };
    edit([image, text]);
    const originalBody = structuredClone(read().cards[0]!.body);
    const beforeNoChange = read().project.revision;
    const noChange = run({
      type: 'body.edit',
      expected: originalBody.versionId,
      payload: { id: 'a', blocks: [image, text] },
    });
    expect(noChange.revision).toBe(beforeNoChange);
    expect(read().project.revision).toBe(beforeNoChange);
    edit([text, image]);
    expect(read().cards[0]!.body.blocks).toEqual([text, image]);
    const task = {
      id: 'request',
      type: 'imageTask',
      ticket: 'replacement-ticket',
      name: 'replacement.svg',
      mime: 'image/svg+xml',
      base64,
      byteLength: Buffer.from(base64, 'base64').length,
      width: 320,
      height: 180,
      status: 'queued',
    };
    edit([text, { ...image, request: task }]);
    const updated = {
      ...image,
      width: 350.25,
      caption: '替换期间用户的新图注',
      alt: '新的替代文字',
    };
    edit([text, { ...updated, request: task }]);
    const revision = read().project.revision;
    const receipt = run({
      type: 'media.finish',
      expected: 'replacement-ticket',
      payload: { id: 'a', blockId: 'image', assetId: 'replacement' },
    });
    const completed = { ...updated, assetId: 'replacement', name: 'replacement.svg' };
    expect(read().cards[0]!.body.blocks).toEqual([text, completed]);
    expect(
      host.observe({ projectId: 'p', afterRevision: revision }, actor).changes[0]!.revision,
    ).toBe(receipt.revision);
    expect(
      host.read(
        {
          type: 'version',
          projectId: 'p',
          domain: 'body',
          id: originalBody.id,
          versionId: originalBody.versionId,
        },
        actor,
      ),
    ).toEqual(originalBody);
    const map = host.read({ type: 'map', view: 'index', projectId: 'p' }, actor);
    const detail = host.read(
      { type: 'map', view: 'detail', projectId: 'p', cardId: 'a', snapshot: map.snapshot },
      actor,
    );
    expect(detail.revision).toBe(read().project.revision);
    expect(JSON.parse(detail.items.map((i) => i.jsonText).join('')).blocks).toEqual([
      text,
      completed,
    ]);
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body.blocks).toEqual([text, completed]);
    for (let i = 1; i <= 41; i++) edit([text, { ...completed, width: 200 + i }]);
    expect(host.read({ type: 'history', projectId: 'p' }, actor).undo).toHaveLength(40);
    for (let i = 0; i < 40; i++)
      run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual([text, { ...completed, width: 201 }]);
    expect(() =>
      run({ type: 'history.undo', expected: read().project.revision, payload: {} }),
    ).toThrow();
    for (let i = 0; i < 40; i++)
      run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual([text, { ...completed, width: 241 }]);
    const agent = host.access.authenticate(host.access.issue('agent', ['p']));
    const beforeDenied = read();
    expect(() =>
      host.execute(
        {
          commandId: randomUUID(),
          projectId: 'p',
          type: 'history.undo',
          expected: beforeDenied.project.revision,
          payload: {},
        },
        agent,
      ),
    ).toThrow();
    const wrong = host.access.authenticate(host.access.issue('agent', ['other']));
    expect(() => host.read({ type: 'project', projectId: 'p' }, wrong)).toThrow();
    expect(read()).toEqual(beforeDenied);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'original' }, actor).base64).toBe(base64);
    passed = true;
  } finally {
    host.close();
    if (passed) rmSync(directory, { recursive: true, force: true });
  }
});
