import { expect, it } from 'vitest';
import { imageFixture } from './canvas-image-fixture.js';
import { rmSync } from 'node:fs';
import { openMapping } from '../src/mapping/storage.js';

it('一次裁剪由项目统一历史完整撤销重做内容和几何', () => {
  const f = imageFixture();
  try {
    f.create();
    const original = f.read().images![0]!;
    f.run({ type: 'image.crop', expected: { image: original.versionId, pose: original.item.versionId },
      payload: { id: original.id, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } });
    const cropped = f.read().images![0]!;
    const actions = f.host.read({ type: 'history', projectId: 'p' }, f.human);
    f.run({ type: 'history.undo', expected: f.read().project.revision, payload: {} });
    const undone = f.read().images![0]!;
    f.run({ type: 'history.redo', expected: f.read().project.revision, payload: {} });
    const redone = f.read().images![0]!;
    expect({
      actions: actions.undo.map(action => action.label),
      undone: { id: undone.id, itemId: undone.item.id, content: undone.content, pose: undone.item.pose },
      redone: { id: redone.id, itemId: redone.item.id, content: redone.content, pose: redone.item.pose },
      freshUndoVersions: undone.versionId !== original.versionId && undone.item.versionId !== original.item.versionId,
      freshRedoVersions: redone.versionId !== cropped.versionId && redone.item.versionId !== cropped.item.versionId,
      original: f.host.read({ type: 'asset', projectId: 'p', id: 'original' }, f.human).base64,
    }).toEqual({
      actions: ['image.create', 'image.crop'],
      undone: { id: original.id, itemId: original.item.id, content: original.content, pose: original.item.pose },
      redone: { id: original.id, itemId: original.item.id,
        content: { assetId: 'original', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
        pose: { x: -10, y: 300, width: 180, height: 120, rotation: 0 } },
      freshUndoVersions: true,
      freshRedoVersions: true,
      original: f.base64,
    });
  } finally { f.close(); }
});

it('真实SQLite重开保留裁剪后项目全状态和不可变原件', () => {
  const f = imageFixture();
  let closed = false;
  let reopened: ReturnType<typeof openMapping> | undefined;
  try {
    f.create();
    const image = f.read().images![0]!;
    f.run({ type: 'image.crop', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } });
    const before = f.read();
    f.host.close();
    closed = true;
    reopened = openMapping(f.directory);
    const human = reopened.access.authenticate(f.token);
    expect({
      project: reopened.read({ type: 'project', projectId: 'p' }, human),
      original: reopened.read({ type: 'asset', projectId: 'p', id: 'original' }, human).base64,
    }).toEqual({ project: before, original: f.base64 });
  } finally {
    if (closed) {
      reopened?.close();
      rmSync(f.directory, { recursive: true, force: true });
    } else f.close();
  }
});

it('原裁剪命令重复送达复用回执且不再增加状态或历史', () => {
  const f = imageFixture();
  try {
    f.create();
    const image = f.read().images![0]!;
    const command = {
      commandId: 'fixed-crop-retry', type: 'image.crop',
      expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
    };
    const receipt = f.run(command);
    const before = f.read();
    const history = f.host.read({ type: 'history', projectId: 'p' }, f.human);
    const retry = f.run(command);
    expect({ retry, project: f.read(), history: f.host.read({ type: 'history', projectId: 'p' }, f.human) })
      .toEqual({ retry: receipt, project: before, history });
  } finally { f.close(); }
});

