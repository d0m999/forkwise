import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { command, contentFixture, grant, patch, type ContentFixture } from './fixtures/agent-content.js';

async function denied(
  f: ContentFixture, request: unknown, token: string, status: number, code: string,
) {
  const before = [f.snapshot(), f.snapshot('q')];
  expect(await f.post(request, token)).toMatchObject({ status, body: { code } });
  expect([f.snapshot(), f.snapshot('q')]).toEqual(before);
}

it.each([
  ['未授权', 'CONTENT_DELEGATION_REQUIRED', undefined, {}],
  ['授权另一个项目', 'CONTENT_DELEGATION_REQUIRED', [grant('q', { objectIds: '*', blockIds: '*' })], {}],
  ['越卡', 'CONTENT_OBJECT_FORBIDDEN', [grant()], { id: 'second', blockId: 'second-block' }],
  ['越块', 'CONTENT_BLOCK_FORBIDDEN', [grant()], { blockId: 'second-block' }],
  ['跨项目卡片', 'CONTENT_OBJECT_FORBIDDEN', [grant('p', { objectIds: '*', blockIds: '*' })], { id: 'foreign', blockId: 'foreign-block' }],
] as const)('AC1/AC4 本人签发范围拒绝：%s，且无写入', async (_name, code, content, fields) => {
  const f = await contentFixture();
  const token = f.issue(content && [...content], undefined, ['p', 'q']);
  await denied(f, patch(f.card().body.versionId, fields), token, 403, code);
});

it('AC4 已收窄的持久会话不含 body.patch 时拒绝，不从会话缓存恢复权限', async () => {
  const f = await contentFixture();
  const token = f.issue([grant()]);
  const hash = f.mapping.access.authenticate(token).tokenHash;
  f.mapping.access.db.prepare('UPDATE sessions SET capabilities=? WHERE token_hash=?')
    .run(JSON.stringify({ personalRecordProjects: ['p'], contentDelegations: [grant('p', { operations: [] })] }), hash);
  await denied(f, patch(f.card().body.versionId), token, 403, 'CONTENT_OPERATION_FORBIDDEN');
});

it.each(['actor', 'origin', 'delegation'])('AC4 自报 %s 被拒绝', async (field) => {
  const f = await contentFixture();
  const token = f.issue([grant()]);
  await denied(f, { ...patch(f.card().body.versionId), [field]: '本人' }, token, 403, 'UNTRUSTED_PRINCIPAL');
});

it.each(['过期', '撤销', '重启后撤销'])('AC4 会话%s后无法写入', async (phase) => {
  const f = await contentFixture();
  const token = f.issue([grant()], undefined, ['p'], phase === '过期' ? -60_000 : 60_000);
  if (phase !== '过期') {
    f.mapping.access.revoke(createHash('sha256').update(token).digest('hex'));
    if (phase === '重启后撤销') await f.restart();
  }
  await denied(f, patch(f.card().body.versionId), token, 401, 'UNAUTHORIZED');
});

it.each(['卡片', '正文块'])('AC4 已删除%s返回 404', async (kind) => {
  const f = await contentFixture();
  const c = f.card();
  const token = f.issue([grant()]);
  if (kind === '卡片')
    f.apply('thought.delete', { thought: c.versionId, body: c.body.versionId, pose: c.item.versionId, appearance: null }, { id: c.id });
  else
    f.apply('body.edit', c.body.versionId, { id: c.id, blocks: [{ id: 'new-block', type: 'text', text: '新块' }] });
  await denied(f, patch(c.body.versionId), token, 404, 'NOT_FOUND');
});

it.each(['body.edit', 'card.edit'])('AC1 已授权会话经 %s 写整篇在版本校验前拒绝', async (type) => {
  const f = await contentFixture();
  const token = f.issue([grant()]);
  const expected = type === 'body.edit' ? 'stale' : { body: 'stale', pose: 'stale' };
  const payload = { id: 'card', text: '整篇替换', ...(type === 'card.edit' ? { x: 70, y: 80 } : {}) };
  await denied(f, command(type, expected, payload), token, 403, 'CONTENT_OPERATION_UNSUPPORTED');
  const c = f.card();
  const current = type === 'body.edit' ? c.body.versionId : { body: c.body.versionId, pose: c.item.versionId };
  expect((await f.post(command(type, current, payload), f.issue())).status).toBe(200);
});

it.each([
  ['pose.move', { id: 'card', x: 40, y: 80 }, 'pose'],
  ['thought.title', { id: 'card', title: '改标题' }, 'thought'],
  ['card.appearance', { id: 'card', titleColor: '#ffffff', showPreview: true }, 'appearance'],
  ['card.tags', { id: 'card', tagIds: [] }, 'appearance'],
  ['project.rename', { name: '其他项目名' }, 'project'],
])('AC4 正文委托不包含 %s', async (type, payload, domain) => {
  const f = await contentFixture();
  const c = f.card();
  const versions = { pose: c.item.versionId, thought: c.versionId, appearance: null, project: f.state().project.versionId };
  await denied(f, command(type, versions[domain as keyof typeof versions], payload), f.issue([grant()]), 403, 'CONTENT_OPERATION_UNSUPPORTED');
});

it('AC4 只有项目访问权的 Agent 不能写正文；加正文范围也不能写附着或剪切', async () => {
  const f = await contentFixture();
  const card = f.card();
  await denied(f, patch(card.body.versionId), f.mapping.access.issue('agent', ['p']), 403, 'CONTENT_DELEGATION_REQUIRED');
  const token = f.issue([grant()]);
  await denied(f, command('card.attachment.add', { attachments: null }, {
    id: card.id, assetId: 'asset', name: '原件',
  }), token, 403, 'CONTENT_OPERATION_UNSUPPORTED');
  await denied(f, command('canvas.cut', {
    groups: {}, containment: {}, items: {}, connectors: {},
  }, { cutId: 'cut', groupIds: [], itemIds: [card.item.id] }), token, 403, 'CONTENT_OPERATION_UNSUPPORTED');
});

it('AC4 布局委托本身不允许正文补丁', async () => {
  const f = await contentFixture();
  const token = f.issue(undefined, [{ projectId: 'p', operations: ['pose.move'], objectKinds: ['card'], objectIds: '*', fields: ['x', 'y'] }]);
  await denied(f, patch(f.card().body.versionId), token, 403, 'CONTENT_DELEGATION_REQUIRED');
});

it.each([
  ['未知字段', { hidden: true }],
  ['未知操作', { operations: ['body.edit'] }],
  ['未知对象类型', { objectKinds: ['text'] }],
  ['越项目', { projectId: 'q' }],
  ['不存在的卡', { objectIds: ['missing'] }],
  ['不属于选定卡的块', { blockIds: ['second-block'] }],
])('AC4 签发拒绝%s且不新增会话', async (_label, fields) => {
  const f = await contentFixture();
  const before = f.mapping.access.db.prepare('SELECT count(*) AS n FROM sessions').get();
  expect(() => f.issue([{ ...grant(), ...fields } as ReturnType<typeof grant>])).toThrowError(
    expect.objectContaining({ code: 'INVALID_SCOPE' }),
  );
  expect(f.mapping.access.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual(before);
});
