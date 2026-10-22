import { expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { imageFixture } from './canvas-image-fixture.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { CanvasImage } from '../src/mapping/image-contracts.js';

it('真实HTTP读取独立Image不可变版本和Pose，回执重放与删除恢复保历史及权限', async () => {
  const f = imageFixture(); let http: ReturnType<typeof serve> | undefined;
  try {
    const creation = f.create('versioned-image', { x: 0.25, y: 0.125, width: 0.5, height: 0.5 });
    const original = f.read().images![0]!;
    f.run({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '另一项目' } });
    let app: ReturnType<typeof createWorkspaceApp>;
    http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => { http!.once('listening', resolve); http!.once('error', reject); });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    app = createWorkspaceApp(f.host, origin, () => new Response(''));
    const reader = f.host.access.issue('agent', ['p']), forbidden = f.host.access.issue('agent', ['q']);
    async function get(path: string, status = 200, token: string | null = reader) {
      const response = await fetch(origin + '/api/mapping/projects/' + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      expect(response.status).toBe(status); return response.json();
    }
    const records: { path: string; value: unknown }[] = [];
    const remember = (value: CanvasImage) => {
      records.push({ path: `p/versions/image/${value.id}/${value.versionId}`, value: { id: value.id, versionId: value.versionId, content: value.content } });
      records.push({ path: `p/versions/pose/${value.item.id}/${value.item.versionId}`, value: value.item });
    };
    remember(original);
    const versions = async () => { for (const record of records) expect(await get(record.path)).toEqual(record.value); };
    await versions();
    expect(creation).toMatchObject({ imageVersions: { image: original.versionId, pose: original.item.versionId } });
    const command = { commandId: 'fixed-image-transform', type: 'image.transform',
      expected: { image: original.versionId, pose: original.item.versionId },
      payload: { id: original.id, pose: { x: 10, y: 20, width: 720, height: 180 } } };
    const transformed = f.run(command), edited = f.read().images![0]!;
    expect(transformed).toMatchObject({ imageVersions: { image: edited.versionId, pose: edited.item.versionId } });
    remember(edited); await versions();
    const stable = f.read(), history = f.host.read({ type: 'history', projectId: 'p' }, f.human);
    expect(f.run(command)).toEqual(transformed); expect(f.read()).toEqual(stable);
    expect(f.host.read({ type: 'history', projectId: 'p' }, f.human)).toEqual(history);
    f.run({ type: 'image.delete', expected: { image: edited.versionId, pose: edited.item.versionId }, payload: { id: edited.id } });
    await versions();
    const undo = f.run({ type: 'history.undo', expected: f.read().project.revision, payload: {} });
    const restored = f.read().images![0]!; remember(restored); await versions();
    expect(undo).toMatchObject({ imageVersions: { image: restored.versionId, pose: restored.item.versionId } });
    expect(restored.versionId).not.toBe(edited.versionId);
    expect(restored).toMatchObject({ id: edited.id, content: edited.content, item: { pose: edited.item.pose } });
    const path = records[0]!.path;
    expect(await get(path, 401, null)).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await get(path, 403, forbidden)).toMatchObject({ code: 'PROJECT_FORBIDDEN' });
    for (const mismatch of [`p/versions/image/${original.item.id}/${original.versionId}`, `p/versions/image/${original.id}/${original.item.versionId}`,
      `p/versions/shape/${original.id}/${original.versionId}`, `p/versions/image/${original.id}/unknown`, `q/versions/image/${original.id}/${original.versionId}`])
      expect(await get(mismatch, 404, f.token)).toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    f.close();
  }
});
