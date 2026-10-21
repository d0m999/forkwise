import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { ProjectState, Receipt } from '../src/mapping/contracts.js';
import type { CanvasStroke } from '../src/mapping/stroke-contracts.js';

type VersionedReceipt = Receipt & { strokeVersions?: { stroke: string; pose: string } };

it('真实 HTTP 精确读取不可变笔迹和 Pose 版本，历史恢复、回执重放、授权边界及同库重启保持', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-stroke-versions-'));
  let mapping = openMapping(directory);
  const token = mapping.access.issue('human', ['*']);
  const projectReader = mapping.access.issue('agent', ['p']);
  const otherReader = mapping.access.issue('agent', ['other']);
  let server: ReturnType<typeof serve> | undefined;
  let origin = '';
  async function start() {
    let app: ReturnType<typeof createWorkspaceApp>;
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
  }
  async function stop() {
    if (!server) return;
    const current = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
  async function get(path: string, status = 200, auth: string | null = token) {
    const response = await fetch(origin + '/api/mapping/projects/' + path, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
    const value = await response.json();
    expect(response.status).toBe(status);
    return value;
  }
  const state = async (projectId = 'p') => await get(projectId) as ProjectState;
  async function execute(command: Record<string, unknown>): Promise<VersionedReceipt> {
    const response = await fetch(origin + '/api/mapping/execute', {
      method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), projectId: 'p', ...command }),
    });
    const value = await response.json();
    expect(response.status).toBe(200);
    return value;
  }
  const records: { path: string; value: unknown }[] = [];
  const remember = (stroke: CanvasStroke, content: unknown) => {
    records.push({ path: `p/versions/stroke/${stroke.id}/${stroke.versionId}`, value: { id: stroke.id, versionId: stroke.versionId, content } });
    records.push({ path: `p/versions/pose/${stroke.item.id}/${stroke.item.versionId}`, value: stroke.item });
  };
  const assertVersions = async () => {
    for (const record of records) expect(await get(record.path)).toEqual(record.value);
  };
  const creates: { command: Record<string, unknown>; receipt: VersionedReceipt }[] = [];
  try {
    await start();
    await execute({ type: 'project.create', expected: null, payload: { name: '笔迹版本' } });
    await execute({ projectId: 'other', type: 'project.create', expected: null, payload: { name: '另一项目' } });
    await execute({ projectId: 'other', type: 'stroke.create', expected: null, payload: {
      id: 'other-stroke', content: { penKind: 'pen', path: [{ x: 1, y: 1 }, { x: 9, y: 9 }], color: '#654321', width: 2, opacity: 1 },
      pose: { x: 500, y: 600, width: 10, height: 10 },
    } });
    const other = (await state('other')).strokes![0]!;
    const inputs = [
      { id: 'versioned-pen', content: { penKind: 'pen', path: [{ x: 1, y: 1 }, { x: 21.25, y: 6.5 }, { x: 39, y: 19 }], color: '#123456', width: 2, opacity: 1 }, pose: { x: -110.5, y: 260.25, width: 40, height: 20 } },
      { id: 'versioned-highlighter', content: { penKind: 'highlighter', path: [{ x: 6, y: 6 }, { x: 40, y: 6 }, { x: 74, y: 16 }], color: '#ffe08a', width: 12, opacity: 0.4 }, pose: { x: 80, y: -35, width: 80, height: 22 } },
    ];
    for (const input of inputs) {
      const command = { commandId: randomUUID(), projectId: 'p', type: 'stroke.create', expected: null, payload: input };
      const receipt = await execute(command);
      creates.push({ command, receipt });
      const created = (await state()).strokes!.find(stroke => stroke.id === input.id)!;
      expect(created.content).toEqual(input.content);
      expect(created.item.pose).toEqual(input.pose);
      remember(created, input.content);
      await assertVersions();
      expect(receipt.strokeVersions).toEqual({ stroke: created.versionId, pose: created.item.versionId });

      await execute({ type: 'history.undo', expected: (await state()).project.revision, payload: {} });
      expect((await state()).strokes!.find(stroke => stroke.id === input.id)).toBeUndefined();
      await assertVersions();
      const redo = await execute({ type: 'history.redo', expected: (await state()).project.revision, payload: {} });
      const redone = (await state()).strokes!.find(stroke => stroke.id === input.id)!;
      expect(redone).toMatchObject({ id: created.id, content: input.content, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose: input.pose } });
      expect(redone.versionId).not.toBe(created.versionId);
      expect(redone.item.versionId).not.toBe(created.item.versionId);
      expect(redo.strokeVersions).toEqual({ stroke: redone.versionId, pose: redone.item.versionId });
      remember(redone, input.content);
      await assertVersions();

      await execute({ type: 'stroke.delete', expected: { stroke: redone.versionId, pose: redone.item.versionId }, payload: { id: input.id } });
      expect((await state()).strokes!.find(stroke => stroke.id === input.id)).toBeUndefined();
      await assertVersions();
      const undo = await execute({ type: 'history.undo', expected: (await state()).project.revision, payload: {} });
      const restored = (await state()).strokes!.find(stroke => stroke.id === input.id)!;
      expect(restored).toMatchObject({ id: created.id, content: input.content, item: { id: created.item.id, createdOrder: created.item.createdOrder, pose: input.pose } });
      expect(restored.versionId).not.toBe(redone.versionId);
      expect(restored.item.versionId).not.toBe(redone.item.versionId);
      expect(undo.strokeVersions).toEqual({ stroke: restored.versionId, pose: restored.item.versionId });
      remember(restored, input.content);
      await assertVersions();
      const beforeReplay = await state();
      const historyBeforeReplay = await get('p/history');
      expect(await execute(command)).toEqual(receipt);
      expect(await state()).toEqual(beforeReplay);
      expect(await get('p/history')).toEqual(historyBeforeReplay);
      await assertVersions();
    }
    const first = (await state()).strokes![0]!;
    const valid = `p/versions/stroke/${first.id}/${first.versionId}`;
    expect(await get(valid, 401, null)).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await get(valid, 403, otherReader)).toMatchObject({ code: 'PROJECT_FORBIDDEN' });
    expect(await get(valid, 200, projectReader)).toEqual({ id: first.id, versionId: first.versionId, content: first.content });
    for (const mismatch of [
      `stroke/${first.item.id}/${first.versionId}`,
      `stroke/${first.id}/${first.item.versionId}`,
      `pose/${first.id}/${first.versionId}`,
      `shape/${first.id}/${first.versionId}`,
      `stroke/${other.id}/${other.versionId}`,
      `pose/${other.item.id}/${other.item.versionId}`,
      `stroke/${first.id}/unrecorded-version`,
    ]) expect(await get('p/versions/' + mismatch, 404, projectReader)).toMatchObject({ code: 'NOT_FOUND' });

    const beforeReopen = await state();
    const otherBeforeReopen = await state('other');
    const historyBeforeReopen = await get('p/history');
    await stop();
    mapping.close();
    mapping = openMapping(directory);
    await start();
    expect(await state()).toEqual(beforeReopen);
    expect(await state('other')).toEqual(otherBeforeReopen);
    await assertVersions();
    for (const create of creates) expect(await execute(create.command)).toEqual(create.receipt);
    expect(await state()).toEqual(beforeReopen);
    expect(await get('p/history')).toEqual(historyBeforeReopen);
    await assertVersions();
  } finally {
    await stop();
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
