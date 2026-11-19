import { expect, it } from 'vitest';
import { canonical } from '../src/domain/canonical.js';
import type { Block } from '../src/mapping/contracts.js';
import { command, contentFixture, patch } from './fixtures/agent-content.js';

it.each([
  ['反向', { start: 2, end: 1 }],
  ['越界', { start: 0, end: 9 }],
  ['负数', { start: -1, end: 1 }],
  ['分数', { start: 0, end: 1.5 }],
  ['跨块', { start: 0, end: 1, endBlockId: 'second-block' }],
  ['切开代理对', { start: 3, end: 3 }],
])('AC1/AC4 区间%s返回稳定错误且无写入', async (_label, range) => {
  const f = await contentFixture();
  const before = f.snapshot();
  expect(await f.post(patch(f.card().body.versionId, { range }))).toMatchObject({
    status: 400, body: { code: 'CONTENT_RANGE_INVALID' },
  });
  expect(f.snapshot()).toEqual(before);
});

it.each([{ x: 21 }, { patches: [] }, { blocks: [] }])('AC1 补丁拒绝额外字段 %j', async (fields) => {
  const f = await contentFixture();
  const before = f.snapshot();
  expect(await f.post(patch(f.card().body.versionId, fields), f.issue([f.grant()]))).toMatchObject({
    status: 400, body: { code: 'INVALID_COMMAND' },
  });
  expect(f.snapshot()).toEqual(before);
});

const unsupported: Block[] = [
  { id: 'text-extra', type: 'text', text: '保留额外字段', later: { id: 1 } },
  { id: 'table', type: 'table', rows: [[{ text: '表格' }]] },
  { id: 'code', type: 'code', text: 'const x = 1' },
  { id: 'image', type: 'image', assetId: 'asset', caption: '图片说明' },
  { id: 'task', type: 'imageTask', name: '处理中' },
  { id: 'pending', type: 'pendingImage', name: '待处理' },
  { id: 'future', type: 'future-alpha', extension: { keep: ['未知', { nested: true }] } },
];

function installExistingBlocks(f: Awaited<ReturnType<typeof contentFixture>>) {
  f.apply('card.appearance', null, { id: 'card', titleColor: '#ffffff', showPreview: false });
  f.apply('tag.create', { cardTags: null }, { id: 'existing-tag', name: '已保留', cardId: 'card' });
  f.apply('asset.save', null, {
    id: 'asset', name: '原件.svg', mime: 'image/svg+xml',
    base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>').toString('base64'),
  });
  const card = f.card();
  // 导入过的对象可能含当前编辑器未知的原件。只在此处构造历史数据形状。
  card.body.blocks.push(...unsupported);
  f.mapping.access.db.prepare('UPDATE mapping_cards SET value=? WHERE id=?').run(JSON.stringify(card), card.id);
}

it.each(unsupported.map(block => [block.id]))('AC2 不支持的块 %s 拒绝且保留原件', async (blockId) => {
  const f = await contentFixture();
  installExistingBlocks(f);
  expect(() => f.issue([f.grant({ blockId })])).toThrowError(expect.objectContaining({ code: 'INVALID_SCOPE' }));
  const before = f.snapshot();
  expect(await f.post(patch(f.card().body.versionId, { blockId }))).toMatchObject({
    status: 409, body: { code: 'CONTENT_BLOCK_UNSUPPORTED' },
  });
  expect(f.snapshot()).toEqual(before);
});

it.each([
  ['中文', { start: 0, end: 2 }, '汉字', '汉字😀e\u0301结束'],
  ['emoji', { start: 2, end: 4 }, '🚀', '中文🚀e\u0301结束'],
  ['组合字符', { start: 4, end: 6 }, 'a\u0308', '中文😀a\u0308结束'],
  ['空区间插入', { start: 2, end: 2 }, '＋', '中文＋😀e\u0301结束'],
  ['空替换删除', { start: 6, end: 8 }, '', '中文😀e\u0301'],
])('AC2 只修改%s区间且其余块逐字节保真', async (_label, range, text, expected) => {
  const f = await contentFixture();
  installExistingBlocks(f);
  const token = f.issue([f.grant({ range })]);
  const before = f.card();
  const originalMedia = f.mapping.read({ type: 'asset', projectId: 'p', id: 'asset' }, f.human);
  const beforeProject = f.state().project;
  const beforeHistory = f.history().undo.length;
  const result = await f.post(patch(before.body.versionId, { range, text }), token);
  const after = f.card();
  expect(result).toMatchObject({
    status: 200,
    body: { revision: beforeProject.revision + 1, changedIds: [before.body.id], versions: { body: after.body.versionId, pose: before.item.versionId } },
  });
  expect(canonical(after.body.blocks.slice(1))).toBe(canonical(before.body.blocks.slice(1)));
  expect(after.body.blocks[0]).toEqual({ id: 'paragraph', type: 'text', text: expected });
  expect(after.body.versionId).not.toBe(before.body.versionId);
  expect(after).toEqual({ ...before, body: { ...before.body, versionId: after.body.versionId, blocks: after.body.blocks } });
  expect(after.appearance?.titleColor).toBe('#ffffff');
  expect(after.cardTags?.tagIds).toEqual(['existing-tag']);
  expect(f.mapping.read({ type: 'asset', projectId: 'p', id: 'asset' }, f.human)).toEqual(originalMedia);
  expect(f.history().undo).toHaveLength(beforeHistory + 1);
});

it('AC3 人类移动后正文补丁成功，同正文旧版本和陈旧布局均冲突', async () => {
  const f = await contentFixture();
  const token = f.issue([f.grant()]);
  const initial = f.card();
  const move = await f.post(command('pose.move', initial.item.versionId, { id: initial.id, x: 105, y: 203 }));
  expect(move.status).toBe(200);
  const newPose = f.card().item;
  expect(newPose.versionId).not.toBe(initial.item.versionId);
  const originalPatch = await f.post(patch(initial.body.versionId), token);
  expect(originalPatch.status).toBe(200);
  const patched = f.card();
  expect(patched.item).toEqual(newPose);
  expect(patched.body.blocks[0]?.text).toBe('新文😀e\u0301结束');

  const competingToken = f.issue([f.grant()]);
  const bodyWrite = await f.post(command('body.edit', patched.body.versionId, { id: initial.id, text: '人类新正文' }));
  expect(bodyWrite.status).toBe(200);
  const beforeConflict = f.snapshot();
  const conflict = await f.post(patch(patched.body.versionId), competingToken);
  expect(conflict).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } });
  for (const identity of [initial.id, 'paragraph', f.card().body.versionId])
    expect(conflict.body.message).toContain(identity);
  expect(f.snapshot()).toEqual(beforeConflict);

  expect(await f.post(command('pose.move', initial.item.versionId, { id: initial.id, x: 80, y: 91 }))).toMatchObject({
    status: 409, body: { code: 'VERSION_CONFLICT' },
  });
  expect(f.snapshot()).toEqual(beforeConflict);
  expect(f.card().body.blocks[0]?.text).toBe('人类新正文');
});
