import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openMapping } from '../src/mapping/storage.js';
import { MappingCommand } from '../src/mapping/contracts.js';
import { CanvasClipboardSchema } from '../src/mapping/snapshot-contracts.js';

const pdf = Buffer.from('%PDF-1.4\n').toString('base64');
const other = Buffer.from('%PDF-1.4 other\n').toString('base64');

function open() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-card-attachments-'));
  const mapping = openMapping(directory);
  const actor = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const run = (type: string, payload: object, expected: unknown = null, projectId = 'p') =>
    mapping.execute({ commandId: crypto.randomUUID(), projectId, type, expected, payload }, actor);
  const read = (projectId = 'p') => mapping.read({ type: 'project', projectId }, actor);
  const assets = () => {
    const db = new Database(join(directory, 'workspace.sqlite'), { readonly: true });
    try { return (db.prepare('SELECT COUNT(*) AS n FROM mapping_assets').get() as { n: number }).n; }
    finally { db.close(); }
  };
  return { mapping, actor, run, read, assets, close: () => mapping.close() };
}

it('附件命令拒绝多余字段、缺版本和重复资产，两张卡复用同一原件且笔记独立', () => {
  expect(MappingCommand.safeParse({ commandId: 'c', projectId: 'p', type: 'card.attachment.add', expected: { attachments: null }, payload: { id: 'card', assetId: 'a', name: 'a.pdf', extra: true } }).success).toBe(false);
  expect(MappingCommand.safeParse({ commandId: 'c', projectId: 'p', type: 'card.attachment.add', payload: { id: 'card', assetId: 'a', name: 'a.pdf' } }).success).toBe(false);
  expect(MappingCommand.safeParse({ commandId: 'c', projectId: 'p', type: 'card.attachment.remove', expected: { attachments: 'v' }, payload: { id: 'card', attachmentId: 'x', extra: true } }).success).toBe(false);
  const f = open();
  try {
    f.run('project.create', { name: '项目' });
    f.run('thought.create', { id: 'a', title: '甲', text: '甲的笔记', x: 0, y: 0 });
    f.run('thought.create', { id: 'b', title: '乙', text: '乙的笔记', x: 400, y: 0 });
    const revision = f.read().project.revision;
    f.run('asset.save', { id: 'file', name: '财报.pdf', mime: 'application/pdf', base64: pdf, kind: 'file' });
    expect(f.read().project.revision).toBe(revision);
    const saved = f.mapping.read({ type: 'asset', projectId: 'p', id: 'file' }, f.actor);
    expect(saved).toMatchObject({ name: '财报.pdf', mime: 'application/pdf', kind: 'file', base64: pdf });
    expect(saved).not.toHaveProperty('width');
    expect(() => f.run('asset.save', { id: 'bad', name: 'a.pdf', mime: 'application/pdf', base64: pdf })).toThrow(/图片/);
    expect(() => f.run('asset.save', { id: 'html', name: 'a.html', mime: 'text/html', base64: Buffer.from('<p>x</p>').toString('base64'), kind: 'file' })).not.toThrow();
    expect(() => f.run('asset.save', { id: 'bad-mime', name: 'a.bin', mime: 'not-a-mime', base64: pdf, kind: 'file' })).toThrow(/文件类型/);
    expect(() => f.run('asset.save', { id: 'bad-bytes', name: 'a.pdf', mime: 'application/pdf', base64: 'abc', kind: 'file' })).toThrow(/文件/);
    f.run('card.attachment.add', { id: 'a', assetId: 'file', name: '财报.pdf' }, { attachments: null });
    const first = f.read().cards.find(card => card.id === 'a')!;
    expect(first.attachments?.items).toEqual([{ id: first.attachments!.items[0]!.id, assetId: 'file', name: '财报.pdf' }]);
    expect(first.attachments?.id).toBe('attachments:a');
    expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'attachments', id: 'attachments:a', versionId: first.attachments!.versionId }, f.actor)).toEqual(first.attachments);
    expect(() => f.run('card.attachment.add', { id: 'a', assetId: 'file', name: '再来一份' }, { attachments: first.attachments!.versionId })).toThrow(/同一资产/);
    expect(() => f.run('card.attachment.add', { id: 'missing', assetId: 'file', name: '财报.pdf' }, { attachments: null })).toThrow(/卡片不存在/);
    expect(() => f.run('card.attachment.add', { id: 'b', assetId: 'gone', name: '财报.pdf' }, { attachments: null })).toThrow(/资产不存在/);
    f.run('card.attachment.add', { id: 'b', assetId: 'file', name: '乙的副本.pdf' }, { attachments: null });
    const linked = f.read();
    const cardA = linked.cards.find(card => card.id === 'a')!;
    const cardB = linked.cards.find(card => card.id === 'b')!;
    expect(cardA.attachments!.items[0]!.assetId).toBe(cardB.attachments!.items[0]!.assetId);
    expect(cardA.attachments!.items[0]!.name).toBe('财报.pdf');
    expect(cardB.attachments!.items[0]!.name).toBe('乙的副本.pdf');
    f.run('body.edit', { id: 'a', text: '甲改了笔记' }, cardA.body.versionId);
    const edited = f.read();
    expect(edited.cards.find(card => card.id === 'b')).toEqual(cardB);
    expect(edited.cards.find(card => card.id === 'a')!.attachments).toEqual(cardA.attachments);
    const count = f.assets();
    f.run('card.attachment.remove', { id: 'a', attachmentId: cardA.attachments!.items[0]!.id }, { attachments: cardA.attachments!.versionId });
    const removed = f.read();
    expect(removed.cards.find(card => card.id === 'a')!.attachments!.items).toEqual([]);
    expect(removed.cards.find(card => card.id === 'b')!.attachments).toEqual(cardB.attachments);
    expect(f.assets()).toBe(count);
    expect(() => f.run('card.attachment.remove', { id: 'b', attachmentId: 'not-on-card' }, { attachments: cardB.attachments!.versionId })).toThrow(/不属于/);
    const index = f.mapping.read({ type: 'map', view: 'index', projectId: 'p', budget: 1_048_576 }, f.actor);
    const indexed = index.items.find(item => item.id === 'b');
    expect(indexed && 'attachments' in indexed ? indexed.attachments?.count : 0).toBe(1);
  } finally { f.close(); }
});

