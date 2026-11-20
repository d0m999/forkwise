import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { command, contentFixture, patch, type ContentFixture } from './fixtures/agent-content.js';

async function denied(
  f: ContentFixture, request: unknown, token: string, status: number, code: string,
) {
  const before = [f.snapshot(), f.snapshot('q')];
  expect(await f.post(request, token)).toMatchObject({ status, body: { code } });
  expect([f.snapshot(), f.snapshot('q')]).toEqual(before);
}

it.each([
  ['未授权', 'CONTENT_DELEGATION_REQUIRED', {}],
  ['授权另一个项目', 'CONTENT_DELEGATION_REQUIRED', {}],
  ['越卡', 'CONTENT_OBJECT_FORBIDDEN', { id: 'second', blockId: 'second-block' }],
  ['越块', 'CONTENT_BLOCK_FORBIDDEN', { blockId: 'second-block' }],
  ['跨项目卡片', 'CONTENT_OBJECT_FORBIDDEN', { id: 'foreign', blockId: 'foreign-block' }],
] as const)('AC1/AC4 本人签发范围拒绝：%s，且无写入', async (name, code, fields) => {
  const f = await contentFixture();
  const foreign = f.card('foreign', 'q');
  const scope = name === '授权另一个项目'
    ? f.grant({ projectId: 'q', cardId: foreign.id, blockId: 'foreign-block', bodyVersionId: foreign.body.versionId })
    : f.grant();
  const token = f.issue(name === '未授权' ? undefined : [scope], undefined, ['p', 'q']);
  await denied(f, patch(f.card().body.versionId, fields), token, 403, code);
});

it('AC4 已收回持久会话的正文委托时拒绝，不从会话缓存恢复权限', async () => {
  const f = await contentFixture();
  const token = f.issue([f.grant()]);
  const hash = f.mapping.access.authenticate(token).tokenHash;
  f.mapping.access.db.prepare('UPDATE sessions SET capabilities=? WHERE token_hash=?')
    .run(JSON.stringify({ personalRecordProjects: ['p'], contentDelegations: [] }), hash);
  await denied(f, patch(f.card().body.versionId), token, 403, 'CONTENT_DELEGATION_REQUIRED');
});

it('AC1 旧正文委托缺少版本和选区时须重新签发', async () => {
  const f = await contentFixture();
  const token = f.issue();
  const legacy = { projectId: 'p', operations: ['body.patch'], objectKinds: ['card'], objectIds: ['card'], blockIds: ['paragraph'] };
  const hash = f.mapping.access.authenticate(token).tokenHash;
  f.mapping.access.db.prepare('UPDATE sessions SET capabilities=? WHERE token_hash=?')
    .run(JSON.stringify({ personalRecordProjects: ['p'], contentDelegations: [legacy] }), hash);
  await denied(f, patch(f.card().body.versionId), token, 403, 'CONTENT_DELEGATION_REQUIRED');
  await denied(f, command('project.rename', f.state().project.versionId, { name: '新项目名' }), token, 403, 'CONTENT_OPERATION_UNSUPPORTED');
});

it('AC1 补丁要落在同一条已授权区间内，并使用授权时的正文版本', async () => {
  const f = await contentFixture();
  const initialVersion = f.card().body.versionId;
  const token = f.issue([
    f.grant({ range: { start: 0, end: 2 } }),
    f.grant({ range: { start: 2, end: 4 } }),
  ]);
  await denied(f, patch(initialVersion, { range: { start: 1, end: 4 } }), token, 403, 'CONTENT_RANGE_FORBIDDEN');
  const inside = patch(initialVersion, { range: { start: 1, end: 2 }, text: '字' });
  expect((await f.post(inside, token)).status).toBe(200);
  expect(f.card().body.blocks[0]?.text).toBe('中字😀e\u0301结束');
  await denied(f, patch(f.card().body.versionId), token, 403, 'CONTENT_VERSION_FORBIDDEN');
});

