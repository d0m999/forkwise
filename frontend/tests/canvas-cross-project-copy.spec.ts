import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { openMapping } from '../../backend/src/mapping/storage';
import { expect, test, type Workspace } from './writing-board-fixture';

const YELLOW = '#f8dfc4';
const BLUE = '#d9e7f1';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#43a89a"/></svg>';
const base64 = Buffer.from(svg).toString('base64');

const repo = fileURLToPath(new URL('../..', import.meta.url));
const artifacts = join(repo, 'backend/artifacts/issue34-20261107');
const evidence = join(repo, 'docs/plans/evidence/issue-34-cross-project-copy-2026-11-07.json');
const systemClipboard = process.env.FORKWISE_SYSTEM_CLIPBOARD === '1';
const artifact = (name: string) => join(artifacts, name);
const artifactRef = (name: string) => relative(repo, artifact(name));
type CheckStatus = 'EXECUTED' | 'NOT_RUN';

// 只读取快照相关类型；type-0 原始字节另存 artifacts，权限拒绝路径从系统读回值构造载荷。
const pasteboardReader = `import Cocoa
let pasteboard = NSPasteboard.general
let snapshotOut = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil
print("changeCount \\(pasteboard.changeCount)")
for item in pasteboard.pasteboardItems ?? [] {
  for type in item.types where type.rawValue == "public.utf8-plain-text" || type.rawValue.hasPrefix("org.w3.web-custom-format.") {
    let data = item.data(forType: type)
    print("TYPE \\(type.rawValue) BYTES \\(data?.count ?? 0)")
    if type.rawValue == "org.w3.web-custom-format.type-0" {
      if let bytes = data, let out = snapshotOut {
        try? bytes.write(to: URL(fileURLWithPath: out))
      }
    }
    if let data, let text = String(data: data, encoding: .utf8) {
      print(text)
    }
  }
}
`;

function buildPasteboardReader() {
  const swift = join(artifacts, 'read-pasteboard.swift');
  const reader = join(artifacts, 'read-pasteboard');
  const snapshot = join(artifacts, 'system-snapshot.json');
  writeFileSync(swift, pasteboardReader);
  execFileSync('swiftc', ['-o', reader, swift]);
  return { reader, snapshot };
}

function readSystemPasteboard(reader: string, snapshot: string) {
  return {
    pasteboard: execFileSync(reader, [snapshot], { encoding: 'utf8' }),
    plain: execFileSync('pbpaste', { encoding: 'utf8' }),
  };
}