it('拖入建卡和附件同一次写入，缺资产不留下卡片，撤销只去掉卡片', () => {
  expect(MappingCommand.safeParse({ commandId: 'c', projectId: 'p', type: 'thought.create', expected: null, payload: { id: 'card', title: '甲', text: '', x: 0, y: 0, attachment: { assetId: 'a', name: 'a.pdf', extra: true } } }).success).toBe(false);
  const f = open();
  try {
    f.run('project.create', { name: '项目' });
    f.run('asset.save', { id: 'file', name: '财报.pdf', mime: 'application/pdf', base64: pdf, kind: 'file' });
    const before = f.read();
    expect(() => f.run('thought.create', { id: 'missing-file', title: '空', text: '', x: 0, y: 0, attachment: { assetId: 'gone', name: '财报.pdf' } })).toThrow(/资产不存在/);
    expect(f.read().cards).toEqual(before.cards);
    expect(f.read().project.revision).toBe(before.project.revision);
    f.run('thought.create', { id: 'card', title: '财报', text: '', x: 8, y: 12, attachment: { assetId: 'file', name: '财报.pdf' } });
    const created = f.read();
    const card = created.cards[0]!;
    expect(card.attachments?.items.map(item => ({ assetId: item.assetId, name: item.name }))).toEqual([{ assetId: 'file', name: '财报.pdf' }]);
    expect(card.attachments?.id).toBe('attachments:card');
    expect(created.project.revision).toBe(before.project.revision + 1);
    expect(f.mapping.read({ type: 'version', projectId: 'p', domain: 'attachments', id: card.attachments!.id, versionId: card.attachments!.versionId }, f.actor)).toEqual(card.attachments);
    const count = f.assets();
    f.run('history.undo', {}, created.project.revision);
    expect(f.read().cards).toEqual([]);
    expect(f.assets()).toBe(count);
    expect(f.mapping.read({ type: 'asset', projectId: 'p', id: 'file' }, f.actor).base64).toBe(pdf);
  } finally { f.close(); }
});

it('撤销把附件版本写回之前的值，重做写回当时的值，删卡不删原件', () => {
  const f = open();
  try {
    f.run('project.create', { name: '项目' });
    f.run('thought.create', { id: 'a', title: '甲', text: '', x: 10, y: 20 });
    f.run('asset.save', { id: 'file', name: '说明.pdf', mime: 'application/pdf', base64: pdf, kind: 'file' });
    f.run('card.attachment.add', { id: 'a', assetId: 'file', name: '说明.pdf' }, { attachments: null });
    const added = f.read().cards[0]!;
    const addedVersion = added.attachments!.versionId;
    f.run('card.attachment.remove', { id: 'a', attachmentId: added.attachments!.items[0]!.id }, { attachments: addedVersion });
    const removedVersion = f.read().cards[0]!.attachments!.versionId;
    const count = f.assets();
    f.run('history.undo', {}, f.read().project.revision);
    const undone = f.read().cards[0]!;
    expect(undone.attachments!.versionId).toBe(addedVersion);
    expect(undone.attachments!.items.map(item => item.assetId)).toEqual(['file']);
    expect(f.assets()).toBe(count);
    f.run('history.redo', {}, f.read().project.revision);
    expect(f.read().cards[0]!.attachments!.versionId).toBe(removedVersion);
    expect(f.read().cards[0]!.attachments!.items).toEqual([]);
    const current = f.read().cards[0]!;
    f.run('thought.delete', { id: 'a' }, { thought: current.versionId, body: current.body.versionId, pose: current.item.versionId, appearance: null });
    expect(f.read().cards).toEqual([]);
    expect(f.mapping.read({ type: 'asset', projectId: 'p', id: 'file' }, f.actor).base64).toBe(pdf);
    expect(f.assets()).toBe(count);
  } finally { f.close(); }
});