it('裁剪依据的图片版本过时则原子拒绝且保持项目与历史', () => {
  const f = imageFixture();
  try {
    f.create();
    const original = f.read().images![0]!;
    f.run({ type: 'image.crop', expected: { image: original.versionId, pose: original.item.versionId },
      payload: { id: original.id, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } });
    const before = f.read();
    const history = f.host.read({ type: 'history', projectId: 'p' }, f.human);
    const image = before.images![0]!;
    let error: string | undefined;
    try {
      f.run({ type: 'image.crop', expected: { image: original.versionId, pose: image.item.versionId },
        payload: { id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    } catch (failure) { error = (failure as { code?: string }).code; }
    expect({ error, project: f.read(), history: f.host.read({ type: 'history', projectId: 'p' }, f.human) })
      .toEqual({ error: 'VERSION_CONFLICT', project: before, history });
  } finally { f.close(); }
});

it('裁剪依据的布局版本过时则原子拒绝且保持项目与历史', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0, width: 0.75, height: 1 });
    const original = f.read().images![0]!;
    f.run({ type: 'image.transform', expected: { image: original.versionId, pose: original.item.versionId },
      payload: { id: original.id, pose: { x: 350, y: 200, width: 300, height: 120 } } });
    const before = f.read();
    const history = f.host.read({ type: 'history', projectId: 'p' }, f.human);
    const image = before.images![0]!;
    let error: string | undefined;
    try {
      f.run({ type: 'image.crop', expected: { image: image.versionId, pose: original.item.versionId },
        payload: { id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    } catch (failure) { error = (failure as { code?: string }).code; }
    expect({ error, project: f.read(), history: f.host.read({ type: 'history', projectId: 'p' }, f.human) })
      .toEqual({ error: 'VERSION_CONFLICT', project: before, history });
  } finally { f.close(); }
});

it('裁剪内容与姿态按observe同revision快照公开投影且不混入后写', () => {
  const f = imageFixture();
  try {
    f.create();
    const before = f.read();
    const image = before.images![0]!;
    f.run({ type: 'image.crop', expected: { image: image.versionId, pose: image.item.versionId },
      payload: { id: image.id, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } });
    const cropped = f.read().images![0]!;
    const delta = f.host.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
    f.run({ type: 'image.transform', expected: { image: cropped.versionId, pose: cropped.item.versionId },
      payload: { id: cropped.id, pose: { x: 900, y: 700, width: 540, height: 80 } } });
    const root = f.host.read({ type: 'map', projectId: 'p', view: 'index', snapshot: delta.snapshot }, f.human);
    const index = f.host.read({ type: 'map', projectId: 'p', view: 'image-index', snapshot: delta.snapshot }, f.human);
    const detail = f.host.read({ type: 'map', projectId: 'p', view: 'image-detail', imageId: cropped.id, snapshot: delta.snapshot }, f.human);
    const chunks = detail.items as { jsonText: string }[];
    expect({
      revision: delta.revision,
      revisions: [root.revision, index.revision, detail.revision],
      sameSnapshot: [root.snapshot, index.snapshot, detail.snapshot].every(value => value === delta.snapshot),
      changes: delta.changes.map(change => change.domains),
      indexed: index.items[0],
      detailed: JSON.parse(chunks.map(chunk => chunk.jsonText).join('')),
    }).toEqual({
      revision: before.project.revision + 1,
      revisions: [before.project.revision + 1, before.project.revision + 1, before.project.revision + 1],
      sameSnapshot: true,
      changes: [[{ domain: 'image', id: cropped.id }, { domain: 'pose', id: cropped.item.id }]],
      indexed: { id: cropped.id, type: 'image', versionId: cropped.versionId, order: 0, item: cropped.item,
        content: { assetId: 'original', availability: 'not_fetched' } },
      detailed: { id: cropped.id, versionId: cropped.versionId,
        content: { assetId: 'original', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } },
    });
  } finally { f.close(); }
});

it('极小合法裁剪恢复不可表示几何时明确拒绝且所有公开状态不变', () => {
  const f = imageFixture();
  try {
    f.run({ type: 'image.create', expected: null, payload: {
      id: 'picture', content: { assetId: 'original', crop: { x: 0, y: 0, width: 1e-308, height: 1 } },
      pose: { x: 100, y: 80, width: 400, height: 300, rotation: 0 },
    } });
    const image = f.read().images![0]!;
    const read = () => ({
      project: f.read(),
      history: f.host.read({ type: 'history', projectId: 'p' }, f.human),
      imageVersion: f.host.read({ type: 'version', projectId: 'p', domain: 'image', id: image.id, versionId: image.versionId }, f.human),
      poseVersion: f.host.read({ type: 'version', projectId: 'p', domain: 'pose', id: image.item.id, versionId: image.item.versionId }, f.human),
      asset: f.host.read({ type: 'asset', projectId: 'p', id: 'original' }, f.human),
    });
    const before = read();
    let code: string | undefined, status: number | undefined;
    try {
      f.run({ type: 'image.crop', expected: { image: image.versionId, pose: image.item.versionId },
        payload: { id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    } catch (failure) {
      ({ code, status } = failure as { code?: string; status?: number });
    }
    expect({ code, status, saved: read() }).toEqual({ code: 'INVALID_COMMAND', status: 400, saved: before });
  } finally { f.close(); }
});
