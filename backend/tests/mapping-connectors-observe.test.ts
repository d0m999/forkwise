import { expect, it } from 'vitest';
import { lifecycleFixture } from './connector-lifecycle-fixture.js';
import type { CanvasConnector } from '../src/mapping/connector-contracts.js';
import type { Receipt } from '../src/mapping/contracts.js';

it('纯普通连线变化完整报告connector域且不伪造project或pose域', () => {
  const f = lifecycleFixture();
  try {
    const a = f.card('a'), b = f.card('b'), baseline = f.state().project.revision;
    const expected: { receipt: Receipt; before: CanvasConnector | null; after: CanvasConnector | null }[] = [];
    const execute = (command: Record<string, unknown>) => {
      const before = f.state().connectors![0] ?? null, receipt = f.run(command), after = f.state().connectors![0] ?? null;
      expected.push({ receipt, before, after });
    };
    execute({ type: 'connector.create', expected: null, payload: { id: 'line', start: f.bound(a.item.id), end: f.bound(b.item.id, 'left') } });
    let line = f.state().connectors![0]!;
    execute({ type: 'connector.path', expected: line.versionId, payload: { id: line.id, path: 'curve' } });
    line = f.state().connectors![0]!;
    execute({ type: 'connector.reconnect', expected: line.versionId, payload: { id: line.id, endpoint: 'end', value: f.free(200, 80) } });
    line = f.state().connectors![0]!;
    execute({ type: 'connector.move', expected: line.versionId, payload: { id: line.id, dx: 20, dy: -10 } });
    line = f.state().connectors![0]!;
    execute({ type: 'connector.delete', expected: line.versionId, payload: { id: line.id } });
    execute({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
    const page = f.mapping.observe({ projectId: 'p', afterRevision: baseline, budget: 65536 }, f.human);
    expect(page.status).toBe('OK'); expect(page.complete).toBe(true); expect(page.changes).toHaveLength(expected.length);
    for (const [index, value] of expected.entries()) {
      expect(page.changes[index]).toMatchObject({ ...value.receipt, connectorChanges: [{ before: value.before, after: value.after }], domains: [{ domain: 'connector', id: 'line' }], deletedIds: value.after ? [] : ['line'] });
      expect(page.changes[index]!.domains).toEqual([{ domain: 'connector', id: 'line' }]);
      expect(page.changes[index]!.before).toBeNull(); expect(page.changes[index]!.after).toBeNull();
      expect(page.changes[index]!.revision).toBe(baseline + index + 1);
    }
    expect(Buffer.byteLength(JSON.stringify(page))).toBe(page.bytes); expect(page.bytes).toBeLessThanOrEqual(65536);
  } finally { f.close(); }
});


function assertCascade(f: ReturnType<typeof lifecycleFixture>, command: Record<string, unknown>, domains: { domain: string; id: string }[], patch: Record<string, unknown>, restoredPatch: () => Record<string, unknown>) {
  const baseline = f.state().project.revision, line = f.state().connectors![0]!;
  const deleted = f.run(command);
  const undone = f.run({ type: 'history.undo', expected: f.state().project.revision, payload: {} });
  const restored = f.state().connectors![0]!;
  const page = f.mapping.observe({ projectId: 'p', afterRevision: baseline, budget: 65536 }, f.human);
  expect(page.changes).toHaveLength(2); expect(page.complete).toBe(true);
  expect(page.changes[0]).toMatchObject({ ...deleted, ...patch, connectorChanges: [{ before: line, after: null }], deletedIds: deleted.deletedIds });
  expect(page.changes[1]).toMatchObject({ ...undone, ...restoredPatch(), connectorChanges: [{ before: null, after: restored }], deletedIds: [] });
  for (const change of page.changes) expect(change.domains).toEqual([...domains, { domain: 'connector', id: line.id }]);
  expect(page.changes[0]!.deletedIds).toContain(line.id); expect(page.changes[0]!.deletedIds).toEqual(deleted.changedIds);
  expect(page.changes[1]!.connectorVersions).toEqual({ [line.id]: restored.versionId });
  expect(Buffer.byteLength(JSON.stringify(page))).toBe(page.bytes); expect(page.bytes).toBeLessThanOrEqual(65536);
}

it('卡片与关联连线的删除撤销在同一observe变化保留全部域', () => {
  const f = lifecycleFixture();
  try {
    const host = f.card('host'), other = f.card('other');
    const line = f.connector('line', f.bound(host.item.id), f.bound(other.item.id));
    const domains = [{ domain: 'thought', id: host.id }, { domain: 'body', id: host.body.id }, { domain: 'pose', id: host.item.id }, ...(host.appearance ? [{ domain: 'appearance', id: host.appearance.id }] : []), ...(host.cardTags ? [{ domain: 'cardTags', id: host.cardTags.id }] : [])];
    assertCascade(f, { type: 'thought.delete', expected: { thought: host.versionId, body: host.body.versionId, pose: host.item.versionId, appearance: host.appearance?.versionId ?? null, cardTags: host.cardTags?.versionId ?? null, connectors: { line: line.versionId } }, payload: { id: host.id } }, domains, { before: host, after: null }, () => ({ before: null, after: f.state().cards.find(value => value.id === host.id)! }));
  } finally { f.close(); }
});


it('形状与关联连线的删除撤销在同一observe变化保留全部域', () => {
  const f = lifecycleFixture();
  try {
    const other = f.card('other');
    f.run({ type: 'shape.create', expected: null, payload: { id: 'host', content: { shapeType: 'ellipse', shortText: '形状' }, pose: { x: 0, y: 0, width: 160, height: 100 } } });
    const host = f.state().shapes![0]!, line = f.connector('line', f.bound(host.item.id), f.bound(other.item.id));
    assertCascade(f, { type: 'shape.delete', expected: { shape: host.versionId, pose: host.item.versionId, connectors: { line: line.versionId } }, payload: { id: host.id } }, [{ domain: 'shape', id: host.id }, { domain: 'pose', id: host.item.id }], { shapeChange: { before: host, after: null } }, () => ({ shapeChange: { before: null, after: f.state().shapes![0]! } }));
  } finally { f.close(); }
});


it('独立文字与关联连线的删除撤销在同一observe变化保留全部域', () => {
  const f = lifecycleFixture();
  try {
    const other = f.card('other');
    f.run({ type: 'text.create', expected: null, payload: { id: 'host', content: { runs: [{ text: '文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 0, y: 0, width: 180, height: 60 } } });
    const host = f.state().texts![0]!, line = f.connector('line', f.bound(host.item.id), f.bound(other.item.id));
    assertCascade(f, { type: 'text.delete', expected: { text: host.versionId, pose: host.item.versionId, connectors: { line: line.versionId } }, payload: { id: host.id } }, [{ domain: 'text', id: host.id }, { domain: 'pose', id: host.item.id }], { textChange: { before: host, after: null } }, () => ({ textChange: { before: null, after: f.state().texts![0]! } }));
  } finally { f.close(); }
});


it('独立图片与关联连线的删除撤销在同一observe变化保留全部域', () => {
  const f = lifecycleFixture();
  try {
    const other = f.card('other');
    const base64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>').toString('base64');
    f.run({ type: 'asset.save', expected: null, payload: { id: 'asset', name: '图片.svg', mime: 'image/svg+xml', base64 } });
    f.run({ type: 'image.create', expected: null, payload: { id: 'host', content: { assetId: 'asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 0, y: 0, width: 120, height: 60, rotation: 0 } } });
    const host = f.state().images![0]!, line = f.connector('line', f.bound(host.item.id), f.bound(other.item.id));
    assertCascade(f, { type: 'image.delete', expected: { image: host.versionId, pose: host.item.versionId, connectors: { line: line.versionId } }, payload: { id: host.id } }, [{ domain: 'image', id: host.id }, { domain: 'pose', id: host.item.id }], { imageChange: { before: host, after: null } }, () => ({ imageChange: { before: null, after: f.state().images![0]! } }));
  } finally { f.close(); }
});
