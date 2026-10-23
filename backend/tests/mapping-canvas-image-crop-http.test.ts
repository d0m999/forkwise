import { expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { imageFixture } from './canvas-image-fixture.js';
import { createWorkspaceApp } from '../src/mapping/http.js';

it('真实HTTP裁剪共用Mapping版本原件合同，旧版本与越项目原子拒绝', async () => {
  const f = imageFixture(); let http: ReturnType<typeof serve> | undefined;
  try {
    f.create(); const original = f.read().images![0]!;
    f.run({ projectId: 'q', type: 'project.create', expected: null, payload: { name: '隔离项目' } });
    let app: ReturnType<typeof createWorkspaceApp>;
    http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => { http!.once('listening', resolve); http!.once('error', reject); });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    app = createWorkspaceApp(f.host, origin, () => new Response(''));
    const other = f.host.access.issue('human', ['q']);
    const get = async (path: string) => {
      const response = await fetch(origin + '/api/mapping/projects/' + path, { headers: { Authorization: 'Bearer ' + f.token } });
      expect(response.status).toBe(200); return response.json();
    };
    const asset = async () => {
      const response = await fetch(origin + '/api/mapping/projects/p/assets/original/content', { headers: { Authorization: 'Bearer ' + f.token } });
      expect(response.status).toBe(200); return Buffer.from(await response.arrayBuffer()).toString('base64');
    };
    const post = async (command: unknown, token = f.token) => {
      const response = await fetch(origin + '/api/mapping/execute', { method: 'POST',
        headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      return { status: response.status, body: await response.json() };
    };
    const command = { commandId: 'http-crop', projectId: 'p', type: 'image.crop',
      expected: { image: original.versionId, pose: original.item.versionId },
      payload: { id: original.id, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } };
    const result = await post(command); expect(result.status).toBe(200);
    const saved = (await get('p')).images[0];
    expect(await get('p')).toEqual(f.read());
    expect(saved.item.pose).toEqual({ x: -10, y: 300, width: 180, height: 120, rotation: 0 });
    expect(saved.content).toEqual({ assetId: 'original', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
    expect(saved.versionId).not.toBe(original.versionId); expect(saved.item.versionId).not.toBe(original.item.versionId);
    expect(result.body).toMatchObject({ imageVersions: { image: saved.versionId, pose: saved.item.versionId } });
    expect(await get(`p/versions/image/${original.id}/${original.versionId}`)).toEqual({ id: original.id, versionId: original.versionId, content: original.content });
    expect(await get(`p/versions/pose/${original.item.id}/${original.item.versionId}`)).toEqual(original.item);
    expect(await asset()).toBe(f.base64);
    const read = async () => ({ p: await get('p'), pHistory: await get('p/history'), q: await get('q'), qHistory: await get('q/history'), asset: await asset() });
    const stable = await read();
    const stale = await post({ ...command, commandId: 'http-stale', payload: { id: original.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    expect(stale).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } }); expect(await read()).toEqual(stable);
    const fresh = { ...command, commandId: 'http-forbidden', expected: { image: saved.versionId, pose: saved.item.versionId } };
    expect(await post(fresh, other)).toMatchObject({ status: 403, body: { code: 'PROJECT_FORBIDDEN' } }); expect(await read()).toEqual(stable);
    expect(await post({ ...fresh, commandId: 'http-cross-object', projectId: 'q' }, other)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(await read()).toEqual(stable);
  } finally {
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    f.close();
  }
});
