import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp, EXECUTE_BODY_LIMIT, PACKAGE_MAX_BYTES } from '../src/mapping/http.js';
import { captureSpatial } from '../src/mapping/frame-spatial.js';
import { readZip, writeZip } from '../src/mapping/zip-store.js';
import { verifyPackage } from '../src/mapping/package-verify.js';
import type { Block } from '../src/mapping/contracts.js';

const ISO = '2026-11-15T00:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:4173';

function fingerprint(directory: string) {
  const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    return {
      counts: Object.fromEntries(names.map((name) => [name, (db.prepare(`SELECT count(*) AS count FROM ${name}`).get() as { count: number }).count])),
      dumpHash: createHash('sha256').update(names.map((name) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())).join('\n')).digest('hex'),
    };
  } finally {
    db.close();
  }
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-import-'));
  const mapping = openMapping(directory);
  const token = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(token);
  const execute = (command: unknown) => mapping.execute(command, human);
  const read = (id = 'p') => mapping.read({ type: 'project', projectId: id }, human);
  const app = createWorkspaceApp(mapping, ORIGIN, () => new Response(''));
  const post = async (path: string, body: unknown) =>
    app.fetch(new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    }));
  const close = () => { mapping.close(); rmSync(directory, { recursive: true, force: true }); };
  return { directory, mapping, token, human, execute, read, app, post, close };
}

