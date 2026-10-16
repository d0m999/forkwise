import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
it('真实图片字节经Mapping保存重开可读，资源创建不占研究历史或正文revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-'));
  let host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
    run({ type: 'project.create', expected: null, payload: { name: '图片' } });
    const before = host.read({ type: 'history', projectId: 'p' }, actor);
    run({
      type: 'asset.save',
      expected: null,
      payload: { id: 'image1', name: '原图.png', mime: 'image/png', base64: png },
    });
    expect(host.read({ type: 'history', projectId: 'p' }, actor)).toEqual(before);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'image1' }, actor)).toMatchObject({
      id: 'image1',
      name: '原图.png',
      mime: 'image/png',
      base64: png,
      width: 1,
      height: 1,
    });
    host.close();
    host = openMapping(directory);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'image1' }, actor)).toMatchObject({
      base64: png,
      width: 1,
      height: 1,
    });
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('静态SVG可保存，但脚本、外联、动效、伪格式及超容量全部拒绝且不污染资产', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-svg-'));
  const host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (payload: Record<string, unknown>) =>
      host.execute(
        { commandId: randomUUID(), projectId: 'p', type: 'asset.save', expected: null, payload },
        actor,
      );
    host.execute(
      {
        commandId: 'project',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: 'SVG' },
      },
      actor,
    );
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>';
    run({
      id: 'svg',
      name: '图.svg',
      mime: 'image/svg+xml',
      base64: Buffer.from(svg).toString('base64'),
    });
    expect(host.read({ type: 'asset', projectId: 'p', id: 'svg' }, actor)).toMatchObject({
      width: 20,
      height: 10,
    });
    for (const content of [
      '<script>alert(1)</script>',
      '<image href="https://example.com/a.png"/>',
      '<rect onload="alert(1)"/>',
      '<style>rect{fill:url(https://example.com/a)}</style>',
      '<animate attributeName="x"/>',
    ]) {
      expect(() =>
        run({
          id: 'bad',
          name: '危险.svg',
          mime: 'image/svg+xml',
          base64: Buffer.from(svg.replace('</svg>', content + '</svg>')).toString('base64'),
        }),
      ).toThrow();
    }
    expect(() =>
      run({
        id: 'bad',
        name: '坏.png',
        mime: 'image/png',
        base64: Buffer.from('not PNG').toString('base64'),
      }),
    ).toThrow();
    expect(() =>
      run({
        id: 'bad',
        name: '过大.png',
        mime: 'image/png',
        base64: Buffer.alloc(512 * 1024 + 1).toString('base64'),
      }),
    ).toThrow();
    expect(() => host.read({ type: 'asset', projectId: 'p', id: 'bad' }, actor)).toThrow();
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('解码须完整成功：有可读尺寸但截断的PNG/JPEG/WebP/GIF不成为已保存资产', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-decode-'));
  const host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    host.execute(
      {
        commandId: 'p',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: '完整解码' },
      },
      actor,
    );
    const canvas = createCanvas(8, 8);
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const fixtures = [
      ['png', canvas.toBuffer('image/png')],
      ['jpeg', canvas.toBuffer('image/jpeg')],
      ['webp', canvas.toBuffer('image/webp')],
      [
        'gif',
        Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
      ],
    ] as const;
    for (const [format, bytes] of fixtures) {
      const payload = {
        id: format,
        name: 'test.' + format,
        mime: 'image/' + format,
        base64: bytes.toString('base64'),
      };
      host.execute(
        { commandId: 'ok-' + format, projectId: 'p', type: 'asset.save', expected: null, payload },
        actor,
      );
      expect(() =>
        host.execute(
          {
            commandId: 'bad-' + format,
            projectId: 'p',
            type: 'asset.save',
            expected: null,
            payload: {
              ...payload,
              id: 'bad-' + format,
              base64: bytes
                .subarray(0, bytes.length - (format === 'png' ? 12 : format === 'gif' ? 1 : 2))
                .toString('base64'),
            },
          },
          actor,
        ),
      ).toThrow();
      expect(() =>
        host.read({ type: 'asset', projectId: 'p', id: 'bad-' + format }, actor),
      ).toThrow();
    }
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('任务固定原卡原Block及ticket，跨卡完成原处，完成不另占历史，undo/redo及同revision完整JSON保真', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-task-'));
  let host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
    const read = () => host.read({ type: 'project', projectId: 'p' }, actor);
    run({ type: 'project.create', expected: null, payload: { name: '原卡任务' } });
    for (const id of ['a', 'b'])
      run({
        type: 'thought.create',
        expected: null,
        payload: { id, title: id, text: id, x: 0, y: 0 },
      });
    const original = read().cards[0]!.body.blocks;
    const task = {
      id: 'insert',
      type: 'imageTask',
      ticket: 'ticket1',
      name: '原图.png',
      mime: 'image/png',
      base64: png,
      byteLength: 70,
      width: 320,
      height: 180,
      status: 'queued',
    };
    run({
      type: 'body.edit',
      expected: read().cards[0]!.body.versionId,
      payload: { id: 'a', blocks: [...original, task] },
    });
    run({
      type: 'body.edit',
      expected: read().cards[1]!.body.versionId,
      payload: { id: 'b', text: '切卡后的文字' },
    });
    run({
      type: 'asset.save',
      expected: null,
      payload: { id: 'asset1', name: '原图.png', mime: 'image/png', base64: png },
    });
    const history = host.read({ type: 'history', projectId: 'p' }, actor);
    const before = read().project.revision;
    const receipt = run({
      type: 'media.finish',
      expected: 'ticket1',
      payload: { id: 'a', blockId: 'insert', assetId: 'asset1' },
    });
    const image = {
      id: 'insert',
      type: 'image',
      assetId: 'asset1',
      name: '原图.png',
      mime: 'image/png',
      naturalWidth: 1,
      naturalHeight: 1,
    };
    expect(read().cards[0]!.body.blocks).toEqual([...original, image]);
    expect(read().cards[1]!.body.blocks[0]!.text).toBe('切卡后的文字');
    expect(host.read({ type: 'history', projectId: 'p' }, actor).undo).toEqual(history.undo);
    const change = host.observe({ projectId: 'p', afterRevision: before }, actor);
    expect(change.changes[0]!.revision).toBe(receipt.revision);
    const index = host.read({ type: 'map', view: 'index', projectId: 'p' }, actor);
    const detail = host.read(
      { type: 'map', view: 'detail', projectId: 'p', cardId: 'a', snapshot: index.snapshot },
      actor,
    );
    expect(detail.revision).toBe(receipt.revision);
    expect(JSON.parse(detail.items.map((i) => i.jsonText).join('')).blocks).toEqual([
      ...original,
      image,
    ]);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks.at(-1)).toEqual(image);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(original);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks.at(-1)).toEqual(image);
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body.blocks.at(-1)).toEqual(image);
    expect(host.read({ type: 'asset', projectId: 'p', id: 'asset1' }, actor).base64).toBe(png);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('失败重试保同一块且只原动作undo，旧ticket、撤销、移除和删卡晚到不能复活', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-retire-'));
  const host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
    const read = () => host.read({ type: 'project', projectId: 'p' }, actor);
    run({ type: 'project.create', expected: null, payload: { name: '失效任务' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: 'a', text: '原文', x: 0, y: 0 },
    });
    const original = read().cards[0]!.body.blocks;
    const task = {
      id: 'task',
      type: 'imageTask',
      ticket: 't1',
      name: 'a.png',
      mime: 'image/png',
      base64: png,
      byteLength: 70,
      width: 320,
      height: 180,
      status: 'queued',
    };
    run({
      type: 'body.edit',
      expected: read().cards[0]!.body.versionId,
      payload: { id: 'a', blocks: [...original, task] },
    });
    run({
      type: 'media.fail',
      expected: 't1',
      payload: { id: 'a', blockId: 'task', reason: '模拟磁盘写入失败' },
    });
    const history = host.read({ type: 'history', projectId: 'p' }, actor);
    run({
      type: 'media.retry',
      expected: 't1',
      payload: { id: 'a', blockId: 'task', ticket: 't2' },
    });
    expect(host.read({ type: 'history', projectId: 'p' }, actor).undo).toEqual(history.undo);
    run({
      type: 'asset.save',
      expected: null,
      payload: { id: 'asset', name: 'a.png', mime: 'image/png', base64: png },
    });
    const finish = (ticket: string) =>
      run({
        type: 'media.finish',
        expected: ticket,
        payload: { id: 'a', blockId: 'task', assetId: 'asset' },
      });
    expect(() => finish('t1')).toThrow();
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(() => finish('t2')).toThrow();
    expect(read().cards[0]!.body.blocks).toEqual(original);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks.at(-1)).toMatchObject({ status: 'failed' });
    expect(() => finish('t2')).toThrow();
    run({
      type: 'media.retry',
      expected: 't2',
      payload: { id: 'a', blockId: 'task', ticket: 't3' },
    });
    run({
      type: 'body.edit',
      expected: read().cards[0]!.body.versionId,
      payload: { id: 'a', blocks: original },
    });
    expect(() => finish('t3')).toThrow();
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    run({
      type: 'media.retry',
      expected: 't3',
      payload: { id: 'a', blockId: 'task', ticket: 't4' },
    });
    const card = read().cards[0]!;
    run({
      type: 'thought.delete',
      expected: {
        thought: card.versionId,
        body: card.body.versionId,
        pose: card.item.versionId,
        appearance: card.appearance?.versionId ?? null,
      },
      payload: { id: 'a' },
    });
    expect(() => finish('t4')).toThrow();
    expect(read().cards).toHaveLength(0);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('正文替换保持width/caption/alt、失败留旧图，ticket请求不可改写且只有最新结果生效', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-replace-'));
  const host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
    const read = () => host.read({ type: 'project', projectId: 'p' }, actor);
    run({ type: 'project.create', expected: null, payload: { name: '替换' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: 'a', text: '', x: 0, y: 0 },
    });
    run({
      type: 'asset.save',
      expected: null,
      payload: { id: 'old', name: 'old.png', mime: 'image/png', base64: png },
    });
    const image = {
      id: 'image',
      type: 'image',
      assetId: 'old',
      name: 'old.png',
      mime: 'image/png',
      naturalWidth: 1,
      naturalHeight: 1,
      width: 321,
      caption: '只索引图注',
      alt: '不索引替代文字',
    };
    const edit = (blocks: unknown[]) =>
      run({
        type: 'body.edit',
        expected: read().cards[0]!.body.versionId,
        payload: { id: 'a', blocks },
      });
    edit([image]);
    const task = {
      id: 'request',
      type: 'imageTask',
      ticket: 'r1',
      name: 'new.png',
      mime: 'image/png',
      base64: png,
      byteLength: 70,
      width: 320,
      height: 180,
      status: 'queued',
    };
    edit([{ ...image, request: task }]);
    run({
      type: 'media.fail',
      expected: 'r1',
      payload: { id: 'a', blockId: 'image', reason: '解码失败' },
    });
    expect(read().cards[0]!.body.blocks[0]).toMatchObject(image);
    run({
      type: 'media.retry',
      expected: 'r1',
      payload: { id: 'a', blockId: 'image', ticket: 'r2' },
    });
    const queued = read().cards[0]!.body.blocks[0]!;
    expect(() =>
      edit([{ ...queued, request: { ...(queued.request as object), name: '篡改.png' } }]),
    ).toThrow();
    run({
      type: 'asset.save',
      expected: null,
      payload: { id: 'new', name: 'new.png', mime: 'image/png', base64: png },
    });
    expect(() =>
      run({
        type: 'media.finish',
        expected: 'r1',
        payload: { id: 'a', blockId: 'image', assetId: 'new' },
      }),
    ).toThrow();
    run({
      type: 'media.finish',
      expected: 'r2',
      payload: { id: 'a', blockId: 'image', assetId: 'new' },
    });
    expect(read().cards[0]!.body.blocks).toEqual([{ ...image, assetId: 'new', name: 'new.png' }]);
    const index = host.read({ type: 'map', view: 'index', projectId: 'p' }, actor);
    const body = host.read(
      { type: 'map', view: 'body', projectId: 'p', cardId: 'a', snapshot: index.snapshot },
      actor,
    );
    expect(body.items.map((i) => i.text)).toEqual(['只索引图注']);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual([image]);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
  '保留合法容器尾标仍损坏的像素数据不能持久化 %s',
  async (format) => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(8, 8);
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const pngBytes = canvas.toBuffer('image/png');
    for (let at = 8; at + 12 <= pngBytes.length; ) {
      const n = pngBytes.readUInt32BE(at);
      if (pngBytes.toString('ascii', at + 4, at + 8) === 'IDAT') {
        pngBytes.fill(0, at + 8, at + 8 + n);
        let crc = 0xffffffff;
        for (const byte of pngBytes.subarray(at + 4, at + 8 + n)) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
        pngBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, at + 8 + n);
      }
      at += n + 12;
    }
    const jpeg = canvas.toBuffer('image/jpeg');
    const scan = jpeg.indexOf(Buffer.from([255, 218]));
    const entropy = scan + 2 + jpeg.readUInt16BE(scan + 2);
    jpeg.fill(255, entropy, jpeg.length - 2);
    jpeg[entropy + 1] = 0xc0;
    const webp = canvas.toBuffer('image/webp');
    webp.fill(0, 20);
    const gif = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
      'base64',
    );
    gif[gif.length - 4] = 255;
    gif[gif.length - 3] = 255;
    const directory = mkdtempSync(join(tmpdir(), 'forkwise-pixel-data-'));
    const host = openMapping(directory);
    try {
      const actor = host.access.authenticate(host.access.issue('human', ['*']));
      host.execute(
        {
          commandId: 'p',
          projectId: 'p',
          type: 'project.create',
          expected: null,
          payload: { name: '坏像素' },
        },
        actor,
      );
      for (const [mime, bytes] of [
        ['image/png', pngBytes],
        ['image/jpeg', jpeg],
        ['image/webp', webp],
        ['image/gif', gif],
      ] as const) {
        if (mime !== format) continue;
        expect(
          () =>
            host.execute(
              {
                commandId: mime,
                projectId: 'p',
                type: 'asset.save',
                expected: null,
                payload: {
                  id: mime.replace('/', '-'),
                  name: '坏像素',
                  mime,
                  base64: bytes.toString('base64'),
                },
              },
              actor,
            ),
          mime,
        ).toThrow();
        expect(
          () => host.read({ type: 'asset', projectId: 'p', id: mime.replace('/', '-') }, actor),
          mime,
        ).toThrow();
      }
    } finally {
      host.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('真正多帧GIF完整解码、原字节可重读，帧序列不因静态预览而丢失', async () => {
  const { GifEncoder } = await import('@napi-rs/canvas');
  const encoder = new GifEncoder(16, 16);
  const first = new Uint8Array(16 * 16 * 4),
    second = new Uint8Array(first.length);
  for (let i = 0; i < first.length; i += 4) {
    first.set([i % 256, (i / 4) % 256, 128, 255], i);
    second.set([128, (i / 4) % 256, i % 256, 255], i);
  }
  encoder.addFrame(first, 16, 16, { delay: 100 });
  encoder.addFrame(second, 16, 16, { delay: 100 });
  const bytes = encoder.finish();
  encoder.dispose();
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-animated-gif-')),
    host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    host.execute(
      {
        commandId: 'p',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: 'GIF' },
      },
      actor,
    );
    host.execute(
      {
        commandId: 'gif',
        projectId: 'p',
        type: 'asset.save',
        expected: null,
        payload: {
          id: 'gif',
          name: '双帧.gif',
          mime: 'image/gif',
          base64: bytes.toString('base64'),
        },
      },
      actor,
    );
    expect(host.read({ type: 'asset', projectId: 'p', id: 'gif' }, actor)).toMatchObject({
      base64: bytes.toString('base64'),
      width: 16,
      height: 16,
    });
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('替换处理中兼容字段的后续编辑仍独立undo，不被完成历史快照吞并', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-media-history-fields-')),
    host = openMapping(directory);
  try {
    const actor = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, actor);
    const read = () => host.read({ type: 'project', projectId: 'p' }, actor);
    run({ type: 'project.create', expected: null, payload: { name: '保留字段历史' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: 'a', text: '', x: 0, y: 0 },
    });
    for (const id of ['old', 'new'])
      run({
        type: 'asset.save',
        expected: null,
        payload: { id, name: id + '.png', mime: 'image/png', base64: png },
      });
    const original = {
      id: 'image',
      type: 'image',
      assetId: 'old',
      name: 'old.png',
      mime: 'image/png',
      naturalWidth: 1,
      naturalHeight: 1,
      width: 123,
      caption: '原图注',
      alt: '原alt',
    };
    const edit = (block: unknown) =>
      run({
        type: 'body.edit',
        expected: read().cards[0]!.body.versionId,
        payload: { id: 'a', blocks: [block] },
      });
    edit(original);
    const request = {
      id: 'request',
      type: 'imageTask',
      ticket: 'ticket',
      name: 'new.png',
      mime: 'image/png',
      base64: png,
      byteLength: 70,
      width: 320,
      height: 180,
      status: 'queued',
    };
    edit({ ...original, request });
    edit({ ...original, width: 234, caption: '后续图注', alt: '后续alt', request });
    run({
      type: 'media.finish',
      expected: 'ticket',
      payload: { id: 'a', blockId: 'image', assetId: 'new' },
    });
    expect(read().cards[0]!.body.blocks[0]).toMatchObject({
      assetId: 'new',
      width: 234,
      caption: '后续图注',
      alt: '后续alt',
    });
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual([
      { ...original, assetId: 'new', name: 'new.png' },
    ]);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual([original]);
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('异步媒体完成不把同一连续文字编辑组的保存批次拆成两步',()=>{
 const directory=mkdtempSync(join(tmpdir(),'forkwise-media-typing-group-')),host=openMapping(directory);
 try{
  const actor=host.access.authenticate(host.access.issue('human',['*']));const run=(command:Record<string,unknown>)=>host.execute({commandId:randomUUID(),projectId:'p',...command},actor);const read=()=>host.read({type:'project',projectId:'p'},actor);
  run({type:'project.create',expected:null,payload:{name:'连续写入'}});run({type:'thought.create',expected:null,payload:{id:'a',title:'a',text:'',x:0,y:0}});
  const original=read().cards[0]!.body.blocks[0]!;const task={id:'task',type:'imageTask',ticket:'t',name:'a.png',mime:'image/png',base64:png,byteLength:70,width:320,height:180,status:'queued'};
  run({type:'body.edit',expected:read().cards[0]!.body.versionId,payload:{id:'a',blocks:[original,task]}});
  run({type:'body.edit',editGroup:'same-input',expected:read().cards[0]!.body.versionId,payload:{id:'a',blocks:[{...original,text:'first'},task]}});
  const count=host.read({type:'history',projectId:'p'},actor).undo.length;
  run({type:'asset.save',expected:null,payload:{id:'asset',name:'a.png',mime:'image/png',base64:png}});run({type:'media.finish',expected:'t',payload:{id:'a',blockId:'task',assetId:'asset'}});
  run({type:'body.edit',editGroup:'same-input',expected:read().cards[0]!.body.versionId,payload:{id:'a',blocks:[{...original,text:'first second'},read().cards[0]!.body.blocks[1]!]}});
  expect(host.read({type:'history',projectId:'p'},actor).undo).toHaveLength(count);run({type:'history.undo',expected:read().project.revision,payload:{}});expect(read().cards[0]!.body.blocks[0]!.text).toBe('');expect(read().cards[0]!.body.blocks[1]!.type).toBe('image');
 }finally{host.close();rmSync(directory,{recursive:true,force:true});}
});
