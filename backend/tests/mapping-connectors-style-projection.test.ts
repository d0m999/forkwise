import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { CompactPage, ConnectorIndex, DetailChunk } from '../src/mapping/compact-contracts.js';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import { connectorTransport } from './connector-transport-fixture.js';

it('超过默认读取预算的连线标签经HTTP保存重开后按固定快照无损分页读取', async () => {
  const f = lifecycleFixture({}, '长连线标签投影'), http = connectorTransport(f);
  try {
    const host = f.card('host');
    const line = f.connector('line', f.bound(host.item.id), f.free(400, 300));
    const label = { text: '论证😀\n'.repeat(30_000), position: 0.3, fontSize: 18, color: '#123456', bold: true };
    expect(Buffer.byteLength(label.text)).toBeGreaterThan(131_072);
    await http.start();
    const savedResponse = await fetch(http.origin + '/api/mapping/execute', {
      method: 'POST', headers: { Origin: http.origin, Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: 'long-label', projectId: 'p', type: 'connector.label', expected: line.versionId, payload: { id: line.id, label } }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = f.state().connectors![0]!;
    await http.close(); f.reopen(); await http.start();
    const response = await http.get('/api/mapping/projects/p/map?view=connector-index');
    expect(response.status).toBe(200);
    const index = await response.json() as CompactPage<ConnectorIndex>;
    expect(index.bytes).toBeLessThanOrEqual(131_072);
    expect(index.items).toEqual([{ id: saved.id, versionId: saved.versionId, type: 'connector', order: 0,
      path: saved.path, start: saved.start, end: saved.end, style: saved.style,
      label: { position: label.position, fontSize: label.fontSize, color: label.color, bold: label.bold,
        availability: 'not_fetched', textCodePoints: Array.from(label.text).length, textJsonSha256: createHash('sha256').update(JSON.stringify(label.text)).digest('hex') } }]);
    const chunks: DetailChunk[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const query = new URLSearchParams({ view: 'connector-detail', connectorId: line.id, snapshot: index.snapshot, ...(cursor ? { cursor } : {}) });
      const detailResponse = await http.get('/api/mapping/projects/p/map?' + query);
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json() as CompactPage<DetailChunk>;
      expect(detail.revision).toBe(index.revision); expect(detail.snapshot).toBe(index.snapshot);
      expect(detail.bytes).toBeLessThanOrEqual(131_072);
      expect(detail.coverage.start).toBe(chunks.length);
      chunks.push(...detail.items); cursor = detail.nextCursor; pages++;
      if (pages === 1) f.run({ type: 'connector.label', expected: saved.versionId,
        payload: { id: line.id, label: { ...label, text: '新版本不能混入旧快照' } } });
      if (!cursor) expect(detail.coverage.complete).toBe(true);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(chunks.every((chunk, i) => chunk.id === line.id && chunk.chunkIndex === i && chunk.chunkCount === chunks.length)).toBe(true);
    expect(JSON.parse(chunks.map(chunk => chunk.jsonText).join(''))).toEqual(saved);
    expect(f.state().connectors![0]!.label!.text).toBe('新版本不能混入旧快照');
  } finally { await http.close(); f.close(); }
});

it('连线外观标签在同revision索引详情和增量中完整一致且旧快照不变', () => {
  const f = lifecycleFixture({}, '连线样式投影');
  try {
    let line = f.connector('line', f.free(0, 0), f.free(200, 120));
    f.run({ type: 'connector.style', expected: line.versionId, payload: { id: line.id, style: { startMarker: 'dot', color: '#123abc', dash: 'dashed' } } });
    line = f.state().connectors![0]!;
    const revision = f.state().project.revision;
    const label = { text: '论证\n🧠 "引号" \\ 路径', position: 0.25, fontSize: 18, color: '#403b36', bold: true };
    const labelIndex = { position: label.position, fontSize: label.fontSize, color: label.color, bold: label.bold,
      availability: 'not_fetched', textCodePoints: Array.from(label.text).length, textJsonSha256: createHash('sha256').update(JSON.stringify(label.text)).digest('hex') };
    const receipt = f.run({ type: 'connector.label', expected: line.versionId, payload: { id: line.id, label } });
    const saved = f.state().connectors![0]!;
    const index = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index', budget: 65536 }, f.human);
    expect(index.revision).toBe(receipt.revision);
    expect(index.items).toEqual([{ id: saved.id, versionId: saved.versionId, type: 'connector', order: 0,
      path: saved.path, start: saved.start, end: saved.end, style: saved.style, label: labelIndex }]);
    const query = { type: 'map' as const, projectId: 'p', view: 'connector-detail' as const, connectorId: saved.id, snapshot: index.snapshot, budget: 65536 };
    const detail = f.mapping.read(query, f.human);
    expect(detail.revision).toBe(index.revision);
    expect(JSON.parse((detail.items as DetailChunk[]).map(chunk => chunk.jsonText).join(''))).toEqual(saved);
    const observed = f.mapping.observe({ projectId: 'p', afterRevision: revision, budget: 65536 }, f.human);
    expect(observed.changes).toHaveLength(1);
    expect(observed.changes[0]).toMatchObject({ revision: receipt.revision, connectorChanges: [{ before: line, after: saved }], domains: [{ domain: 'connector', id: 'line' }] });
    f.run({ type: 'connector.path', expected: saved.versionId, payload: { id: saved.id, path: 'curve' } });
    expect(f.state().connectors![0]).toMatchObject({ path: 'curve', start: saved.start, end: saved.end, style: saved.style, label });
    expect(f.mapping.read(query, f.human)).toEqual(detail);
    const fresh = f.mapping.read({ type: 'map', projectId: 'p', view: 'connector-index', budget: 65536 }, f.human);
    expect(fresh.items[0]).toMatchObject({ path: 'curve', style: saved.style, label: labelIndex });
  } finally { f.close(); }
});
