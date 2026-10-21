import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { DetailChunk } from '../src/mapping/compact-contracts.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

it('形状长 Unicode 与转义内容按固定版本无损分页，编辑删除不污染旧页且明确区分已删除与未存在', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue23-shape-detail-'));
  const mapping = openMapping(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => mapping.close());
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  run({ type: 'project.create', expected: null, payload: { name: '无损形状版本' } });
  const content = { shapeType: 'ellipse', shortText: '中文🧠😀 "引号" \\目录\n换行\t制表\r回车\u0000尾'.repeat(10000),
    fill: '#fef3c7', stroke: '#92400e', strokeWidth: 2 };
  expect(content.shortText.length).toBeGreaterThan(200000);
  run({ type: 'shape.create', expected: null, payload: { id: 's', content, pose: { x: -50, y: 80, width: 160, height: 100 } } });
  const original = state().shapes![0]!;
  const root = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  const budget = 32768;
  const query = { type: 'map' as const, view: 'shape-detail' as const, projectId: 'p', shapeId: 's', snapshot: root.snapshot, budget };
  const first = mapping.read(query, human);
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(first.totalItems).toBeGreaterThan(first.items.length);
  run({ type: 'shape.edit', expected: original.versionId, payload: { id: 's', content: { ...content, shortText: '后来编辑', fill: '#dbeafe' } } });
  const edited = state().shapes![0]!;
  run({ type: 'shape.delete', expected: { shape: edited.versionId, pose: edited.item.versionId }, payload: { id: 's' } });
  expect(state().shapes).toEqual([]);

  const chunks: DetailChunk[] = [];
  let page = first;
  let pageCount = 0;
  for (;;) {
    pageCount++;
    expect(page).toMatchObject({ scope: { types: ['shape'] }, snapshot: root.snapshot, revision: root.revision,
      fidelity: 'lossless_json_chunks', availability: 'available', target: { shapeId: 's', versionId: original.versionId }, budgetUnit: 'utf8_bytes' });
    expect(page.totalItems).toBe(first.totalItems);
    expect(page.coverage.start).toBe(chunks.length);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.coverage.end).toBe(chunks.length + page.items.length);
    expect(page.coverage.complete).toBe(page.nextCursor === null);
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBe(page.bytes);
    expect(page.bytes).toBeLessThanOrEqual(budget);
    for (const chunk of page.items)
      expect(chunk).toMatchObject({ id: 's', chunkIndex: chunks.length + page.items.indexOf(chunk), chunkCount: first.totalItems, jsonText: expect.any(String) });
    chunks.push(...page.items as DetailChunk[]);
    if (!page.nextCursor) break;
    page = mapping.read({ ...query, cursor: page.nextCursor }, human);
  }
  expect(pageCount).toBeGreaterThan(1);
  expect(chunks).toHaveLength(first.totalItems);
  expect(JSON.parse(chunks.map(chunk => chunk.jsonText).join(''))).toEqual({ id: 's', versionId: original.versionId, content });
  expect(mapping.read(query, human)).toEqual(first);
  const currentRoot = mapping.read({ type: 'map', view: 'index', projectId: 'p' }, human);
  expect(currentRoot.revision).toBe(4);
  expect(currentRoot.snapshot).not.toBe(root.snapshot);
  const deleted = mapping.read({ ...query, snapshot: currentRoot.snapshot }, human);
  const absent = mapping.read({ ...query, snapshot: currentRoot.snapshot, shapeId: 'never-existed' }, human);
  expect(deleted).toMatchObject({ availability: 'deleted', revision: 4, target: { shapeId: 's' }, totalItems: 0, items: [], nextCursor: null, coverage: { start: 0, end: 0, complete: true } });
  expect(absent).toMatchObject({ availability: 'not_found', revision: 4, target: { shapeId: 'never-existed' }, totalItems: 0, items: [], nextCursor: null, coverage: { start: 0, end: 0, complete: true } });
  for (const empty of [deleted, absent]) {
    expect(empty.snapshot).toBe(currentRoot.snapshot);
    expect(empty.budgetUnit).toBe('utf8_bytes');
    expect(Buffer.byteLength(JSON.stringify(empty), 'utf8')).toBe(empty.bytes);
    expect(empty.bytes).toBeLessThanOrEqual(budget);
  }
});
