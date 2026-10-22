import { expect, it } from 'vitest';
import { imageFixture } from './canvas-image-fixture.js';

it('图片与卡片混合移动在同revision原子保存和撤销，保旋转裁剪且冲突整组不写', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0.125, width: 0.5, height: 0.75 });
    let image = f.read().images![0]!;
    f.run({ type: 'image.rotate', expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, direction: 'right' } });
    f.run({ type: 'thought.create', expected: null, payload: { id: 'card', title: '同行卡片', text: '原文', x: 10, y: 20 } });
    const before = f.read(); image = before.images![0]!; const card = before.cards[0]!;
    const command = { type: 'canvas.move', expected: { [image.item.id]: image.item.versionId, [card.item.id]: card.item.versionId },
      payload: { targets: [{ kind: 'image', id: image.id, itemId: image.item.id, x: image.item.pose.x + 60, y: image.item.pose.y - 30 },
        { kind: 'card', id: card.id, itemId: card.item.id, x: 70, y: -10 }] } };
    const moved = f.run(command), after = f.read();
    expect(after.project.revision).toBe(before.project.revision + 1);
    expect(after.images![0]).toMatchObject({ content: image.content, versionId: image.versionId,
      item: { pose: { ...image.item.pose, x: image.item.pose.x + 60, y: image.item.pose.y - 30 } } });
    expect(after.cards[0]!.item.pose).toMatchObject({ x: 70, y: -10 });
    const changes = f.host.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human);
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]).toMatchObject({ revision: moved.revision, domains: [{ domain: 'pose', id: card.item.id }, { domain: 'pose', id: image.item.id }] });
    expect(() => f.run(command)).toThrow(); expect(f.read()).toEqual(after);
    f.run({ type: 'history.undo', expected: after.project.revision, payload: {} });
    expect(f.read().images![0]!.item.pose).toEqual(image.item.pose);
    expect(f.read().cards[0]!.item.pose).toEqual(card.item.pose);
    f.run({ type: 'history.redo', expected: f.read().project.revision, payload: {} });
    expect(f.read().images![0]!.item.pose).toEqual(after.images![0]!.item.pose);
  } finally { f.close(); }
});

it('独立图拉伸或移动只推进姿态，撤销重做保裁剪原件，旧版本与相同姿态不造变化', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0.125, width: 0.5, height: 0.75 });
    const original = f.read().images![0]!;
    const expected = { image: original.versionId, pose: original.item.versionId };
    const pose = { x: 10, y: -20, width: 720, height: 120 };
    const command = { type: 'image.transform', expected, payload: { id: original.id, pose } };
    const receipt = f.run(command);
    const edited = f.read().images![0]!;
    expect(edited).toMatchObject({ id: original.id, versionId: original.versionId, content: original.content, item: { id: original.item.id, pose: { ...pose, rotation: 0 } } });
    expect(edited.item.versionId).not.toBe(original.item.versionId);
    expect(receipt.changedIds).toEqual([original.item.id]);
    f.run({ type: 'history.undo', expected: f.read().project.revision, payload: {} });
    expect(f.read().images![0]).toMatchObject({ content: original.content, versionId: original.versionId, item: { pose: original.item.pose } });
    f.run({ type: 'history.redo', expected: f.read().project.revision, payload: {} });
    const redone = f.read().images![0]!;
    const stable = f.read();
    const history = f.host.read({ type: 'history', projectId: 'p' }, f.human);
    expect(() => f.run(command)).toThrow();
    f.run({ ...command, expected: { image: redone.versionId, pose: redone.item.versionId } });
    expect(f.read()).toEqual(stable);
    expect(f.host.read({ type: 'history', projectId: 'p' }, f.human)).toEqual(history);
    expect(f.host.read({ type: 'asset', projectId: 'p', id: 'original' }, f.human).base64).toBe(f.base64);
  } finally { f.close(); }
});

it('删除独立图在同一步移除内容和姿态，撤销恢复原身份及裁剪旋转，原件继续可读', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0.125, width: 0.5, height: 0.75 });
    const original = f.read().images![0]!;
    const removed = f.run({ type: 'image.delete', expected: { image: original.versionId, pose: original.item.versionId }, payload: { id: original.id } });
    expect(f.read().images).toEqual([]);
    expect(removed.deletedIds).toEqual([original.id, original.item.id]);
    const deletedIndex = f.host.read({ type: 'map', projectId: 'p', view: 'image-index' }, f.human);
    expect(deletedIndex.items).toEqual([]);
    expect(f.host.read({ type: 'map', projectId: 'p', view: 'image-detail', imageId: original.id, snapshot: deletedIndex.snapshot }, f.human).availability).toBe('deleted');
    f.run({ type: 'history.undo', expected: f.read().project.revision, payload: {} });
    const restored = f.read().images![0]!;
    expect(restored).toMatchObject({ id: original.id, content: original.content, item: { id: original.item.id, pose: original.item.pose } });
    expect(restored.versionId).not.toBe(original.versionId);
    expect(restored.item.versionId).not.toBe(original.item.versionId);
    f.run({ type: 'history.redo', expected: f.read().project.revision, payload: {} });
    expect(f.read().images).toEqual([]);
    expect(() => f.create('picture')).toThrow();
    expect(f.host.read({ type: 'asset', projectId: 'p', id: 'original' }, f.human).base64).toBe(f.base64);
  } finally { f.close(); }
});

it('已裁剪拉伸图左右每次90度旋转保当前可见中心与内容，交换宽高且一次撤销', () => {
  const f = imageFixture();
  try {
    f.create('picture', { x: 0.25, y: 0.125, width: 0.5, height: 0.75 });
    const original = f.read().images![0]!;
    const rotate = (direction: string) => {
      const value = f.read().images![0]!;
      return f.run({ type: 'image.rotate', expected: { image: value.versionId, pose: value.item.versionId }, payload: { id: value.id, direction } });
    };
    rotate('right');
    expect(f.read().images![0]).toMatchObject({ versionId: original.versionId, content: original.content,
      item: { pose: { x: -40, y: 180, width: 240, height: 360, rotation: 90 } } });
    f.run({ type: 'history.undo', expected: f.read().project.revision, payload: {} });
    expect(f.read().images![0]!.item.pose).toEqual(original.item.pose);
    f.run({ type: 'history.redo', expected: f.read().project.revision, payload: {} });
    rotate('left');
    expect(f.read().images![0]!.item.pose).toEqual(original.item.pose);
    rotate('left');
    expect(f.read().images![0]!.item.pose).toEqual({ x: -40, y: 180, width: 240, height: 360, rotation: 270 });
    expect(f.read().images![0]!.content).toEqual(original.content);
    expect(f.host.read({ type: 'asset', projectId: 'p', id: 'original' }, f.human).base64).toBe(f.base64);
  } finally { f.close(); }
});
