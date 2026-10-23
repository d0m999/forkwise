import { expect, it } from 'vitest';
import { imageFixture } from './canvas-image-fixture.js';

it('完成中央自由裁剪后保200×150世界框且保留原件', () => {
  const f = imageFixture();
  try {
    f.run({
      type: 'image.create',
      expected: null,
      payload: {
        id: 'picture',
        content: { assetId: 'original', crop: { x: 0, y: 0, width: 1, height: 1 } },
        pose: { x: 100, y: 80, width: 400, height: 300, rotation: 0 },
      },
    });
    const image = f.read().images![0]!;
    f.run({
      type: 'image.crop',
      expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
    });
    const saved = f.read().images![0]!;
    expect({
      content: saved.content,
      pose: saved.item.pose,
      original: f.host.read({ type: 'asset', projectId: 'p', id: 'original' }, f.human).base64,
    }).toEqual({
      content: { assetId: 'original', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
      pose: { x: 200, y: 155, width: 200, height: 150, rotation: 0 },
      original: f.base64,
    });
  } finally {
    f.close();
  }
});

it('已应用非完整裁剪重复提交相同范围不改变项目或历史', () => {
  const f = imageFixture();
  try {
    f.create();
    const original = f.read().images![0]!;
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    f.run({
      type: 'image.crop',
      expected: { image: original.versionId, pose: original.item.versionId },
      payload: { id: original.id, crop },
    });
    const before = f.read();
    const history = f.host.read({ type: 'history', projectId: 'p' }, f.human);
    const image = before.images![0]!;
    f.run({
      type: 'image.crop',
      expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop },
    });
    expect({
      project: f.read(),
      history: f.host.read({ type: 'history', projectId: 'p' }, f.human),
    }).toEqual({ project: before, history });
  } finally {
    f.close();
  }
});

it('恢复完整图片沿用当前移动拉伸后的可见内容位置和比例', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0, width: 0.75, height: 1 });
    const initial = f.read().images![0]!;
    f.run({
      type: 'image.transform',
      expected: { image: initial.versionId, pose: initial.item.versionId },
      payload: { id: initial.id, pose: { x: 350, y: 200, width: 300, height: 120 } },
    });
    const current = f.read().images![0]!;
    f.run({
      type: 'image.crop',
      expected: { image: current.versionId, pose: current.item.versionId },
      payload: { id: current.id, crop: { x: 0, y: 0, width: 1, height: 1 } },
    });
    const restored = f.read().images![0]!;
    expect({
      content: restored.content,
      pose: restored.item.pose,
      original: f.host.read({ type: 'asset', projectId: 'p', id: 'original' }, f.human).base64,
    }).toEqual({
      content: { assetId: 'original', crop: { x: 0, y: 0, width: 1, height: 1 } },
      pose: { x: 250, y: 200, width: 400, height: 120, rotation: 0 },
      original: f.base64,
    });
  } finally {
    f.close();
  }
});

it('恢复完整图片保留移动拉伸后九十度方向的可见内容', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0, width: 0.75, height: 1 });
    let image = f.read().images![0]!;
    f.run({ type: 'image.transform', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, pose: { x: 350, y: 200, width: 300, height: 120 } } });
    image = f.read().images![0]!;
    f.run({ type: 'image.rotate', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, direction: 'right' } });
    image = f.read().images![0]!;
    f.run({ type: 'image.crop', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    const restored = f.read().images![0]!;
    expect({ content: restored.content, pose: restored.item.pose }).toEqual({
      content: { assetId: 'original', crop: { x: 0, y: 0, width: 1, height: 1 } },
      pose: { x: 440, y: 10, width: 120, height: 400, rotation: 90 },
    });
  } finally { f.close(); }
});

it('恢复完整图片保留左转九十度后的可见内容并向下展开', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0, width: 0.75, height: 1 });
    let image = f.read().images![0]!;
    f.run({ type: 'image.transform', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, pose: { x: 350, y: 200, width: 300, height: 120 } } });
    image = f.read().images![0]!;
    f.run({ type: 'image.rotate', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, direction: 'left' } });
    image = f.read().images![0]!;
    f.run({ type: 'image.crop', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    const restored = f.read().images![0]!;
    expect({ content: restored.content, pose: restored.item.pose }).toEqual({
      content: { assetId: 'original', crop: { x: 0, y: 0, width: 1, height: 1 } },
      pose: { x: 440, y: 110, width: 120, height: 400, rotation: 270 },
    });
  } finally { f.close(); }
});

it('恢复完整图片保留半周方向的可见内容并向右展开', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0, width: 0.75, height: 1 });
    let image = f.read().images![0]!;
    f.run({ type: 'image.transform', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, pose: { x: 350, y: 200, width: 300, height: 120 } } });
    for (let turn = 0; turn < 2; turn++) {
      image = f.read().images![0]!;
      f.run({ type: 'image.rotate', expected: { image: image.versionId, pose: image.item.versionId },
        payload: { id: image.id, direction: 'right' } });
    }
    image = f.read().images![0]!;
    f.run({ type: 'image.crop', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    const restored = f.read().images![0]!;
    expect({ content: restored.content, pose: restored.item.pose }).toEqual({
      content: { assetId: 'original', crop: { x: 0, y: 0, width: 1, height: 1 } },
      pose: { x: 350, y: 200, width: 400, height: 120, rotation: 180 },
    });
  } finally { f.close(); }
});
