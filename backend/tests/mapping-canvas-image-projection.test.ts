import { expect, it } from 'vitest';
import { imageFixture } from './canvas-image-fixture.js';

it('独立图完整裁剪内容和可见外框按同 snapshot 投影，变化明确报告 image 与 pose 域', () => {
  const f = imageFixture();
  try {
    const revision = f.read().project.revision;
    const crop = { x: 0.25, y: 0.125, width: 0.5, height: 0.75 };
    f.create('picture', crop);
    const value = f.read().images![0]!;
    const root = f.host.read({ type: 'map', projectId: 'p', view: 'index' }, f.human);
    const index = f.host.read({ type: 'map', projectId: 'p', view: 'image-index', snapshot: root.snapshot }, f.human);
    expect(index.revision).toBe(root.revision);
    expect(index.scope.types).toEqual(['image']);
    expect(index.items).toHaveLength(1);
    expect(index.items[0]).toMatchObject({ id: value.id, type: 'image', versionId: value.versionId, item: value.item });
    f.create('later');
    const detail = f.host.read({ type: 'map', projectId: 'p', view: 'image-detail', imageId: value.id, snapshot: root.snapshot }, f.human);
    expect(detail.revision).toBe(root.revision);
    expect(detail.snapshot).toBe(root.snapshot);
    expect(JSON.parse(detail.items.map((chunk: any) => chunk.jsonText).join(''))).toEqual({ id: value.id, versionId: value.versionId, content: value.content });
    const delta = f.host.observe({ projectId: 'p', afterRevision: revision }, f.human).changes[0]!;
    expect(delta.revision).toBe(root.revision);
    expect(delta.domains).toEqual([{ domain: 'image', id: value.id }, { domain: 'pose', id: value.item.id }]);
    expect(delta.changedIds).toEqual([value.id, value.item.id]);
    expect((delta as any).imageChange).toEqual({ before: null, after: value });
  } finally { f.close(); }
});
