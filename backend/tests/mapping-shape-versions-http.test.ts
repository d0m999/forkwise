import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { ProjectState } from '../src/mapping/contracts.js';

it('真实 TCP HTTP 可读不可变 Shape 和 Pose 旧版本，编辑移动删除恢复及同库重开均不改旧值', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-'));
  let mapping = openMapping(directory);
  const token = mapping.access.issue('human', ['*']);
  let server: ReturnType<typeof serve> | undefined;
  let origin = '';
  async function start() {
    let app: ReturnType<typeof createWorkspaceApp>;
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const port = (server.address() as { port: number }).port;
    origin = `http://127.0.0.1:${port}`;
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    console.log('issue23-http-server', JSON.stringify({ event: 'listening', port, ownerPid: process.pid, inProcess: true }));
  }
  async function stop() {
    if (!server) return;
    const current = server;
    server = undefined;
    const port = (current.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
    console.log('issue23-http-server', JSON.stringify({ event: 'close-callback', port, ownerPid: process.pid, error: null, inProcess: true }));
  }
  async function read(path: string) {
    const response = await fetch(origin + '/api/mapping/projects/p' + path, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return response.json();
  }
  const state = async () => await read('') as ProjectState;
  async function execute(command: Record<string, unknown>) {
    const response = await fetch(origin + '/api/mapping/execute', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), projectId: 'p', ...command }) });
    expect(response.status).toBe(200);
    return response.json();
  }
  try {
    await start();
    await execute({ type: 'project.create', expected: null, payload: { name: '不可变形状版本' } });
    const content = { shapeType: 'rectangle', shortText: '原始观察', fill: '#f4e9b9', stroke: '#403b36', strokeWidth: 2 };
    await execute({ type: 'shape.create', expected: null, payload: { id: 'versioned-shape', content, pose: { x: -40, y: 90, width: 180, height: 100 } } });
    const created = (await state()).shapes![0]!;
    const assertOriginalVersions = async () => {
      expect(await read(`/versions/shape/${created.id}/${created.versionId}`)).toEqual({ id: created.id, versionId: created.versionId, content });
      expect(await read(`/versions/pose/${created.item.id}/${created.item.versionId}`)).toEqual(created.item);
    };
    await assertOriginalVersions();
    const changedContent = { ...content, shortText: '已编辑的观察', fill: '#dce8dd' };
    await execute({ type: 'shape.edit', expected: created.versionId, payload: { id: created.id, content: changedContent } });
    const edited = (await state()).shapes![0]!;
    expect(edited.content).toEqual(changedContent);
    await assertOriginalVersions();
    await execute({ type: 'shape.move', expected: edited.item.versionId, payload: { id: created.id, x: 220, y: -70 } });
    const moved = (await state()).shapes![0]!;
    expect(moved.item.pose).toEqual({ x: 220, y: -70, width: 180, height: 100 });
    await assertOriginalVersions();
    await execute({ type: 'shape.delete', expected: { shape: moved.versionId, pose: moved.item.versionId }, payload: { id: created.id } });
    const deleted = await state();
    expect(deleted.shapes).toEqual([]);
    await assertOriginalVersions();
    await execute({ type: 'history.undo', expected: deleted.project.revision, payload: {} });
    const restored = (await state()).shapes![0]!;
    expect(restored).toMatchObject({ id: created.id, content: changedContent, item: { id: created.item.id, pose: moved.item.pose } });
    await assertOriginalVersions();
    await stop();
    mapping.close();
    mapping = openMapping(directory);
    await start();
    expect((await state()).shapes).toEqual([restored]);
    await assertOriginalVersions();
  } finally {
    await stop();
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