async function runCopyFlow(page: Page, workspace: Workspace, system: boolean) {
  const checks: Record<string, { status: CheckStatus; via: string }> = {};
  const sourceId = (await workspace.state()).project.id;
  const execute = (projectId: string, type: string, payload: unknown, expected: unknown = null) =>
    workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  const read = async (projectId: string) => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}`)).json();
  await execute(sourceId, 'tag.create', { id: 'src-ai', name: 'AI' });
  let source = await read(sourceId);
  await execute(sourceId, 'tag.update', { id: 'src-ai', color: YELLOW }, source.tags.find((tag: { id: string }) => tag.id === 'src-ai').versionId);
  await execute(sourceId, 'tag.create', { id: 'src-defi', name: 'DeFi' });
  source = await read(sourceId);
  await execute(sourceId, 'tag.update', { id: 'src-defi', color: YELLOW }, source.tags.find((tag: { id: string }) => tag.id === 'src-defi').versionId);
  await execute(sourceId, 'thought.create', { id: 'source-card', title: '市场观察', text: '需求增长', x: 80, y: 120 });
  await execute(sourceId, 'card.tags', { id: 'source-card', tagIds: ['src-defi', 'src-ai'] });
  await execute(sourceId, 'asset.save', { id: 'src-asset', name: '图.svg', mime: 'image/svg+xml', base64 });
  source = await read(sourceId);
  await execute(sourceId, 'body.edit', {
    id: 'source-card',
    blocks: [
      { id: 'words', type: 'text', text: '需求增长' },
      { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.svg', mime: 'image/svg+xml', naturalWidth: 160, naturalHeight: 120 },
    ],
  }, source.cards.find((card: { id: string }) => card.id === 'source-card').body.versionId);

  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(sourceId);
  const targetId = new URL(page.url()).searchParams.get('project')!;
  await execute(targetId, 'tag.create', { id: 'dst-ai', name: 'ai' });
  let target = await read(targetId);
  await execute(targetId, 'tag.update', { id: 'dst-ai', color: BLUE }, target.tags.find((tag: { id: string }) => tag.id === 'dst-ai').versionId);
  target = await read(targetId);
  const reusedVersion = target.tags.find((tag: { id: string }) => tag.id === 'dst-ai').versionId;

  await page.locator(`[role="tab"][title="${sourceId}"]`).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(sourceId);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  mkdirSync(artifacts, { recursive: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '市场观察', exact: true }).click();
  const readPageClipboard = () => page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
    return {
      raw: item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '',
      text: await navigator.clipboard.readText(),
    };
  });
  await page.keyboard.press('Meta+c');
  await expect.poll(async () => (await readPageClipboard()).raw).toContain('"library"');
  const clipboard = await readPageClipboard();
  writeFileSync(artifact('browser-clipboard.json'), clipboard.raw);
  expect(clipboard.text).toContain('市场观察');

  let deniedLibrary: unknown = JSON.parse(clipboard.raw).library;
  let deniedSource = '页面剪贴板（headless 无系统读回值）';
  let systemTypes: string[] = [];
  const sources: Record<string, string> = {
    pageClipboard: artifactRef('browser-clipboard.json'),
  };
  if (system) {
    const { reader, snapshot } = buildPasteboardReader();
    const readSystem = () => readSystemPasteboard(reader, snapshot);
    // headless Chromium 的页面剪贴板与系统剪贴板分离，系统侧读取只在 headed 运行里成立。
    await expect.poll(async () => {
      const current = readSystem();
      if (current.plain.includes('市场观察') && current.pasteboard.includes(clipboard.raw) && current.pasteboard.includes('application/x-forkwise-canvas')) return true;
      await page.keyboard.press('Meta+c');
      return false;
    }, { timeout: 30000, intervals: [1000] }).toBe(true);
    const current = readSystem();
    writeFileSync(artifact('nspasteboard.txt'), current.pasteboard);
    writeFileSync(artifact('pbpaste.txt'), current.plain);
    expect(current.plain).toContain('市场观察');
    expect(current.pasteboard).toContain(clipboard.raw);
    expect(current.pasteboard).toContain('application/x-forkwise-canvas');
    systemTypes = [...new Set([...current.pasteboard.matchAll(/TYPE (\S+)/g)].map(match => match[1]))];
    deniedLibrary = JSON.parse(readFileSync(snapshot, 'utf8')).library;
    deniedSource = '系统剪贴板 org.w3.web-custom-format.type-0 读回快照';
    checks.systemClipboard = { status: 'EXECUTED', via: 'NSPasteboard reader + pbpaste，原始载荷见 artifacts/' };
    sources.systemPasteboard = artifactRef('nspasteboard.txt');
    sources.pbpaste = artifactRef('pbpaste.txt');
    sources.systemSnapshot = artifactRef('system-snapshot.json');
  } else {
    checks.systemClipboard = { status: 'NOT_RUN', via: 'headless 无系统剪贴板，AC5 系统侧需 FORKWISE_SYSTEM_CLIPBOARD=1 的 headed 项目' };
  }

  const host = openMapping(workspace.directory);
  const agent = host.access.issue('agent', [sourceId], undefined, undefined, [sourceId]);
  host.close();
  const beforeDenial = await read(targetId);
  const denied = await page.request.post(`${workspace.origin}/api/mapping/execute`, {
    data: {
      commandId: 'denied-paste', projectId: targetId, type: 'canvas.paste', expected: null,
      payload: { translation: { x: 12, y: 12 }, library: deniedLibrary, objects: [{
        kind: 'card', copyId: 'denied-card', stack: 1, title: '市场观察',
        blocks: [{ id: 'words', type: 'text', text: '需求增长' }], tagIds: ['src-defi', 'src-ai'], appearance: null,
        pose: { x: 80, y: 120, width: 280, height: 160 },
      }], connectors: [] },
    },
    headers: { Origin: workspace.origin, Authorization: `Bearer ${agent}` },
  });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ code: 'PROJECT_FORBIDDEN' });
  expect(await read(targetId)).toEqual(beforeDenial);
  checks.denied = { status: 'EXECUTED', via: `HTTP 403 PROJECT_FORBIDDEN 且目标不变；library 来源 ${deniedSource}` };

  const frozen = await read(sourceId);
  await page.locator(`[role="tab"][title="${targetId}"]`).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(targetId);
  checks.switch = { status: 'EXECUTED', via: 'tab 点击切换源→目标→源→目标，按 URL project 参数校验' };
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pane.x + 420, pane.y + 260);
  await page.locator('.canvas').press('Meta+v');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await read(targetId)).cards.length).toBe(1);
  target = await read(targetId);
  const pasted = target.cards[0];
  const created = target.tags.find((tag: { name: string }) => tag.name === 'DeFi');
  const reused = target.tags.find((tag: { id: string }) => tag.id === 'dst-ai');
  expect(pasted.id).not.toBe('source-card');
  expect(pasted.cardTags.tagIds).toEqual([created.id, 'dst-ai']);
  expect(created.id).not.toBe('src-defi');
  expect(created).toMatchObject({ color: YELLOW, deleted: false });
  expect(reused).toMatchObject({ name: 'ai', color: BLUE, deleted: false, versionId: reusedVersion });
  const assetId = pasted.body.blocks.find((block: { type: string }) => block.type === 'image').assetId;
  expect(assetId).not.toBe('src-asset');
  const asset = await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}/assets/${assetId}`);
  expect(asset.status()).toBe(200);
  expect(await asset.json()).toMatchObject({ name: '图.svg', mime: 'image/svg+xml', base64 });
  expect((await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}/assets/src-asset`)).status()).toBe(409);
  expect(await read(sourceId)).toEqual(frozen);
  checks.paste = { status: 'EXECUTED', via: `Meta+v 经${system ? '系统' : '页面'}剪贴板 + read(targetId) 独立身份/标签/资源与源项目不变断言` };

  await workspace.restart();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await read(targetId)).cards.map((card: { id: string }) => card.id)).toEqual([pasted.id]);
  checks.reopen = { status: 'EXECUTED', via: 'workspace.restart() + page.reload() 后同内容读取（与剪贴板通道无关）' };
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await read(targetId)).cards.length).toBe(0);
  target = await read(targetId);
  expect(target.tags.find((tag: { id: string }) => tag.id === created.id)).toMatchObject({ deleted: true, name: 'DeFi', color: YELLOW });
  expect(target.tags.find((tag: { id: string }) => tag.id === 'dst-ai').versionId).toBe(reusedVersion);
  expect((await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}/assets/${assetId}`)).status()).toBe(409);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await read(targetId)).toEqual(target);
  expect(await read(sourceId)).toEqual(frozen);
  checks.undo = { status: 'EXECUTED', via: '撤销按钮 + reload 后目标与源项目状态一致（与剪贴板通道无关）' };

  // 全部断言通过后才落回执。正式 AC5 回执只由 headed 运行产出；headless 只留页面剪贴板路径结果，
  // 不带 AC5 标记，原始载荷一律留在 artifacts/。
  const receipt = system
    ? { issue: 34, ac: 'AC5', scope: 'system-clipboard', run: 'headed', at: new Date().toISOString(), systemTypes, checks, sources }
    : { issue: 34, scope: 'page-clipboard-only', run: 'headless', at: new Date().toISOString(), checks, sources };
  if (system) {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, JSON.stringify(receipt, null, 2));
  } else {
    writeFileSync(artifact('headless-paths.json'), JSON.stringify(receipt, null, 2));
  }
}

test.describe('页面剪贴板四路径', () => {
  test.skip(systemClipboard, 'headed 项目由 AC5 系统剪贴板用例覆盖完整流程');
  test('真实键盘跨项目切换、粘贴、重开、撤销与权限拒绝', async ({ page, workspace }) => {
    test.setTimeout(180000);
    await runCopyFlow(page, workspace, false);
  });
});

test.describe('AC5 系统剪贴板验收', () => {
  test.skip(!systemClipboard, 'AC5 系统侧验证需真实窗口：FORKWISE_SYSTEM_CLIPBOARD=1 npx playwright test tests/canvas-cross-project-copy.spec.ts');
  test('真实系统剪贴板跨项目复制、粘贴、重开、撤销与权限拒绝', async ({ page, workspace }) => {
    test.setTimeout(180000);
    await runCopyFlow(page, workspace, true);
  });
});
