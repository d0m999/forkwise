import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openMapping } from '../src/mapping/storage.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { captureSpatial } from '../src/mapping/frame-spatial.js';

function tableCounts(directory: string) {
  const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mapping_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, (db.prepare(`SELECT count(*) AS count FROM ${name}`).get() as { count: number }).count]));
  } finally {
    db.close();
  }
}

it('只读 HTTP 导出已保存卡片摘要并保留项目 revision、历史和全部持久行', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-summary-http-'));
  const mapping = openMapping(directory);
  const origin = 'http://127.0.0.1:4173';
  const app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const token = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(token);
  const denied = mapping.access.issue('agent', ['other']);
  const get = (path: string, principal = token) => app.fetch(new Request(`${origin}${path}`, { headers: { Authorization: `Bearer ${principal}` } }));
  try {
    mapping.execute({ commandId: 'project', projectId: 'p', type: 'project.create', expected: null, payload: { name: '导出研究' } }, human);
    mapping.execute({ commandId: 'card', projectId: 'p', type: 'thought.create', expected: null,
      payload: { id: 'card-1', title: '长期价值', text: '第一段已保存正文。\n第二段保留换行与可读内容。', x: 40, y: 60 } }, human);
    mapping.execute({ commandId: 'tag', projectId: 'p', type: 'tag.create', expected: { cardTags: null }, payload: { id: 'tag-1', name: '核心观察', cardId: 'card-1' } }, human);
    mapping.execute({ commandId: 'asset', projectId: 'p', type: 'asset.save', expected: null,
      payload: { id: 'asset-1', name: '财报原件.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\n').toString('base64'), kind: 'file' } }, human);
    mapping.execute({ commandId: 'attachment', projectId: 'p', type: 'card.attachment.add', expected: { attachments: null },
      payload: { id: 'card-1', assetId: 'asset-1', name: '财报原件.pdf' } }, human);
    const before = mapping.read({ type: 'project', projectId: 'p' }, human);
    const historyBefore = mapping.read({ type: 'history', projectId: 'p' }, human);
    const countsBefore = tableCounts(directory);

    const response = await get(`/api/mapping/projects/p/export.md?revision=${before.project.revision}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    const markdown = await response.text();
    expect(markdown).toContain('# 导出研究');
    expect(markdown).toContain('项目 id：p');
    expect(markdown).toContain(`revision：${before.project.revision}`);
    expect(markdown).toMatch(/导出时间：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(markdown).toContain('这是可读摘要，不是完整恢复，也不是备份');
    expect(markdown).toContain('长期价值');
    expect(markdown).toContain('第一段已保存正文。\n第二段保留换行与可读内容。');
    expect(markdown).toContain('核心观察');
    expect(markdown).toContain('财报原件.pdf');
    expect(markdown).toContain('不能表达的结构与已知缺口');
    expect(markdown).toContain('完整富文本往返');
    expect(markdown).toContain('原件字节');
    expect(markdown).toContain('旧研究模型中的主张、推导、立场、条件和历史判断不在本文件中；它们仍保留在原项目数据中，本摘要未迁移或改写');

    expect(mapping.read({ type: 'project', projectId: 'p' }, human).project.revision).toBe(before.project.revision);
    expect(mapping.read({ type: 'history', projectId: 'p' }, human)).toEqual(historyBefore);
    expect(tableCounts(directory)).toEqual(countsBefore);
    expect((await get(`/api/mapping/projects/p/export.md?revision=${before.project.revision}`, denied)).status).toBe(403);
    const stale = await get(`/api/mapping/projects/p/export.md?revision=${before.project.revision - 1}`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'EXPORT_REVISION_CHANGED' });
    const invalid = await get('/api/mapping/projects/p/export.md?revision=not-a-number');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_EXPORT_REQUEST' });
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('摘要保留嵌套分区、普通连线、批注、独立对象和正文结构的可读内容与缺口', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-summary-canvas-'));
  const mapping = openMapping(directory);
  const origin = 'http://127.0.0.1:4173';
  const app = createWorkspaceApp(mapping, origin, () => new Response(''));
  const token = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(token);
  const execute = (command: unknown) => mapping.execute(command, human);
  const read = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const frameCommand = (id: string, itemIds: string[], pose: { x: number; y: number; width: number; height: number }, parentId?: string) => {
    const state = read();
    return { commandId: id, projectId: 'p', type: 'frame.create',
      expected: { frame: null, groups: {},
        containment: Object.fromEntries(itemIds.map(itemId => [itemId, state.containment?.find(row => row.id === itemId)?.versionId ?? null])),
        poses: Object.fromEntries(itemIds.map(itemId => [itemId, [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? []), ...(state.strokes ?? [])].find(value => value.item.id === itemId)!.item.versionId])) },
      placement: { expected: captureSpatial(state, { rect: pose }) },
      payload: { id, itemIds, pose, ...(parentId ? { parentId } : {}) } };
  };
  try {
    execute({ commandId: 'project', projectId: 'p', type: 'project.create', expected: null, payload: { name: '混合画布' } });
    execute({ commandId: 'card', projectId: 'p', type: 'thought.create', expected: null,
      payload: { id: 'card-1', title: '长期价值', text: '初始正文', x: 120, y: 160 } });
    execute({ commandId: 'image-asset', projectId: 'p', type: 'asset.save', expected: null,
      payload: { id: 'asset-image', name: '现金流.svg', mime: 'image/svg+xml', base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>').toString('base64') } });
    const card = read().cards[0]!;
    execute({ commandId: 'body', projectId: 'p', type: 'body.edit', expected: card.body.versionId,
      payload: { id: card.id, requiredAssetIds: ['asset-image'], blocks: [
        { id: 'heading', type: 'heading', text: '研究章节', level: 2 },
        { id: 'paragraph', type: 'text', text: '这是包含完整已保存内容的长正文。' },
        { id: 'body-image', type: 'image', assetId: 'asset-image', name: '现金流.svg', mime: 'image/svg+xml', naturalWidth: 20, naturalHeight: 10, caption: '现金流图', alt: '绿色现金流示意图' },
        { id: 'table', type: 'table', header: true, rows: [[{ text: '指标' }, { text: '值' }], [{ text: '收入' }, { text: '增长' }]] },
        { id: 'code', type: 'code', language: 'ts', wrap: false, text: 'const kept = true;' },
      ] } });
    execute({ commandId: 'text', projectId: 'p', type: 'text.create', expected: null,
      payload: { id: 'text-1', content: { runs: [{ text: '随动批注' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
        pose: { x: 600, y: 140, width: 160, height: 60 } } });
    execute({ commandId: 'shape', projectId: 'p', type: 'shape.create', expected: null,
      payload: { id: 'shape-1', content: { shapeType: 'rectangle', shortText: '条件成立' }, pose: { x: 260, y: 340, width: 180, height: 100 } } });
    execute({ commandId: 'image', projectId: 'p', type: 'image.create', expected: null,
      payload: { id: 'image-1', content: { assetId: 'asset-image', crop: { x: 0, y: 0, width: 1, height: 1 } },
        pose: { x: 600, y: 260, width: 120, height: 80, rotation: 0 } } });
    execute({ commandId: 'stroke', projectId: 'p', type: 'stroke.create', expected: null,
      payload: { id: 'stroke-1', content: { penKind: 'highlighter', path: [{ x: 0, y: 0 }, { x: 80, y: 40 }], color: '#ff0000', width: 12, opacity: 0.35 },
        pose: { x: 600, y: 400, width: 100, height: 60 } } });
    const outerPose = { x: 80, y: 100, width: 440, height: 400 };
    const created = read();
    const textItemId = created.texts![0]!.item.id;
    const shapeItemId = created.shapes![0]!.item.id;
    const imageItemId = created.images![0]!.item.id;
    const strokeItemId = created.strokes![0]!.item.id;
    execute(frameCommand('outer', [card.item.id, shapeItemId], outerPose));
    execute(frameCommand('inner', [shapeItemId], { x: 220, y: 300, width: 240, height: 160 }, 'outer'));
    execute({ commandId: 'outer-name', projectId: 'p', type: 'frame.edit', expected: read().frames!.find(frame => frame.id === 'outer')!.versionId,
      payload: { id: 'outer', name: '宏观', background: null } });
    execute({ commandId: 'inner-name', projectId: 'p', type: 'frame.edit', expected: read().frames!.find(frame => frame.id === 'inner')!.versionId,
      payload: { id: 'inner', name: '分公司', background: null } });
    execute({ commandId: 'group', projectId: 'p', type: 'group.create', expected: { groups: { 'group-1': null }, containment: { [imageItemId]: null, [strokeItemId]: null } },
      payload: { id: 'group-1', itemIds: [imageItemId, strokeItemId] } });
    execute({ commandId: 'attach', projectId: 'p', type: 'attachment.attach',
      expected: { attachment: null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: null },
      payload: { itemId: textItemId, targetItemId: card.item.id } });
    execute({ commandId: 'connector', projectId: 'p', type: 'connector.create', expected: null,
      payload: { id: 'line-1', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: shapeItemId, side: 'left' }, path: 'straight' } });
    execute({ commandId: 'label', projectId: 'p', type: 'connector.label', expected: read().connectors![0]!.versionId,
      payload: { id: 'line-1', label: { text: '共同观察', position: 0.5, fontSize: 16, color: '#626e81', bold: false } } });

    const response = await app.fetch(new Request(`${origin}/api/mapping/projects/p/export.md`, { headers: { Authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    const markdown = await response.text();
    for (const expected of [
      '研究章节', '这是包含完整已保存内容的长正文。', '现金流图', '指标\t值', 'const kept = true;',
      '## 分区', '宏观（outer）', '分公司（inner）',
      '## 普通连线', '长期价值（card-1）', '条件成立（shape-1/', '共同观察',
      '## 随动批注', '随动批注（text-1/',
      '## 独立对象', 'image-1：asset-image', 'stroke-1：highlighter',
      '## 组合', 'group-1', imageItemId, strokeItemId,
    ]) expect(markdown).toContain(expected);
    expect(markdown.indexOf('宏观（outer）')).toBeLessThan(markdown.indexOf('分公司（inner）'));
    expect(markdown).toContain('未知块只保留类型与身份提示，原始块内容未在此文件中展开');
  } finally {
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
