import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { captureSpatial } from '../src/mapping/frame-spatial.js';
import { readZip, writeZip } from '../src/mapping/zip-store.js';
import type { Block } from '../src/mapping/contracts.js';

const tsx = join(import.meta.dirname, '../node_modules/.bin/tsx');
const verifier = join(import.meta.dirname, '../../scripts/verify-package.ts');

function verify(path: string) {
  try {
    const stdout = execFileSync(tsx, [verifier, path], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, stdout: failed.stdout ?? '' };
  }
}

function fingerprint(directory: string) {
  const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
  try {
    const revision = (db.prepare('SELECT revision FROM mapping_projects WHERE id=?').get('p') as { revision: number }).revision;
    const history = db.prepare('SELECT value FROM mapping_history WHERE project_id=?').get('p') as { value: string } | undefined;
    const stack = history ? JSON.parse(history.value) as { undo: unknown[]; redo: unknown[] } : { undo: [], redo: [] };
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    const counts = Object.fromEntries(names.map((name) => [name, (db.prepare(`SELECT count(*) AS count FROM ${name}`).get() as { count: number }).count]));
    const dump = names.map((name) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()));
    return {
      revision,
      historyLength: stack.undo.length + stack.redo.length,
      counts,
      dumpHash: createHash('sha256').update(dump.join('\n')).digest('hex'),
      historyJson: history?.value ?? '',
    };
  } finally {
    db.close();
  }
}

function manifestOf(bytes: Buffer) {
  return JSON.parse(readZip(bytes).get('forkwise-project.json')!.toString('utf8')) as {
    schemaVersion: number;
    exportedAt: string;
    projectId: string;
    revision: number;
    research: unknown;
    mapping: { cards: { body: { blocks: unknown[] } }[]; stored: { cards: { json: string }[] }; history: { undo: { session?: string }[] } };
    resources: { id: string; mime: string; sha256: string; path: string }[];
  };
}