it.each(['actor', 'origin', 'delegation'])('AC4 自报 %s 被拒绝', async (field) => {
  const f = await contentFixture();
  const token = f.issue([f.grant()]);
  await denied(f, { ...patch(f.card().body.versionId), [field]: '本人' }, token, 403, 'UNTRUSTED_PRINCIPAL');
});

it.each(['过期', '撤销', '重启后撤销'])('AC4 会话%s后无法写入', async (phase) => {
  const f = await contentFixture();
  const token = f.issue([f.grant()], undefined, ['p'], phase === '过期' ? -60_000 : 60_000);
  if (phase !== '过期') {
    f.mapping.access.revoke(createHash('sha256').update(token).digest('hex'));
    if (phase === '重启后撤销') await f.restart();
  }
  await denied(f, patch(f.card().body.versionId), token, 401, 'UNAUTHORIZED');
});

it.each(['卡片', '正文块'])('AC4 已删除%s返回 404', async (kind) => {
  const f = await contentFixture();
  const c = f.card();
  const token = f.issue([f.grant()]);
  if (kind === '卡片')
    f.apply('thought.delete', { thought: c.versionId, body: c.body.versionId, pose: c.item.versionId, appearance: null }, { id: c.id });
  else
    f.apply('body.edit', c.body.versionId, { id: c.id, blocks: [{ id: 'new-block', type: 'text', text: '新块' }] });
  await denied(f, patch(c.body.versionId), token, 404, 'NOT_FOUND');
});

it.each(['body.edit', 'card.edit'])('AC1 %s 整篇编辑仅本人可提交', async (type) => {
  const f = await contentFixture();
  const token = f.issue([f.grant()]);
  const expected = type === 'body.edit' ? 'stale' : { body: 'stale', pose: 'stale' };
  const payload = { id: 'card', text: '整篇替换', ...(type === 'card.edit' ? { x: 70, y: 80 } : {}) };
  await denied(f, command(type, expected, payload), token, 403, 'CONTENT_OPERATION_UNSUPPORTED');
  const c = f.card();
  const current = type === 'body.edit' ? c.body.versionId : { body: c.body.versionId, pose: c.item.versionId };
  await denied(f, command(type, current, payload), f.issue(), 403, 'CONTENT_OPERATION_UNSUPPORTED');
  expect((await f.post(command(type, current, payload))).status).toBe(200);
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
  await denied(f, command(type, versions[domain as keyof typeof versions], payload), f.issue([f.grant()]), 403, 'CONTENT_OPERATION_UNSUPPORTED');
});

it('AC4 只有项目访问权的 Agent 不能写正文；加正文范围也不能写附着或剪切', async () => {
  const f = await contentFixture();
  const card = f.card();
  await denied(f, patch(card.body.versionId), f.mapping.access.issue('agent', ['p']), 403, 'CONTENT_DELEGATION_REQUIRED');
  const token = f.issue([f.grant()]);
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
  ['不存在的卡', { cardId: 'missing' }],
  ['不属于选定卡的块', { blockId: 'second-block' }],
  ['未指定版本', { bodyVersionId: undefined }],
  ['旧的正文版本', { bodyVersionId: 'stale-version' }],
  ['未指定区间', { range: undefined }],
  ['超出块长度的区间', { range: { start: 0, end: 9 } }],
  ['切开代理对的区间', { range: { start: 3, end: 4 } }],
])('AC4 签发拒绝%s且不新增会话', async (_label, fields) => {
  const f = await contentFixture();
  const before = f.mapping.access.db.prepare('SELECT count(*) AS n FROM sessions').get();
  expect(() => f.issue([{ ...f.grant(), ...fields } as ReturnType<typeof f.grant>])).toThrowError(
    expect.objectContaining({ code: 'INVALID_SCOPE' }),
  );
  expect(f.mapping.access.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual(before);
});

function bodyGrantCli(f: ContentFixture) {
  writeFileSync(join(f.directory, 'local-access.json'), JSON.stringify({ url: `${f.origin}/#token=${f.humanToken}` }), { mode: 0o600 });
  const card = f.card();
  const selection = [
    '--card', card.id, '--block', 'paragraph', '--version', card.body.versionId, '--start', '0', '--end', '1',
  ];
  return (out: string, includeSelection = true) => spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/issue-body-grant.ts', '--data-dir', f.directory, '--project', 'p',
    ...(includeSelection ? selection : []), '--out', out,
  ], { encoding: 'utf8', timeout: 5_000 });
}