it('同项目复制共享资产身份，跨项目同身份异内容新建资产，旧剪贴板没有附件字段仍可粘贴', () => {
  const f = open();
  try {
    f.run('project.create', { name: '来源' });
    f.mapping.execute({ commandId: 'project-q', projectId: 'q', type: 'project.create', expected: null, payload: { name: '目标' } }, f.actor);
    f.run('asset.save', { id: 'shared', name: '报告.pdf', mime: 'application/pdf', base64: pdf, kind: 'file' });
    f.mapping.execute({ commandId: 'target-file', projectId: 'q', type: 'asset.save', expected: null, payload: { id: 'shared', name: '报告.pdf', mime: 'application/pdf', base64: other, kind: 'file' } }, f.actor);
    f.run('thought.create', { id: 'source', title: '来源卡', text: '来源笔记', x: 0, y: 0 });
    f.run('card.attachment.add', { id: 'source', assetId: 'shared', name: '报告.pdf' }, { attachments: null });
    const source = f.read().cards[0]!;
    const pose = source.item.pose;
    f.mapping.execute({
      commandId: 'same-project', projectId: 'p', type: 'canvas.paste', expected: null,
      payload: {
        translation: { x: 24, y: 24 },
        objects: [{ kind: 'card', copyId: 'copy', stack: 1, title: source.title, blocks: source.body.blocks, tagIds: null, appearance: null, pose, attachments: source.attachments!.items }],
        connectors: [],
      },
    }, f.actor);
    const copied = f.read().cards.find(card => card.id === 'copy')!;
    expect(copied.attachments!.items.map(item => item.assetId)).toEqual(['shared']);
    expect(copied.attachments!.items[0]!.name).toBe('报告.pdf');
    expect(copied.attachments!.items[0]!.id).not.toBe(source.attachments!.items[0]!.id);
    expect(f.read().cards.find(card => card.id === 'source')!.body.blocks).toEqual(source.body.blocks);
    const beforeTarget = f.assets();
    f.mapping.execute({
      commandId: 'cross-project', projectId: 'q', type: 'canvas.paste', expected: null,
      payload: {
        translation: { x: 30, y: 40 },
        library: { tags: [], assets: [{ id: 'shared', name: '报告.pdf', mime: 'application/pdf', base64: pdf, kind: 'file' }] },
        objects: [{ kind: 'card', copyId: 'pasted', stack: 1, title: '粘贴', blocks: source.body.blocks, tagIds: null, appearance: null, pose, attachments: [{ id: 'item', assetId: 'shared', name: '报告.pdf' }] }],
        connectors: [],
      },
    }, f.actor);
    const pasted = f.mapping.read({ type: 'project', projectId: 'q' }, f.actor).cards.find(card => card.id === 'pasted')!;
    expect(pasted.attachments!.items[0]!.assetId).not.toBe('shared');
    expect(f.mapping.read({ type: 'asset', projectId: 'q', id: pasted.attachments!.items[0]!.assetId }, f.actor)).toMatchObject({ base64: pdf, kind: 'file' });
    expect(f.mapping.read({ type: 'asset', projectId: 'q', id: 'shared' }, f.actor).base64).toBe(other);
    expect(f.assets()).toBe(beforeTarget + 1);
    f.mapping.execute({
      commandId: 'old-packet', projectId: 'q', type: 'canvas.paste', expected: null,
      payload: {
        translation: { x: 0, y: 80 },
        objects: [{ kind: 'card', copyId: 'plain', stack: 2, title: '旧包', blocks: [{ id: 'w', type: 'text', text: '没有附件' }], tagIds: null, appearance: null, pose }],
        connectors: [],
      },
    }, f.actor);
    expect(f.mapping.read({ type: 'project', projectId: 'q' }, f.actor).cards.find(card => card.id === 'plain')!.attachments).toBeUndefined();
    expect(CanvasClipboardSchema.safeParse({
      kind: 'forkwise-canvas-snapshot', version: 1,
      objects: [{ kind: 'card', sourceId: 'source', itemId: 'item', stack: 1, title: '旧', blocks: [{ id: 'w', type: 'text', text: '正文' }], tagIds: null, appearance: null, pose }],
      connectors: [],
    }).success).toBe(true);
  } finally { f.close(); }
});