describe('完整项目包', () => {
  it('导出混合画布与旧研究归档，复制后仍能独立验证，且不改源库', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forkwise-package-'));
    const origin = 'http://127.0.0.1:4173';
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>');
    const pdf = Buffer.from('%PDF-1.4\noriginal');
    let mapping = openMapping(directory);
    const token = mapping.access.issue('human', ['*']);
    let human = mapping.access.authenticate(token);
    const execute = (command: unknown) => mapping.execute(command, human);
    const read = () => mapping.read({ type: 'project', projectId: 'p' }, human);
    const frameCommand = (id: string, itemIds: string[], pose: { x: number; y: number; width: number; height: number }, parentId?: string) => {
      const state = read();
      const items = [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? []), ...(state.strokes ?? [])];
      return { commandId: id, projectId: 'p', type: 'frame.create',
        expected: { frame: null, groups: {},
          containment: Object.fromEntries(itemIds.map((itemId) => [itemId, state.containment?.find((row) => row.id === itemId)?.versionId ?? null])),
          poses: Object.fromEntries(itemIds.map((itemId) => [itemId, items.find((value) => value.item.id === itemId)!.item.versionId])) },
        placement: { expected: captureSpatial(state, { rect: pose }) },
        payload: { id, itemIds, pose, ...(parentId ? { parentId } : {}) } };
    };
    try {
      execute({ commandId: 'project', projectId: 'p', type: 'project.create', expected: null, payload: { name: '混合画布' } });
      execute({ commandId: 'card', projectId: 'p', type: 'thought.create', expected: null, payload: { id: 'card-1', title: '长期价值', text: '初始正文', x: 120, y: 160 } });
      execute({ commandId: 'image-asset', projectId: 'p', type: 'asset.save', expected: null, payload: { id: 'asset-image', name: '现金流.svg', mime: 'image/svg+xml', base64: svg.toString('base64') } });
      execute({ commandId: 'file-asset', projectId: 'p', type: 'asset.save', expected: null, payload: { id: 'asset-file', name: '财报原件.pdf', mime: 'application/pdf', base64: pdf.toString('base64'), kind: 'file' } });
      const card = read().cards[0]!;
      execute({ commandId: 'body', projectId: 'p', type: 'body.edit', expected: card.body.versionId, payload: { id: card.id, requiredAssetIds: ['asset-image'], blocks: [
        { id: 'paragraph', type: 'text', text: '这是包含完整已保存内容的长正文。' },
        { id: 'body-image', type: 'image', assetId: 'asset-image', name: '现金流.svg', mime: 'image/svg+xml', naturalWidth: 20, naturalHeight: 10, caption: '现金流图', alt: '绿色现金流示意图' },
        { id: 'table', type: 'table', header: true, rows: [[{ text: '指标' }, { text: '值' }], [{ text: '收入' }, { text: '增长' }]] },
        { id: 'code', type: 'code', language: 'ts', wrap: false, text: 'const kept = true;' },
      ] } });
      execute({ commandId: 'file-attachment', projectId: 'p', type: 'card.attachment.add', expected: { attachments: null }, payload: { id: card.id, assetId: 'asset-file', name: '财报原件.pdf' } });
      execute({ commandId: 'text', projectId: 'p', type: 'text.create', expected: null, payload: { id: 'text-1', content: { runs: [{ text: '随动批注' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 }, pose: { x: 600, y: 140, width: 160, height: 60 } } });
      execute({ commandId: 'shape', projectId: 'p', type: 'shape.create', expected: null, payload: { id: 'shape-1', content: { shapeType: 'rectangle', shortText: '条件成立' }, pose: { x: 260, y: 340, width: 180, height: 100 } } });
      execute({ commandId: 'image', projectId: 'p', type: 'image.create', expected: null, payload: { id: 'image-1', content: { assetId: 'asset-image', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 600, y: 260, width: 120, height: 80, rotation: 0 } } });
      execute({ commandId: 'stroke', projectId: 'p', type: 'stroke.create', expected: null, payload: { id: 'stroke-1', content: { penKind: 'highlighter', path: [{ x: 0, y: 0 }, { x: 80, y: 40 }], color: '#ff0000', width: 12, opacity: 0.35 }, pose: { x: 600, y: 400, width: 100, height: 60 } } });
      const created = read();
      const textItemId = created.texts![0]!.item.id;
      const shapeItemId = created.shapes![0]!.item.id;
      const imageItemId = created.images![0]!.item.id;
      const strokeItemId = created.strokes![0]!.item.id;
      execute(frameCommand('outer', [card.item.id, shapeItemId], { x: 80, y: 100, width: 440, height: 400 }));
      execute(frameCommand('inner', [shapeItemId], { x: 220, y: 300, width: 240, height: 160 }, 'outer'));
      execute({ commandId: 'group', projectId: 'p', type: 'group.create', expected: { groups: { 'group-1': null }, containment: { [imageItemId]: null, [strokeItemId]: null } }, payload: { id: 'group-1', itemIds: [imageItemId, strokeItemId] } });
      execute({ commandId: 'attach', projectId: 'p', type: 'attachment.attach', expected: { attachment: null, target: { itemId: card.item.id, versionId: read().cards[0]!.item.versionId }, containment: null }, payload: { itemId: textItemId, targetItemId: card.item.id } });
      execute({ commandId: 'connector', projectId: 'p', type: 'connector.create', expected: null, payload: { id: 'line-1', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: shapeItemId, side: 'left' }, path: 'straight' } });
      const unknown: Block = { id: 'old-unknown', type: 'vendor-block', original: { vendor: 'legacy', bytes: '完整未知内容\u0000中文', nested: [null, { keep: true }] } };
      const current = read().cards[0]!;
      current.body = { ...current.body, versionId: 'body-unknown', blocks: [...current.body.blocks, unknown] };
      mapping.close();
      const fixture = new Database(join(directory, 'workspace.sqlite'));
      fixture.prepare('UPDATE mapping_cards SET value=? WHERE id=?').run(JSON.stringify(current), 'card-1');
      fixture.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run('p', 'body', current.body.id, current.body.versionId, JSON.stringify(current.body));
      fixture.close();
      mapping = openMapping(directory);
      human = mapping.access.authenticate(token);
      const before = fingerprint(directory);
      const app = createWorkspaceApp(mapping, origin, () => new Response(''));
      const response = await app.fetch(new Request(`${origin}/api/mapping/projects/p/export.package?revision=${before.revision}`, { headers: { Authorization: `Bearer ${token}` } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/zip');
      const bytes = Buffer.from(await response.arrayBuffer());
      const after = fingerprint(directory);
      expect(after.revision).toBe(before.revision);
      expect(after.historyLength).toBe(before.historyLength);
      expect(after.counts).toEqual(before.counts);
      expect(after.dumpHash).toBe(before.dumpHash);

      const isolated = mkdtempSync(join(tmpdir(), 'forkwise-package-copy-'));
      const copied = join(isolated, 'project.zip');
      writeFileSync(copied, bytes);
      const passed = verify(copied);
      expect(passed.status, passed.stdout).toBe(0);
      const manifest = manifestOf(bytes);
      expect(manifest.projectId).toBe('p');
      expect(manifest.revision).toBe(before.revision);
      expect(manifest.research).toBeNull();
      const storedCard = manifest.mapping.stored.cards[0]!.json;
      expect(storedCard).toBe(JSON.stringify(current));
      expect(JSON.parse(storedCard).body.blocks.at(-1)).toEqual(unknown);
      const files = readZip(bytes);
      for (const resource of manifest.resources) {
        expect(resource.path.startsWith('resources/')).toBe(true);
        expect(createHash('sha256').update(files.get(resource.path)!).digest('hex')).toBe(resource.sha256);
      }
      expect(files.get(manifest.resources.find((resource) => resource.id === 'asset-image')!.path)!.equals(svg)).toBe(true);
      expect(files.get(manifest.resources.find((resource) => resource.id === 'asset-file')!.path)!.equals(pdf)).toBe(true);
      expect(JSON.stringify(manifest)).not.toContain(token);
      expect(before.historyJson).toContain('"session"');
      expect(JSON.stringify(manifest.mapping.history)).not.toContain('"session"');
      const first = manifestOf(mapping.fullPackage('p', human, '2026-11-15T00:00:00.000Z'));
      const second = manifestOf(mapping.fullPackage('p', human, '2026-11-15T00:00:01.000Z'));
      const { exportedAt: firstAt, ...firstRest } = first;
      const { exportedAt: secondAt, ...secondRest } = second;
      expect(firstAt).not.toBe(secondAt);
      expect(secondRest).toEqual(firstRest);

      const researchBytes = Buffer.from('legacy-source');
      const research = { format: 'forkwise-project', schemaVersion: 1, exportedAt: '2020-01-01T00:00:00.000Z', project: { id: 'p', name: '旧研究' }, ledgerNote: 'keep-raw', objects: [{ id: 'claim-1', unknownClaim: { keep: true } }], files: [{ id: 'file-1', name: '原件.txt', mime: 'text/plain', hash: createHash('sha256').update(researchBytes).digest('hex'), base64: researchBytes.toString('base64') }] };
      const withResearch = mapping.fullPackage('p', human, '2026-11-15T00:00:02.000Z', research);
      const researchCopy = join(isolated, 'with-research.zip');
      writeFileSync(researchCopy, withResearch);
      const researchResult = verify(researchCopy);
      expect(researchResult.status, researchResult.stdout).toBe(0);
      const researchManifest = manifestOf(withResearch);
      expect(researchManifest.research).toEqual(research);
      const researchResource = researchManifest.resources.find((resource) => resource.id === 'research:file-1')!;
      expect(readZip(withResearch).get(researchResource.path)!.equals(researchBytes)).toBe(true);

      const good = readZip(bytes);
      const missing = new Map(good);
      const removed = manifest.resources[0]!.path;
      missing.delete(removed);
      const missingPath = join(isolated, 'missing.zip');
      writeFileSync(missingPath, writeZip([...missing].map(([name, data]) => ({ name, data }))));
      const missingResult = verify(missingPath);
      expect(missingResult.status).not.toBe(0);
      expect(missingResult.stdout).toContain(`RESOURCE_MISSING ${removed}`);

      const tamperedManifest = structuredClone(manifest);
      tamperedManifest.resources[0]!.sha256 = '0'.repeat(64);
      const tamperedPath = join(isolated, 'tampered.zip');
      writeFileSync(tamperedPath, writeZip([{ name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(tamperedManifest)) }, ...[...good].filter(([name]) => name !== 'forkwise-project.json').map(([name, data]) => ({ name, data }))]));
      const tampered = verify(tamperedPath);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stdout).toContain(`RESOURCE_HASH ${manifest.resources[0]!.path}`);
      expect(tampered.stdout).toContain(`expected=${'0'.repeat(64)}`);

      const bad = structuredClone(manifest);
      bad.schemaVersion = 99;
      const badPath = join(isolated, 'bad-schema.zip');
      writeFileSync(badPath, writeZip([{ name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(bad)) }, ...[...good].filter(([name]) => name !== 'forkwise-project.json').map(([name, data]) => ({ name, data }))]));
      const badResult = verify(badPath);
      expect(badResult.status).not.toBe(0);
      expect(badResult.stdout).toContain('SCHEMA_VERSION schemaVersion expected=2 actual=99');

      const crossed = structuredClone(researchManifest);
      (crossed.research as { project: { id: string } }).project.id = 'other-project';
      const crossedPath = join(isolated, 'crossed.zip');
      const researchFiles = readZip(withResearch);
      writeFileSync(crossedPath, writeZip([{ name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(crossed)) }, ...[...researchFiles].filter(([name]) => name !== 'forkwise-project.json').map(([name, data]) => ({ name, data }))]));
      const crossedResult = verify(crossedPath);
      expect(crossedResult.status).not.toBe(0);
      expect(crossedResult.stdout).toContain('CROSS_PROJECT research.project.id expected=p actual=other-project');

      const rebuild = (target: unknown, name: string, rename?: (entry: string) => string) => {
        const path = join(isolated, name);
        writeFileSync(path, writeZip([
          { name: 'forkwise-project.json', data: Buffer.from(JSON.stringify(target)) },
          ...[...good].filter(([entry]) => entry !== 'forkwise-project.json').map(([entry, data]) => ({ name: rename ? rename(entry) : entry, data })),
        ]));
        return path;
      };
      const ghostAsset = structuredClone(manifest);
      const ghostCard = ghostAsset.mapping.cards[0]! as unknown as { body: { requiredAssetIds?: string[] } };
      ghostCard.body.requiredAssetIds = ['ghost-asset'];
      ghostAsset.mapping.stored.cards[0]!.json = JSON.stringify(ghostCard);
      const ghostResult = verify(rebuild(ghostAsset, 'ghost-asset.zip'));
      expect(ghostResult.status).not.toBe(0);
      expect(ghostResult.stdout).toContain('REFERENCE mapping.cards[0].body.requiredAssetIds[0] expected=resource ghost-asset actual=missing');

      const malformedPath = structuredClone(manifest);
      malformedPath.resources[0]!.path = 'resources/0-short';
      const malformedResult = verify(rebuild(malformedPath, 'malformed-path.zip'));
      expect(malformedResult.status).not.toBe(0);
      expect(malformedResult.stdout).toContain('RESOURCE_PATH resources[0].path expected=resources/<序号>-<sha256> actual=resources/0-short');

      const staleName = structuredClone(manifest);
      const renamed = `resources/0000-${'a'.repeat(64)}`;
      const previousPath = staleName.resources[0]!.path;
      staleName.resources[0]!.path = renamed;
      const staleResult = verify(rebuild(staleName, 'stale-name.zip', (entry) => (entry === previousPath ? renamed : entry)));
      expect(staleResult.status).not.toBe(0);
      expect(staleResult.stdout).toContain(`RESOURCE_PATH resources[0].path expected=resources/<序号>-${manifest.resources[0]!.sha256} actual=${renamed}`);

      expect((await app.fetch(new Request(`${origin}/api/mapping/projects/p/export.package?revision=${before.revision - 1}`, { headers: { Authorization: `Bearer ${token}` } }))).status).toBe(409);
      const denied = mapping.access.issue('agent', ['other']);
      expect((await app.fetch(new Request(`${origin}/api/mapping/projects/p/export.package`, { headers: { Authorization: `Bearer ${denied}` } }))).status).toBe(403);
      rmSync(isolated, { recursive: true, force: true });
    } finally {
      mapping.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
});
