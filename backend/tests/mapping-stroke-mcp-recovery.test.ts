import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMcpServer, httpTransport } from '../src/mcp-server.js';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { CompactPage, CompactItem, CardIndex, TextIndex, ShapeIndex, StrokeIndex, ImageIndex, DetailChunk } from '../src/mapping/compact-contracts.js';
import type { ObservePage } from '../src/mapping/observe-contracts.js';

it('真实 MCP 固定混合地图变化终点，预算错误与过旧游标仅凭协议恢复信息完整重建六种视图', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-stroke-mcp-recovery-'));
  const mapping = openMapping(directory, { observe: { retentionRevisions: 2 } });
  let http: ReturnType<typeof serve> | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  let client: Client | undefined;
  try {
    const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: 'MCP 全量恢复🧠' } });
    run({ type: 'thought.create', expected: null, payload: { id: 'card', title: '原卡', text: '正文🧠 "引号" \\目录\n'.repeat(200), x: 500, y: 400 } });
    run({ type: 'tag.create', expected: null, payload: { id: 'tag', name: '原标签' } });
    run({ type: 'text.create', expected: null, payload: { id: 'text',
      content: { runs: [{ text: '独立文字😀\n'.repeat(200) }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
      pose: { x: 300, y: 200, width: 160, height: 100 } } });
    run({ type: 'shape.create', expected: null, payload: { id: 'shape',
      content: { shapeType: 'ellipse', shortText: '形状🧠 "文字"\n'.repeat(200), fill: '#dce8dd', stroke: '#403b36', strokeWidth: 2 },
      pose: { x: 100, y: -80, width: 140, height: 120 } } });
    run({ type: 'stroke.create', expected: null, payload: { id: 'long-pen', content: { penKind: 'pen',
      path: Array.from({ length: 2048 }, (_, index) => ({ x: 1 + index / 16, y: 1 + index % 8 })), color: '#123456', width: 2, opacity: 1 },
      pose: { x: -120.5, y: 240.25, width: 132, height: 10 } } });
    run({ type: 'stroke.create', expected: null, payload: { id: 'short-highlighter',
      content: { penKind: 'highlighter', path: [{ x: 6, y: 6 }, { x: 40, y: 6 }, { x: 74, y: 16 }], color: '#ffe08a', width: 12, opacity: 0.4 },
      pose: { x: 80, y: -35, width: 80, height: 22 } } });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>';
    run({ type: 'asset.save', expected: null, payload: { id: 'image-asset', name: '恢复图片.svg', mime: 'image/svg+xml', base64: Buffer.from(svg).toString('base64') } });
    run({ type: 'image.create', expected: null, payload: { id: 'image', content: { assetId: 'image-asset', crop: { x: 0.25, y: 0.125, width: 0.5, height: 0.75 } },
      pose: { x: -40, y: 60, width: 30, height: 40, rotation: 90 } } });
    const r0 = state();
    let app: ReturnType<typeof createWorkspaceApp>;
    http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => { http!.once('listening', resolve); http!.once('error', reject); });
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
    server = createMcpServer(httpTransport(origin, mapping.access.issue('agent', ['p'])));
    client = new Client({ name: 'stroke-recovery-sdk', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    const call = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: { projectId: 'p', ...args } });
    const read = async (args: Record<string, unknown>) => {
      const result = await call('forkwise_read_map', args);
      expect(result.isError).not.toBe(true);
      return (result.structuredContent as { response: CompactPage }).response;
    };
    const observe = async (args: Record<string, unknown>) => {
      const result = await call('forkwise_observe_map', args);
      expect(result.isError).not.toBe(true);
      return (result.structuredContent as { response: ObservePage }).response;
    };
    const assertBytes = (page: { bytes: number; budgetUnit: string }, budget: number) => {
      expect(page.budgetUnit).toBe('utf8_bytes');
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
      expect(page.bytes).toBeLessThanOrEqual(budget);
    };
    const root = await read({ view: 'index', budget: 4096 });
    expect(root).toMatchObject({ revision: r0.project.revision, scope: { types: ['thought'] }, totalItems: 1,
      coverage: { start: 0, end: 1, complete: true }, items: [{ id: 'card', type: 'thought' }] });
    assertBytes(root, 4096);
    const highlighter = r0.strokes!.find(value => value.id === 'short-highlighter')!;
    const deleted = run({ type: 'stroke.delete', expected: { stroke: highlighter.versionId, pose: highlighter.item.versionId }, payload: { id: highlighter.id } });
    const r1 = state();
    const undone = run({ type: 'history.undo', expected: r1.project.revision, payload: {} });
    const r2 = state();
    const first = await observe({ afterRevision: r0.project.revision, baseSnapshot: root.snapshot, limit: 1, budget: 16384 });
    expect(first).toMatchObject({ status: 'OK', revision: r2.project.revision, afterRevision: r0.project.revision,
      nextRevision: r1.project.revision, complete: false, changes: [{ ...deleted, strokeChange: { before: highlighter, after: null } }] });
    assertBytes(first, 16384);
    const pen = r2.strokes!.find(value => value.id === 'long-pen')!;
    run({ type: 'stroke.delete', expected: { stroke: pen.versionId, pose: pen.item.versionId }, payload: { id: pen.id } });
    const r3 = state();
    const last = await observe({ afterRevision: first.nextRevision, snapshot: first.snapshot, limit: 1, budget: 16384 });
    expect(last).toMatchObject({ status: 'OK', snapshot: first.snapshot, revision: r2.project.revision,
      afterRevision: r1.project.revision, nextRevision: r2.project.revision, complete: true,
      changes: [{ ...undone, strokeChange: { before: null, after: r2.strokes!.find(value => value.id === highlighter.id)! } }] });
    assertBytes(last, 16384);
    const tooLarge = await call('forkwise_observe_map', { afterRevision: r2.project.revision, baseSnapshot: first.snapshot, limit: 1, budget: 4096 });
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.content).toEqual([{ type: 'text', text: 'ITEM_EXCEEDS_BUDGET: 不可拆变化超过预算，请按固定快照完整重读' }]);
    expect(tooLarge.structuredContent).toMatchObject({ error: { status: 413, code: 'ITEM_EXCEEDS_BUDGET',
      message: '不可拆变化超过预算，请按固定快照完整重读', details: { budgetUnit: 'utf8_bytes', requiredBytes: expect.any(Number),
        recovery: { type: 'map', view: 'index', projectId: 'p', snapshot: expect.any(String) } } } });
    const error = (tooLarge.structuredContent as { error: { details: { requiredBytes: number; recovery: { snapshot: string } } } }).error;
    expect(error.details.requiredBytes).toBeGreaterThan(4096);
    const recoveryR3 = error.details.recovery.snapshot;
    run({ type: 'history.undo', expected: r3.project.revision, payload: {} });
    const r4 = state();
    const tools = (await client.listTools()).tools;
    const readTool = tools.find(value => value.name === 'forkwise_read_map');
    expect(readTool?.annotations?.readOnlyHint).toBe(true);
    expect(readTool?.inputSchema).toMatchObject({ properties: {
      view: { enum: expect.arrayContaining(['index', 'tags', 'text-index', 'shape-index', 'stroke-index', 'stroke-detail', 'image-index', 'image-detail']) },
      strokeId: { type: 'string' }, imageId: { type: 'string' } } });
    const pages = async (snapshot: string, revision: number, view: string, extra: Record<string, unknown> = {}) => {
      const items: CompactItem[] = [];
      let cursor: string | undefined;
      let total: number | undefined;
      do {
        const page = await read({ view, snapshot, budget: 4096, ...extra, ...(cursor ? { cursor } : {}) });
        assertBytes(page, 4096);
        expect(page.snapshot).toBe(snapshot);
        expect(page.revision).toBe(revision);
        expect(page.project.revision).toBe(revision);
        expect(page.availability).toBe('available');
        total ??= page.totalItems;
        expect(page.totalItems).toBe(total);
        expect(page.coverage).toEqual({ start: items.length, end: items.length + page.items.length, complete: page.nextCursor === null });
        if (page.nextCursor) expect(page.items.length).toBeGreaterThan(0);
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(items).toHaveLength(total!);
      return items;
    };
    const detail = async (snapshot: string, revision: number, view: string, extra: Record<string, unknown>) => {
      const chunks = await pages(snapshot, revision, view, extra) as DetailChunk[];
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.chunkIndex).toBe(index);
        expect(chunk.chunkCount).toBe(chunks.length);
        expect(Array.from(chunk.jsonText).length).toBeLessThanOrEqual(128);
      }
      return JSON.parse(chunks.map(value => value.jsonText).join(''));
    };
    const rebuild = async (snapshot: string, revision: number) => {
      const base = await read({ view: 'index', snapshot, budget: 4096 });
      const cardIndex = await pages(snapshot, revision, 'index') as CardIndex[];
      const tags = await pages(snapshot, revision, 'tags');
      const texts = await pages(snapshot, revision, 'text-index') as TextIndex[];
      const shapes = await pages(snapshot, revision, 'shape-index') as ShapeIndex[];
      const strokes = await pages(snapshot, revision, 'stroke-index') as StrokeIndex[];
      const images = await pages(snapshot, revision, 'image-index') as ImageIndex[];
      const cards = await Promise.all(cardIndex.map(async value => {
        const { type: _, order: __, body, ...metadata } = value;
        const full = await detail(snapshot, revision, 'detail', { cardId: value.id });
        expect(full).toMatchObject({ id: body.id, versionId: body.versionId });
        return { ...metadata, body: full };
      }));
      const expand = async (values: (TextIndex | ShapeIndex | StrokeIndex | ImageIndex)[], kind: 'text' | 'shape' | 'stroke' | 'image') => Promise.all(values.map(async value => {
        expect(value.content.availability).toBe('not_fetched');
        const full = await detail(snapshot, revision, kind + '-detail', { [kind + 'Id']: value.id });
        expect(full).toMatchObject({ id: value.id, versionId: value.versionId });
        if (kind === 'stroke') expect(full.content.path).toHaveLength((value as StrokeIndex).content.pointCount);
        return { kind, ...full, item: value.item };
      }));
      return { project: base.project, cards, tags, texts: await expand(texts, 'text'), shapes: await expand(shapes, 'shape'), strokes: await expand(strokes, 'stroke'), images: await expand(images, 'image') };
    };
    expect(await rebuild(first.snapshot, r2.project.revision)).toEqual(r2);
    expect(await rebuild(recoveryR3, r3.project.revision)).toEqual(r3);
    const reset = await observe({ afterRevision: r0.project.revision, baseSnapshot: root.snapshot, limit: 1, budget: 4096 });
    expect(reset).toMatchObject({ status: 'RESET_REQUIRED', reason: 'CURSOR_TOO_OLD', revision: r4.project.revision,
      nextRevision: r4.project.revision, complete: true, changes: [],
      recovery: { type: 'map', view: 'index', projectId: 'p', snapshot: reset.snapshot } });
    assertBytes(reset, 4096);
    const rebuiltR4 = await rebuild(reset.recovery!.snapshot, r4.project.revision);
    const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    expect({ ...rebuiltR4, strokes: [...rebuiltR4.strokes].sort(byId) }).toEqual({ ...r4, strokes: [...r4.strokes!].sort(byId) });
    expect(state()).toEqual(r4);
  } finally {
    await client?.close();
    await server?.close();
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
