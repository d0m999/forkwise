import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { LayoutDelegation } from '../src/services/access.js';
import { command, contentFixture, patch, type ContentFixture } from './fixtures/agent-content.js';

const moveScope: LayoutDelegation = {
  projectId: 'p', operations: ['pose.move'], objectKinds: ['card'], objectIds: ['card'], fields: ['x', 'y'],
};

it('带旧项目编辑标记的布局会话只可移动卡片；无细化范围的一般委托仍可改名', async () => {
  const f = await contentFixture();
  const layout = f.issue(undefined, [moveScope]);
  const rename = command('project.rename', f.state().project.versionId, { name: '十一月研究' });
  const before = f.snapshot();
  expect((await f.post(rename, layout)).status).toBe(403);
  expect(f.snapshot()).toEqual(before);
  expect((await f.post(command('pose.move', f.card().item.versionId, { id: 'card', x: 80, y: 60 }), layout)).status).toBe(200);
  expect((await f.post(rename, f.issue())).status).toBe(200);
});

it('同时委托布局与正文可以分别写入各自范围，无需项目编辑标记', async () => {
  const f = await contentFixture();
  const token = f.mapping.access.issue('agent', ['p'], 60_000, undefined, [], [moveScope], [f.grant()]);
  expect((await f.post(patch(f.card().body.versionId), token)).status).toBe(200);
  expect((await f.post(command('pose.move', f.card().item.versionId, { id: 'card', x: 80, y: 60 }), token)).status).toBe(200);
  const before = f.snapshot();
  expect((await f.post(command('project.rename', f.state().project.versionId, { name: '十一月研究' }), token)).status).toBe(403);
  expect(f.snapshot()).toEqual(before);
});

function layoutCli(f: ContentFixture) {
  writeFileSync(join(f.directory, 'local-access.json'), JSON.stringify({ url: `${f.origin}/#token=${f.humanToken}` }), { mode: 0o600 });
  return (out: string) => spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/issue-layout-grant.ts', '--data-dir', f.directory,
    '--project', 'p', '--objects', 'card', '--out', out,
  ], { encoding: 'utf8', timeout: 5_000 });
}

const outputs: string[] = [];
afterEach(() => { for (const dir of outputs.splice(0)) rmSync(dir, { recursive: true }); });
function outputDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'forkwise-layout-cli-'));
  outputs.push(dir);
  return dir;
}

it('布局 CLI 签发的私有令牌可读取和移动指定卡片，仅授予布局范围', async () => {
  const f = await contentFixture();
  const out = join(outputDirectory(), 'grant');
  const result = layoutCli(f)(out);
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  const token = readFileSync(out, 'utf8').trim();
  expect(result.stdout.includes(token)).toBe(false);
  expect(f.mapping.access.grants()).toMatchObject([{ personalRecordProjects: [] }]);
  expect((await f.request('/api/mapping/projects/p/history', token)).status).toBe(200);
  expect((await f.post(command('pose.move', f.card().item.versionId, { id: 'card', x: 80, y: 60 }), token)).status).toBe(200);
  const before = f.snapshot();
  expect((await f.post(command('project.rename', f.state().project.versionId, { name: '十一月研究' }), token)).status).toBe(403);
  expect(f.snapshot()).toEqual(before);
});

it('布局 CLI 保留已有 --out 文件的内容与权限，也不新增会话', async () => {
  const f = await contentFixture();
  const issue = layoutCli(f);
  const dir = outputDirectory();
  const existing = join(dir, '研究记录');
  writeFileSync(existing, '保留原文', { mode: 0o640 });
  const originalMode = statSync(existing).mode;
  const grants = f.mapping.access.grants();
  expect(issue(existing).status).toBe(1);
  expect(readFileSync(existing, 'utf8') === '保留原文').toBe(true);
  expect(statSync(existing).mode).toBe(originalMode);
  expect(f.mapping.access.grants()).toEqual(grants);
});

it('布局 CLI 的输出父目录不存在时不留下已签发的会话', async () => {
  const f = await contentFixture();
  const grants = f.mapping.access.grants();
  const missing = join(outputDirectory(), '不存在', 'grant');
  expect(layoutCli(f)(missing).status).toBe(1);
  expect(existsSync(missing)).toBe(false);
  expect(f.mapping.access.grants()).toEqual(grants);
});

it('会话无法写入 SQLite 时清理本次 CLI 创建的输出', async () => {
  const f = await contentFixture();
  const issue = layoutCli(f);
  const out = join(outputDirectory(), 'grant');
  const grants = f.mapping.access.grants();
  f.mapping.access.db.exec(`CREATE TRIGGER reject_grant BEFORE INSERT ON sessions
    WHEN NEW.type = 'agent' BEGIN SELECT RAISE(ABORT, 'injected session failure'); END`);
  expect(issue(out).status).toBe(1);
  expect(existsSync(out)).toBe(false);
  expect(f.mapping.access.grants()).toEqual(grants);
});

it('布局 CLI 拒绝在工作台数据目录内留下输出，工作台仍可重开', async () => {
  const f = await contentFixture();
  const card = f.card();
  const out = join(f.directory, 'grant');
  const grants = f.mapping.access.grants();
  expect(layoutCli(f)(out).status).toBe(2);
  expect(existsSync(out)).toBe(false);
  expect(f.mapping.access.grants()).toEqual(grants);
  await f.restart();
  expect(f.card()).toEqual(card);
});