it('签发 CLI 要求显式选区，拒绝在工作台目录及其路径别名内输出令牌', async () => {
  const f = await contentFixture();
  const issue = bodyGrantCli(f);
  const temp = mkdtempSync(join(tmpdir(), 'forkwise-body-cli-'));
  try {
    const alias = join(temp, 'workspace');
    symlinkSync(f.directory, alias, 'dir');
    const card = f.card();
    const baseline = f.mapping.access.grants();
    for (const { out, includeSelection, message } of [
      { out: join(temp, 'missing-scope'), includeSelection: false, message: '--card' },
      { out: join(f.directory, 'grant'), message: '工作台数据目录之外' },
      { out: join(alias, 'grant'), message: '工作台数据目录之外' },
    ]) {
      const result = issue(out, includeSelection);
      expect(result.status, result.error?.message ?? result.stderr).toBe(2);
      expect(result.stderr).toContain(message);
      expect(existsSync(out)).toBe(false);
      expect(f.mapping.access.grants()).toEqual(baseline);
    }
    await f.restart();
    expect(f.card()).toEqual(card);
  } finally {
    rmSync(temp, { recursive: true });
  }
}, 20_000);

it('签发 CLI 拒绝写入另一工作台的数据目录，另一工作台仍可重开', async () => {
  const source = await contentFixture();
  const other = await contentFixture();
  const issue = bodyGrantCli(source);
  const temp = mkdtempSync(join(tmpdir(), 'forkwise-body-cli-'));
  try {
    const alias = join(temp, 'other-workspace');
    symlinkSync(other.directory, alias, 'dir');
    const baseline = source.mapping.access.grants();
    const card = other.card();
    for (const out of [join(other.directory, 'grant'), join(alias, 'grant')]) {
      const result = issue(out);
      expect(result.status, result.error?.message ?? result.stderr).toBe(2);
      expect(result.stderr).toContain('工作台数据目录之外');
      expect(existsSync(out)).toBe(false);
      expect(source.mapping.access.grants()).toEqual(baseline);
    }
    await other.restart();
    expect(other.card()).toEqual(card);
  } finally {
    rmSync(temp, { recursive: true });
  }
}, 20_000);

it('签发 CLI 按文件系统顺序解析 --out 中的符号链接和上级目录', async () => {
  const f = await contentFixture();
  const issue = bodyGrantCli(f);
  const temp = mkdtempSync(join(tmpdir(), 'forkwise-body-cli-'));
  try {
    const destination = join(temp, 'destination');
    const child = join(destination, 'child');
    mkdirSync(child, { recursive: true });
    const alias = join(temp, 'link');
    symlinkSync(child, alias, 'dir');
    const out = `${relative(process.cwd(), alias)}/../grant`;
    const result = issue(out);
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(temp, 'grant'))).toBe(false);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const token = readFileSync(out, 'utf8').trim();
    const hash = createHash('sha256').update(token).digest('hex');
    expect(result.stdout.trim()).toBe(hash.slice(0, 12));
    const grants = f.mapping.access.grants();
    const duplicate = issue(out);
    expect(duplicate.status, duplicate.error?.message ?? duplicate.stderr).toBe(1);
    expect(createHash('sha256').update(readFileSync(out, 'utf8').trim()).digest('hex')).toBe(hash);
    expect(f.mapping.access.grants()).toEqual(grants);
    const directoryOut = `${out}-directory`;
    const invalid = issue(`${directoryOut}/`);
    expect(invalid.status, invalid.error?.message ?? invalid.stderr).toBe(2);
    expect(existsSync(directoryOut)).toBe(false);
    expect((await f.post(patch(f.card().body.versionId), token)).status).toBe(200);
  } finally {
    rmSync(temp, { recursive: true });
  }
}, 20_000);