function seedMixed(fixture: Fixture) {
  const { execute, read } = fixture;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>');
  const pdf = Buffer.from('%PDF-1.4\noriginal-attachment');
  execute({ commandId: 'project', projectId: 'p', type: 'project.create', expected: null, payload: { name: '混合画布' } });
  execute({ commandId: 'card', projectId: 'p', type: 'thought.create', expected: null, payload: { id: 'card-1', title: '长期价值', text: '初始正文', x: 120, y: 160 } });
  execute({ commandId: 'asset-image', projectId: 'p', type: 'asset.save', expected: null, payload: { id: 'asset-image', name: '现金流.svg', mime: 'image/svg+xml', base64: svg.toString('base64') } });
  execute({ commandId: 'asset-file', projectId: 'p', type: 'asset.save', expected: null, payload: { id: 'asset-file', name: '财报原件.pdf', mime: 'application/pdf', base64: pdf.toString('base64'), kind: 'file' } });
  const card = read().cards[0]!;
  const unknown: Block = { id: 'old-unknown', type: 'vendor-block', original: { vendor: 'legacy', bytes: '完整未知内容\u0000中文', nested: [null, { keep: true }], token: 'design-token', assetId: 'vendor-local' }, futureFlag: 42 };
  execute({ commandId: 'body', projectId: 'p', type: 'body.edit', expected: card.body.versionId, payload: { id: card.id, requiredAssetIds: ['asset-image'], blocks: [
    { id: 'paragraph', type: 'text', text: '这是包含完整已保存内容的长正文。' },
    { id: 'body-image', type: 'image', assetId: 'asset-image', name: '现金流.svg', mime: 'image/svg+xml', naturalWidth: 20, naturalHeight: 10, caption: '现金流图', alt: '绿色现金流示意图' },
  ] } });
  {
    const writer = new Database(join(fixture.directory, 'workspace.sqlite'));
    try {
      const row = writer.prepare('SELECT value FROM mapping_cards WHERE id=?').get('card-1') as { value: string };
      const stored = JSON.parse(row.value) as { body: { id: string; versionId: string; blocks: unknown[] } };
      stored.body = { ...stored.body, versionId: 'body-unknown', blocks: [...stored.body.blocks, unknown] };
      writer.prepare('UPDATE mapping_cards SET value=? WHERE id=?').run(JSON.stringify(stored), 'card-1');
      writer.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run('p', 'body', stored.body.id, stored.body.versionId, JSON.stringify(stored.body));
    } finally {
      writer.close();
    }
  }
  execute({ commandId: 'file-attachment', projectId: 'p', type: 'card.attachment.add', expected: { attachments: null }, payload: { id: card.id, assetId: 'asset-file', name: '财报原件.pdf' } });
  execute({ commandId: 'text', projectId: 'p', type: 'text.create', expected: null, payload: { id: 'text-1', content: { runs: [{ text: '随动批注' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 }, pose: { x: 600, y: 140, width: 160, height: 60 } } });
  execute({ commandId: 'shape', projectId: 'p', type: 'shape.create', expected: null, payload: { id: 'shape-1', content: { shapeType: 'rectangle', shortText: '条件成立' }, pose: { x: 260, y: 340, width: 180, height: 100 } } });
  execute({ commandId: 'image', projectId: 'p', type: 'image.create', expected: null, payload: { id: 'image-1', content: { assetId: 'asset-image', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 600, y: 260, width: 120, height: 80, rotation: 0 } } });
  execute({ commandId: 'stroke', projectId: 'p', type: 'stroke.create', expected: null, payload: { id: 'stroke-1', content: { penKind: 'highlighter', path: [{ x: 0, y: 0 }, { x: 80, y: 40 }], color: '#ff0000', width: 12, opacity: 0.35 }, pose: { x: 600, y: 400, width: 100, height: 60 } } });
  const created = read();
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
  execute(frameCommand('outer', [created.cards[0]!.item.id, created.shapes![0]!.item.id], { x: 80, y: 100, width: 440, height: 400 }));
  execute(frameCommand('inner', [created.shapes![0]!.item.id], { x: 220, y: 300, width: 240, height: 160 }, 'outer'));
  execute({ commandId: 'group', projectId: 'p', type: 'group.create', expected: { groups: { 'group-1': null }, containment: { [created.images![0]!.item.id]: null, [created.strokes![0]!.item.id]: null } }, payload: { id: 'group-1', itemIds: [created.images![0]!.item.id, created.strokes![0]!.item.id] } });
  execute({ commandId: 'attach', projectId: 'p', type: 'attachment.attach', expected: { attachment: null, target: { itemId: read().cards[0]!.item.id, versionId: read().cards[0]!.item.versionId }, containment: null }, payload: { itemId: read().texts![0]!.item.id, targetItemId: read().cards[0]!.item.id } });
  execute({ commandId: 'connector', projectId: 'p', type: 'connector.create', expected: null, payload: { id: 'line-1', start: { kind: 'bound', itemId: read().cards[0]!.item.id, side: 'right' }, end: { kind: 'bound', itemId: read().shapes![0]!.item.id, side: 'left' }, path: 'straight' } });
  execute({ commandId: 'tag', projectId: 'p', type: 'tag.create', expected: { cardTags: null }, payload: { id: 'tag-1', name: '风险', cardId: 'card-1' } });
  execute({ commandId: 'appearance', projectId: 'p', type: 'card.appearance', expected: read().cards[0]!.appearance?.versionId ?? null, payload: { id: 'card-1', titleColor: '#f3dfe5', showPreview: true } });
  return { svg, pdf, unknown };
}

function importCommand(base64: string, overrides: Record<string, unknown> = {}) {
  return { commandId: 'import-1', projectId: 'q', type: 'project.import', expected: null, payload: { name: '导入副本', base64 }, ...overrides };
}

function rewriteManifest(bytes: Buffer, mutate: (manifest: Record<string, unknown>) => void) {
  const files = readZip(bytes);
  const manifest = JSON.parse(files.get('forkwise-project.json')!.toString('utf8')) as Record<string, unknown>;
  mutate(manifest);
  files.set('forkwise-project.json', Buffer.from(JSON.stringify(manifest)));
  return writeZip([...files].map(([name, data]) => ({ name, data })));
}

function manifestOf(bytes: Buffer) {
  return JSON.parse(readZip(bytes).get('forkwise-project.json')!.toString('utf8')) as Record<string, any>;
}

function syncMembership(manifest: Record<string, unknown>) {
  const mapping = manifest.mapping as Record<string, any>;
  const members = (kind: string, id: string) =>
    mapping.containment.filter((row: any) => row?.parent?.kind === kind && row.parent.id === id).map((row: any) => String(row.id));
  mapping.membership = {
    frames: mapping.frames.map((frame: any) => ({ id: frame.id, memberItemIds: members('frame', frame.id) })),
    groups: mapping.groups.map((group: any) => ({ id: group.id, memberItemIds: members('group', group.itemId) })),
  };
}

describe('隔离导入完整项目包', () => {
  it('预览不写库；确认后按包内原文建立新项目，源项目与资源不变', async () => {
    const fixture = await makeFixture();
    const { execute, read, mapping, human, post, directory, close } = fixture;
    try {
      const { svg, pdf, unknown } = seedMixed(fixture);
      const bytes = mapping.fullPackage('p', human, ISO);
      expect(verifyPackage(bytes)).toEqual([]);
      const source = read();
      const before = fingerprint(directory);
      const base64 = bytes.toString('base64');

      const previewResponse = await post('/api/mapping/import.preview', { base64 });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as Record<string, any>;
      expect(preview.suggestedName).toBe('混合画布');
      expect(preview.failures).toEqual([]);
      expect(preview.hasResearch).toBe(false);
      expect(preview.counts).toEqual({ cards: 1, texts: 1, shapes: 1, strokes: 1, images: 1, connectors: 1, frames: 2, groups: 1, containment: 5, attachments: 1, tags: 1 });
      expect(preview.resources).toBe(2);
      expect(preview.gaps.join('\n')).toContain('没有旧研究归档');
      expect(fingerprint(directory)).toEqual(before);

      const receipt = execute(importCommand(base64)) as { revision: number; projectId: string };
      expect(receipt.projectId).toBe('q');
      expect(receipt.revision).toBe(1);
      expect(fingerprint(directory).counts.mapping_projects).toBe(before.counts.mapping_projects! + 1);

      const sourceAfter = read();
      expect(sourceAfter).toEqual(source);
      expect(read('q').project).toMatchObject({ id: 'q', name: '导入副本', revision: 1 });

      const manifest = manifestOf(bytes);
      const imported = read('q');
      expect(imported.cards).toHaveLength(1);
      const card = imported.cards[0]!;
      const oldCard = manifest.mapping.cards[0];
      expect(card.id).not.toBe(oldCard.id);
      expect(card.title).toBe(oldCard.title);
      expect(card.body.id).toBe(oldCard.body.id);
      expect(card.item.id).toBe(oldCard.item.id);
      expect(card.body.blocks).toEqual(oldCard.body.blocks);
      expect(card.body.blocks.at(-1)).toEqual(unknown);
      expect(card.attachments!.items[0]!.assetId).toBe('asset-file');
      expect(card.attachments!.id).toBe(`attachments:${card.id}`);
      expect(card.cardTags!.id).toBe(`cardTags:${card.id}`);
      expect(card.appearance!.id).toBe(`appearance:${card.id}`);
      expect(card.cardTags!.tagIds).not.toEqual(oldCard.cardTags.tagIds);
      expect(imported.tags![0]!.id).toBe(card.cardTags!.tagIds[0]);
      expect(imported.texts![0]!.id).not.toBe(manifest.mapping.texts[0].id);
      expect(imported.texts![0]!.item.id).toBe(manifest.mapping.texts[0].item.id);
      expect(imported.shapes![0]!.id).not.toBe(manifest.mapping.shapes[0].id);
      expect(imported.strokes![0]!.id).not.toBe(manifest.mapping.strokes[0].id);
      expect(imported.images![0]!.id).not.toBe(manifest.mapping.images[0].id);
      expect(imported.images![0]!.content.assetId).toBe('asset-image');
      expect(imported.connectors![0]!.id).not.toBe(manifest.mapping.connectors[0].id);
      expect(imported.frames!.find((frame) => frame.name === manifest.mapping.frames[0].name)!.id)
        .not.toBe(manifest.mapping.frames.find((frame: { name: string }) => frame.name === manifest.mapping.frames[0].name)!.id);
      expect(imported.groups![0]!.id).not.toBe(manifest.mapping.groups[0].id);
      expect(imported.groups![0]!.itemId).toBe(manifest.mapping.groups[0].itemId);
      const importedFrameByOldId = new Map<string, string>(manifest.mapping.frames.map((frame: { id: string; name: string }) => [frame.id, imported.frames!.find((value) => value.name === frame.name)!.id]));
      expect(imported.containment!.map((row) => row.id)).toEqual(manifest.mapping.containment.map((row: { id: string }) => importedFrameByOldId.get(row.id) ?? row.id));
      expect(imported.containment!.some((row) => row.id === importedFrameByOldId.get('inner'))).toBe(true);
      expect(imported.attachments!.map((row) => row.id)).toEqual(manifest.mapping.attachments.map((row: { id: string }) => row.id));

      const importedOuter = imported.frames!.find((frame) => frame.id === importedFrameByOldId.get('outer'))!;
      const outerParent = imported.containment!.find((row) => row.id === importedFrameByOldId.get('inner'));
      expect(outerParent!.parent).toEqual({ kind: 'frame', id: importedOuter.id });
      expect(imported.connectors![0]!.start).toEqual(manifest.mapping.connectors[0].start);
      expect(imported.connectors![0]!.end).toEqual(manifest.mapping.connectors[0].end);
      expect(imported.connectors![0]!.versionId).toBe(manifest.mapping.connectors[0].versionId);

      const history = mapping.read({ type: 'history', projectId: 'q' }, human);
      expect(history.undo).toEqual([]);
      expect(history.redo).toEqual([]);

      const reexport = mapping.fullPackage('q', human, ISO, null);
      expect(verifyPackage(reexport)).toEqual([]);
      expect(manifestOf(reexport).research).toBeNull();
      const reexportFiles = readZip(reexport);
      for (const resource of manifestOf(reexport).resources as { id: string; sha256: string; path: string }[]) {
        expect(createHash('sha256').update(reexportFiles.get(resource.path)!).digest('hex')).toBe(resource.sha256);
      }
      const reexportManifest = manifestOf(reexport);
      expect(reexportManifest.mapping.assets.find((asset: { id: string }) => asset.id === 'asset-image').hash)
        .toBe(createHash('sha256').update(svg).digest('hex'));
      expect(reexportManifest.mapping.assets.find((asset: { id: string }) => asset.id === 'asset-file').hash)
        .toBe(createHash('sha256').update(pdf).digest('hex'));
      expect(reexportManifest.mapping.changes).toHaveLength(1);
      expect(reexportManifest.mapping.history).toEqual({ undo: [], redo: [] });
    } finally {
      close();
    }
  }, 30000);

  it('历史版本保留已删除身份，派生卡内身份随新卡号，分区端点与外观撤销可用', async () => {
    const fixture = await makeFixture();
    const { execute, mapping, human, directory, close } = fixture;
    try {
      seedMixed(fixture);
      execute({ commandId: 'frame-line', projectId: 'p', type: 'connector.create', expected: null,
        payload: { id: 'frame-line', start: { kind: 'bound', targetKind: 'frame', itemId: 'outer', side: 'right' }, end: { kind: 'free', point: { x: 20, y: 20 } }, path: 'elbow' } });
      execute({ commandId: 'gone-shape', projectId: 'p', type: 'shape.create', expected: null,
        payload: { id: 'gone-shape', content: { shapeType: 'diamond', shortText: '稍后删除' }, pose: { x: 980, y: 720, width: 120, height: 80 } } });
      const gone = mapping.read({ type: 'project', projectId: 'p' }, human).shapes!.find((shape) => shape.id === 'gone-shape')!;
      execute({ commandId: 'delete-gone', projectId: 'p', type: 'shape.delete', expected: { shape: gone.versionId, pose: gone.item.versionId }, payload: { id: gone.id } });

      const bytes = mapping.fullPackage('p', human, ISO);
      expect(verifyPackage(bytes)).toEqual([]);
      const preview = await (await fixture.post('/api/mapping/import.preview', { base64: bytes.toString('base64') })).json() as Record<string, any>;
      expect(preview.failures).toEqual([]);
      execute(importCommand(bytes.toString('base64')));

      const imported = mapping.read({ type: 'project', projectId: 'q' }, human);
      const card = imported.cards[0]!;
      expect(card.appearance!.id).toBe(`appearance:${card.id}`);
      expect(card.cardTags!.id).toBe(`cardTags:${card.id}`);
      expect(card.attachments!.id).toBe(`attachments:${card.id}`);
      expect(imported.shapes!.some((shape) => shape.id === 'gone-shape')).toBe(false);

      const source = manifestOf(bytes);
      const importedOuter = imported.frames!.find((frame) => frame.name === source.mapping.frames.find((entry: any) => entry.id === 'outer').name)!;
      const frameLine = imported.connectors!.find((connector) => connector.id !== 'line-1' && connector.start.kind === 'bound' && connector.start.targetKind === 'frame')!;
      expect(frameLine.start.kind === 'bound' ? frameLine.start.itemId : null).toBe(importedOuter.id);

      const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
      try {
        const versionCount = (db.prepare('SELECT count(*) AS count FROM mapping_versions WHERE project_id=?').get('q') as { count: number }).count;
        expect(versionCount).toBe((source.mapping.versions as unknown[]).length);
        const historical = db.prepare("SELECT value FROM mapping_versions WHERE project_id='q' AND domain='shape' AND id='gone-shape'").all() as { value: string }[];
        expect(historical.length).toBeGreaterThan(0);
        expect(db.prepare("SELECT 1 FROM mapping_shapes WHERE project_id='q' AND id='gone-shape'").get()).toBeUndefined();
        const cardTagsVersion = db.prepare("SELECT value FROM mapping_versions WHERE project_id='q' AND domain='cardTags' AND id=?").get(`cardTags:${card.id}`) as { value: string } | undefined;
        expect(JSON.parse(cardTagsVersion!.value).tagIds).toEqual(card.cardTags!.tagIds);
        expect(db.prepare("SELECT 1 FROM mapping_versions WHERE project_id='q' AND domain='appearance' AND id=?").get(`appearance:${card.id}`)).toBeTruthy();
        expect(db.prepare("SELECT 1 FROM mapping_versions WHERE project_id='q' AND domain='attachments' AND id=?").get(`attachments:${card.id}`)).toBeTruthy();
      } finally {
        db.close();
      }

      const originalColor = card.appearance!.titleColor;
      execute({ commandId: 'appearance-change', projectId: 'q', type: 'card.appearance', expected: card.appearance!.versionId,
        payload: { id: card.id, titleColor: '#dceee2', showPreview: true } });
      const changed = mapping.read({ type: 'project', projectId: 'q' }, human);
      expect(changed.project.revision).toBe(2);
      expect(changed.cards[0]!.appearance!.titleColor).toBe('#dceee2');
      execute({ commandId: 'appearance-undo', projectId: 'q', type: 'history.undo', expected: 2, payload: {} });
      const undone = mapping.read({ type: 'project', projectId: 'q' }, human);
      expect(undone.project.revision).toBe(3);
      expect(undone.cards[0]!.appearance!.titleColor).toBe(originalColor);
    } finally {
      close();
    }
  }, 30000);

  it('带 v1 研究归档的包只做身份映射，归档随包进出且不送进 ArchiveSchema', async () => {
    const fixture = await makeFixture();
    const { execute, mapping, human, directory, close } = fixture;
    try {
      seedMixed(fixture);
      const researchBytes = Buffer.from('legacy-source');
      const research = {
        format: 'forkwise-project', schemaVersion: 1, exportedAt: '2020-01-01T00:00:00.000Z',
        project: { id: 'p', name: '旧研究', extraIdentity: { keep: true } },
        ledgerNote: 'keep-raw',
        objects: [{ id: 'claim-1', projectId: 'p', unknownClaim: { keep: true, projectId: 'p' } }],
        versions: [{ id: 'snapshot-1', snapshot: { projectId: 'p', note: '旧项目号是历史原文' } }],
        actor: { delegation: { projectId: 'p' } },
        materials: [
          { id: 'material-1', name: '现金流说明', text: '保留的原文' },
          { id: 'material-2', name: '权利受限材料', text: null, omission: '仅保留索引' },
        ],
        files: [
          { id: 'file-1', name: '原件.txt', mime: 'text/plain', hash: createHash('sha256').update(researchBytes).digest('hex'), base64: researchBytes.toString('base64') },
          ...['省略一.txt', '省略二.txt', '省略三.txt', '省略四.txt', '省略五.txt', '省略六.txt'].map((name, index) => ({
            id: `file-${index + 2}`, name, mime: 'text/plain', hash: '0'.repeat(64), base64: null, omission: '旧归档声明省略',
          })),
        ],
      };
      const bytes = rewriteManifest(mapping.fullPackage('p', human, ISO, research), (manifest) => {
        manifest.extensions = { futureReader: { keep: true, note: '本版不解释' } };
      });
      expect(verifyPackage(bytes)).toEqual([]);
      const preview = await (await fixture.post('/api/mapping/import.preview', { base64: bytes.toString('base64') })).json() as Record<string, any>;
      expect(preview.hasResearch).toBe(true);
      expect(preview.failures).toEqual([]);
      expect(preview.extensionKeys).toEqual(['futureReader']);
      expect(preview.gaps.join('\n')).toContain('本版不解释这些扩展：futureReader');
      expect(preview.gaps.join('\n')).toContain('6 份原件未随包提供');
      for (const name of ['省略一.txt', '省略二.txt', '省略三.txt', '省略四.txt', '省略五.txt', '省略六.txt'])
        expect(preview.gaps.join('\n')).toContain(name);
      expect(preview.gaps.join('\n')).toContain('旧归档声明省略');
      expect(preview.gaps.join('\n')).toContain('1 份材料原文未随包提供');
      expect(preview.gaps.join('\n')).toContain('权利受限材料');
      expect(preview.gaps.join('\n')).toContain('仅保留索引');

      execute(importCommand(bytes.toString('base64')));
      const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
      try {
        const row = db.prepare('SELECT research, history, changes, extensions FROM mapping_import_archive WHERE project_id=?').get('q') as { research: string; history: string; changes: string; extensions: string };
        const archived = JSON.parse(row.research) as typeof research;
        const expectedResearch = structuredClone(research);
        expectedResearch.project.id = 'q';
        expect(archived).toEqual(expectedResearch);
        expect(JSON.parse(row.history)).toEqual(manifestOf(bytes).mapping.history);
        expect(JSON.parse(row.changes)).toEqual(manifestOf(bytes).mapping.changes);
        expect(archived.objects[0]!.projectId).toBe('p');
        expect(archived.versions[0]!.snapshot.projectId).toBe('p');
        expect(archived.actor.delegation.projectId).toBe('p');
        expect(archived.files[1]).toEqual(research.files[1]);
        expect(JSON.parse(row.extensions)).toEqual({ futureReader: { keep: true, note: '本版不解释' } });
        expect(db.prepare('SELECT 1 FROM mapping_import_archive WHERE project_id=?').get('p')).toBeUndefined();
      } finally {
        db.close();
      }

      const withoutResearch = mapping.fullPackage('q', human, ISO);
      const manifest = manifestOf(withoutResearch);
      expect((manifest.research as typeof research).project.id).toBe('q');
      expect((manifest.research as typeof research).objects).toEqual(research.objects);
      expect(manifest.extensions).toEqual({ futureReader: { keep: true, note: '本版不解释' } });
      expect(verifyPackage(withoutResearch)).toEqual([]);
      const reexportFiles = readZip(withoutResearch);
      const fileResource = (manifest.resources as { id: string; path: string }[]).find((resource) => resource.id === 'research:file-1')!;
      expect(reexportFiles.get(fileResource.path)!.equals(researchBytes)).toBe(true);
    } finally {
      close();
    }
  }, 30000);

  it('再次导出把旧历史作为不可执行归档随包保留，并按原编辑时间维持排序', async () => {
    const fixture = await makeFixture();
    const { execute, mapping, human, post, close } = fixture;
    try {
      seedMixed(fixture);
      const firstBytes = mapping.fullPackage('p', human, ISO);
      const first = manifestOf(firstBytes);
      expect(first.mapping.archive).toBeNull();
      expect((first.mapping.history.undo as unknown[]).length).toBeGreaterThan(1);
      expect((first.mapping.changes as unknown[]).length).toBeGreaterThan(1);
      const editTimesOf = (manifest: Record<string, any>) =>
        new Map<string, string>((manifest.mapping.editTimes as { cardId: string; editedAt: string }[]).map((row) => [row.cardId, row.editedAt]));
      const sourceEditedAt = editTimesOf(first).get(first.mapping.cards[0].id as string);
      expect(sourceEditedAt).toBeTruthy();

      execute(importCommand(firstBytes.toString('base64')));
      const importedCard = mapping.read({ type: 'project', projectId: 'q' }, human).cards[0]!;
      expect(mapping.read({ type: 'history', projectId: 'q' }, human)).toMatchObject({ undo: [], redo: [] });
      const secondBytes = mapping.fullPackage('q', human, ISO);
      const second = manifestOf(secondBytes);
      expect(second.mapping.archive).toEqual({ history: first.mapping.history, changes: first.mapping.changes });
      expect(second.mapping.history).toEqual({ undo: [], redo: [] });
      expect(editTimesOf(second).get(importedCard.id)).toBe(sourceEditedAt);
      const secondPreview = await (await post('/api/mapping/import.preview', { base64: secondBytes.toString('base64') })).json() as Record<string, any>;
      expect(secondPreview.gaps.join('\n')).toContain('更早的历史归档');

      execute(importCommand(secondBytes.toString('base64'), { commandId: 'import-2', projectId: 'r' }));
      const thirdCard = mapping.read({ type: 'project', projectId: 'r' }, human).cards[0]!;
      const third = manifestOf(mapping.fullPackage('r', human, ISO));
      expect(third.mapping.archive).toEqual(second.mapping.archive);
      expect(editTimesOf(third).get(thirdCard.id)).toBe(sourceEditedAt);
    } finally {
      close();
    }
  }, 30000);

  it('导出响应标注包能否从当前入口恢复，上限与命令请求体一致', async () => {
    const fixture = await makeFixture();
    const { mapping, token, close } = fixture;
    try {
      seedMixed(fixture);
      const response = await fixture.app.fetch(new Request(`${ORIGIN}/api/mapping/projects/p/export.package`, {
        headers: { Authorization: `Bearer ${token}` },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Forkwise-Package-Restorable')).toBe('yes');
      expect(Number(response.headers.get('X-Forkwise-Package-Limit'))).toBe(PACKAGE_MAX_BYTES);
      expect(Buffer.from(await response.arrayBuffer()).length).toBeLessThanOrEqual(PACKAGE_MAX_BYTES);
      const body = (base64: string) => JSON.stringify({
        commandId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        type: 'project.import',
        expected: null,
        payload: { name: '导'.repeat(240), base64 },
      });
      expect(Buffer.byteLength(body('A'.repeat(4 * Math.ceil(PACKAGE_MAX_BYTES / 3))))).toBeLessThanOrEqual(EXECUTE_BODY_LIMIT);
    } finally {
      close();
    }
  }, 30000);

  it('错误哈希、跨项目研究、重复身份和幽灵标签在预览与提交都拒绝，且不建项目', async () => {
    const fixture = await makeFixture();
    const { execute, mapping, human, post, directory, close } = fixture;
    try {
      seedMixed(fixture);
      const good = mapping.fullPackage('p', human, ISO);
      const cases: { name: string; bytes: Buffer; code: string }[] = [];
      const badHash = rewriteManifest(good, (manifest) => {
        (manifest.resources as { sha256: string }[])[0]!.sha256 = '0'.repeat(64);
      });
      cases.push({ name: 'bad-hash', bytes: badHash, code: 'RESOURCE_HASH' });
      const crossed = rewriteManifest(good, (manifest) => {
        (manifest.research as unknown) = { format: 'forkwise-project', schemaVersion: 1, project: { id: 'other' } };
      });
      cases.push({ name: 'crossed-research', bytes: crossed, code: 'CROSS_PROJECT' });
      const duplicated = rewriteManifest(good, (manifest) => {
        const cards = (manifest.mapping as { cards: { id: string }[] }).cards;
        cards.push({ ...cards[0]! });
      });
      cases.push({ name: 'duplicate-card', bytes: duplicated, code: 'DUPLICATE_ID' });
      const ghostTag = rewriteManifest(good, (manifest) => {
        (manifest.mapping as { cards: { cardTags: { tagIds: string[] } }[] }).cards[0]!.cardTags.tagIds = ['ghost-tag'];
      });
      cases.push({ name: 'ghost-tag', bytes: ghostTag, code: 'TAG_REFERENCE' });
      const syncStored = (manifest: Record<string, unknown>, name: string) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.stored[name] = (mapping[name] as unknown[]).map((value) => ({ json: JSON.stringify(value) }));
      };
      const malformedCard = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.cards.push({ id: 'broken-card' });
        syncStored(manifest, 'cards');
      });
      cases.push({ name: 'malformed-card', bytes: malformedCard, code: 'RECORD_FIELD' });
      const malformedVersion = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.versions = [null];
        mapping.stored.versions = [{ json: 'null' }];
      });
      cases.push({ name: 'malformed-version', bytes: malformedVersion, code: 'RECORD_FIELD' });
      const duplicateVersion = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.versions.push(structuredClone(mapping.versions[0]));
        mapping.stored.versions.push(structuredClone(mapping.stored.versions[0]));
      });
      cases.push({ name: 'duplicate-version', bytes: duplicateVersion, code: 'DUPLICATE_ID' });
      const duplicateContainment = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.containment.push(structuredClone(mapping.containment[0]));
        syncStored(manifest, 'containment');
      });
      cases.push({ name: 'duplicate-containment', bytes: duplicateContainment, code: 'DUPLICATE_ID' });
      const missingTarget = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.attachments[0].target = null;
        syncStored(manifest, 'attachments');
      });
      cases.push({ name: 'attachment-target', bytes: missingTarget, code: 'RECORD_FIELD' });
      const nonArray = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.frames = {};
        mapping.stored.frames = {};
      });
      cases.push({ name: 'non-array-frames', bytes: nonArray, code: 'STORED_MISMATCH' });
      const endpointKind = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.connectors[0].start = { kind: 'bound', targetKind: 'frame', itemId: mapping.texts[0].item.id, side: 'left' };
        syncStored(manifest, 'connectors');
      });
      cases.push({ name: 'endpoint-kind', bytes: endpointKind, code: 'REFERENCE' });
      const versionValue = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.versions[0].value = { ...mapping.versions[0].value, id: 'other-version-id' };
        mapping.stored.versions[0] = { ...mapping.stored.versions[0], json: JSON.stringify(mapping.versions[0].value) };
      });
      cases.push({ name: 'version-value-id', bytes: versionValue, code: 'VERSION_FIELD' });
      const duplicateItem = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.texts[0].item.id = mapping.cards[0].item.id;
        syncStored(manifest, 'texts');
      });
      cases.push({ name: 'duplicate-item', bytes: duplicateItem, code: 'DUPLICATE_ID' });
      const missingTagVersion = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        const index = mapping.versions.findIndex((version: any) => version.domain === 'tag');
        mapping.versions.splice(index, 1);
        mapping.stored.versions.splice(index, 1);
      });
      cases.push({ name: 'missing-tag-version', bytes: missingTagVersion, code: 'VERSION_MISSING' });
      const duplicateAttachment = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.attachments.push(structuredClone(mapping.attachments[0]));
        syncStored(manifest, 'attachments');
      });
      cases.push({ name: 'duplicate-attachment', bytes: duplicateAttachment, code: 'DUPLICATE_ID' });
      const badMime = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.assets.find((asset: any) => asset.id === 'asset-image').mime = 'not-a-mime';
      });
      cases.push({ name: 'asset-mime', bytes: badMime, code: 'ASSET_FIELD' });
      const oversizedAsset = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        const big = Buffer.alloc(600 * 1024, 7).toString('base64');
        const asset = mapping.assets.find((value: any) => value.id === 'asset-image');
        asset.base64 = big;
        asset.hash = createHash('sha256').update(Buffer.from(big, 'base64')).digest('hex');
        asset.mime = 'image/png';
        manifest.resources = (manifest.resources as any[]).filter((resource) => resource.id !== 'asset-image');
      });
      cases.push({ name: 'asset-too-large', bytes: oversizedAsset, code: 'ASSET_FIELD' });
      const missingRuns = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        delete mapping.texts[0].content.runs;
        syncStored(manifest, 'texts');
      });
      cases.push({ name: 'text-content-runs', bytes: missingRuns, code: 'CONTENT_FIELD' });
      const missingAssetRow = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        mapping.assets = mapping.assets.filter((asset: any) => asset.id !== 'asset-image');
      });
      cases.push({ name: 'asset-row-missing', bytes: missingAssetRow, code: 'REFERENCE' });
      const cyclicContainment = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        const rows = [
          { id: 'outer', parent: { kind: 'frame', id: 'inner' } },
          // 尾巴从环外进入同一个环：去重后仍只报一次。
          { id: mapping.groups[0].itemId, parent: { kind: 'frame', id: 'outer' } },
        ];
        rows.forEach((value, index) => {
          const versionId = `cycle-containment-${index}`;
          const row = { ...value, versionId };
          mapping.containment.push(row);
          mapping.stored.containment.push({ json: JSON.stringify(row) });
          mapping.versions.push({ domain: 'containment', id: row.id, versionId, value: row });
          mapping.stored.versions.push({ domain: 'containment', id: row.id, versionId, json: JSON.stringify(row) });
        });
        syncMembership(manifest);
      });
      cases.push({ name: 'containment-cycle', bytes: cyclicContainment, code: 'CONTAINMENT_CYCLE' });
      expect(verifyPackage(cyclicContainment).filter((failure) => failure.code === 'CONTAINMENT_CYCLE')).toHaveLength(1);

      const inlineOnly = rewriteManifest(good, (manifest) => {
        manifest.resources = (manifest.resources as any[]).filter((resource) => resource.id !== 'asset-image');
      });
      expect(verifyPackage(inlineOnly)).toEqual([]);
      const resourceOnly = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        delete mapping.assets.find((asset: any) => asset.id === 'asset-image').base64;
      });
      expect(verifyPackage(resourceOnly)).toEqual([]);
      // 分区编号与 item 编号同串：归属行按普通 item 处理（ADR 0032），不当成容器环。
      const sharedIdentity = rewriteManifest(good, (manifest) => {
        const mapping = manifest.mapping as Record<string, any>;
        const shapeItemId = mapping.shapes[0].item.id as string;
        mapping.shapes[0].item.id = 'outer';
        syncStored(manifest, 'shapes');
        mapping.connectors[0].end.itemId = 'outer';
        syncStored(manifest, 'connectors');
        for (const row of mapping.containment) if (row.id === shapeItemId) row.id = 'outer';
        syncStored(manifest, 'containment');
        const rename = (version: any) => {
          if (version.id !== shapeItemId || !['containment', 'pose'].includes(version.domain)) return;
          version.id = 'outer';
          version.value = { ...version.value, id: 'outer' };
        };
        mapping.versions.forEach(rename);
        mapping.stored.versions.forEach((raw: any) => {
          if (raw.id !== shapeItemId || !['containment', 'pose'].includes(raw.domain)) return;
          raw.id = 'outer';
          raw.json = JSON.stringify({ ...JSON.parse(raw.json), id: 'outer' });
        });
        syncMembership(manifest);
      });
      expect(verifyPackage(sharedIdentity)).toEqual([]);
      for (const item of cases) {
        const previewResponse = await post('/api/mapping/import.preview', { base64: item.bytes.toString('base64') });
        expect(previewResponse.status, item.name).toBe(200);
        const preview = await previewResponse.json() as { failures: { code: string }[] };
        expect(preview.failures.map((failure) => failure.code), item.name).toContain(item.code);
        let error: { code?: string; details?: { failures: { code: string }[] } } | undefined;
        try { execute(importCommand(item.bytes.toString('base64'))); } catch (thrown) { error = thrown as typeof error; }
        expect(error?.code, item.name).toBe('INVALID_PACKAGE');
        expect(error?.details?.failures.map((failure) => failure.code), item.name).toContain(item.code);
      }
      expect(fingerprint(directory).counts.mapping_projects).toBe(1);
      expect((await post('/api/mapping/import.preview', { base64: good.toString('base64') })).status).toBe(200);
      expect(fingerprint(directory).counts.mapping_projects).toBe(1);
    } finally {
      close();
    }
  }, 30000);

  it('提交中途失败与写入后的第二次闭合失败都滚回，不留新项目、资源或悬挂引用', async () => {
    const fixture = await makeFixture();
    const { execute, mapping, human, directory, close } = fixture;
    try {
      seedMixed(fixture);
      const bytes = mapping.fullPackage('p', human, ISO);
      const base64 = bytes.toString('base64');
      const before = fingerprint(directory);
      const writer = new Database(join(directory, 'workspace.sqlite'));
      try {
        writer.exec("CREATE TRIGGER fail_tag BEFORE INSERT ON mapping_tags BEGIN SELECT RAISE(ABORT, 'tag insert failed'); END");
        let error: unknown;
        try { execute(importCommand(base64)); } catch (thrown) { error = thrown; }
        expect(error).toBeInstanceOf(Error);
        expect(fingerprint(directory)).toEqual(before);
        expect((() => { try { mapping.read({ type: 'project', projectId: 'q' }, human); return false; } catch { return true; } })()).toBe(true);
        writer.exec('DROP TRIGGER fail_tag');
      } finally {
        writer.close();
      }
      const corrupt = new Database(join(directory, 'workspace.sqlite'));
      try {
        corrupt.exec(`CREATE TRIGGER corrupt_connector AFTER INSERT ON mapping_connectors BEGIN
          UPDATE mapping_connectors SET value='{"id":"broken","kind":"connector","versionId":"v","path":"straight","start":{"kind":"bound","itemId":"ghost","side":"left"},"end":{"kind":"free","point":{"x":1,"y":1}}}' WHERE id=NEW.id;
        END`);
        let error: { code?: string; details?: { failures: { code: string }[] } } | undefined;
        try { execute(importCommand(base64)); } catch (thrown) { error = thrown as typeof error; }
        expect(error?.code).toBe('IMPORT_CLOSURE_FAILED');
        expect(error?.details?.failures.map((failure) => failure.code)).toContain('REFERENCE');
        expect(fingerprint(directory)).toEqual(before);
      } finally {
        corrupt.close();
      }
      const broken = new Database(join(directory, 'workspace.sqlite'));
      try {
        broken.exec('DROP TRIGGER IF EXISTS corrupt_connector');
        broken.exec("CREATE TRIGGER corrupt_json AFTER INSERT ON mapping_cards WHEN NEW.project_id='q' BEGIN UPDATE mapping_cards SET value='not-json' WHERE id=NEW.id; END");
        let error: { code?: string; details?: { failures: { code: string }[] } } | undefined;
        try { execute(importCommand(base64)); } catch (thrown) { error = thrown as typeof error; }
        expect(error?.code).toBe('IMPORT_CLOSURE_FAILED');
        expect(error?.details?.failures.map((failure) => failure.code)).toContain('CLOSURE_EXCEPTION');
        expect(fingerprint(directory)).toEqual(before);
      } finally {
        broken.close();
      }
    } finally {
      close();
    }
  }, 30000);

  it('同一 commandId 与同一请求返回原回执，不建第二个项目；请求不同则拒绝', async () => {
    const fixture = await makeFixture();
    const { execute, mapping, human, directory, close } = fixture;
    try {
      seedMixed(fixture);
      const base64 = mapping.fullPackage('p', human, ISO).toString('base64');
      const first = execute(importCommand(base64)) as { commandId: string; revision: number };
      const receipts = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
      try {
        const row = receipts.prepare('SELECT request FROM mapping_receipts WHERE project_id=? AND command_id=?').get('q', 'import-1') as { request: string };
        expect(row.request.length).toBeLessThan(2000);
        expect(JSON.parse(row.request).payload.base64Sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.parse(row.request).payload.base64Length).toBe(base64.length);
      } finally {
        receipts.close();
      }
      const before = fingerprint(directory);
      const second = execute(importCommand(base64)) as typeof first;
      expect(second).toEqual(first);
      expect(fingerprint(directory)).toEqual(before);
      let mismatch: { code?: string } | undefined;
      try { execute(importCommand(base64, { payload: { name: '另一个名字', base64 } })); } catch (thrown) { mismatch = thrown as typeof mismatch; }
      expect(mismatch?.code).toBe('IDEMPOTENCY_MISMATCH');
      let conflict: { code?: string } | undefined;
      try { execute(importCommand(base64, { commandId: 'import-2' })); } catch (thrown) { conflict = thrown as typeof conflict; }
      expect(conflict?.code).toBe('ID_CONFLICT');
    } finally {
      close();
    }
  }, 30000);

  it('导入只允许本人会话；超过 1 MiB 的请求仍走 48 MiB 上限', async () => {
    const fixture = await makeFixture();
    const { execute, mapping, human, post, token, directory, close } = fixture;
    try {
      seedMixed(fixture);
      const base64 = mapping.fullPackage('p', human, ISO).toString('base64');
      const agentToken = mapping.access.issue('agent', ['q'], undefined, undefined, ['q']);
      let denied: { code?: string } | undefined;
      try { mapping.execute(importCommand(base64), mapping.access.authenticate(agentToken)); } catch (thrown) { denied = thrown as typeof denied; }
      expect(denied?.code).toBe('HUMAN_REQUIRED');

      const big = rewriteManifest(mapping.fullPackage('p', human, ISO), (manifest) => {
        manifest.extensions = { raw: 'x'.repeat(1_400_000) };
      });
      expect(big.length).toBeGreaterThan(1_000_000);
      const previewResponse = await post('/api/mapping/import.preview', { base64: big.toString('base64') });
      expect(previewResponse.status, await previewResponse.text()).toBe(200);
      const receipt = execute(importCommand(big.toString('base64'), { projectId: 'r', commandId: 'import-big' })) as { projectId: string };
      expect(receipt.projectId).toBe('r');
      expect(mapping.read({ type: 'project', projectId: 'r' }, human).project.name).toBe('导入副本');
      const reexport = manifestOf(mapping.fullPackage('r', human, ISO));
      expect(reexport.extensions).toEqual({ raw: 'x'.repeat(1_400_000) });
      expect(verifyPackage(mapping.fullPackage('r', human, ISO))).toEqual([]);

      const oversized = await fixture.app.fetch(new Request(`${ORIGIN}/api/mapping/execute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ type: 'project.import', commandId: 'too-large', projectId: 's', expected: null, payload: { name: '过大', base64: 'x'.repeat(49 * 1024 * 1024) } }),
      }));
      const oversizedPreview = await fixture.app.fetch(new Request(`${ORIGIN}/api/mapping/import.preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ base64: 'x'.repeat(49 * 1024 * 1024) }),
      }));
      expect(oversizedPreview.status).toBe(413);
      expect(oversized.status).toBe(413);
    } finally {
      close();
    }
  }, 60000);
});
