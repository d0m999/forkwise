import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test, type Workspace } from './writing-board-fixture';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const artifacts = join(repo, 'backend/artifacts/issue45-20261109');
const systemClipboard = process.env.FORKWISE_SYSTEM_CLIPBOARD === '1';
const artifact = (name: string) => join(artifacts, name);

type Project = { project: { id: string; revision: number };
  cards: { id: string; title: string; item: { id: string; pose: { x: number; y: number } } }[];
  connectors?: { id: string }[] };
// 源/目标项目按 id 显式读取：workspace.state() 固定读首个项目，跨项目断言会假通过。
async function read(page: Page, workspace: Workspace, projectId: string): Promise<Project> {
  const response = await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}`);
  expect(response.ok(), `读取项目 ${projectId} 失败：${response.status()} ${await response.text()}`).toBe(true);
  return response.json() as Promise<Project>;
}
async function readClipboard(page: Page) {
  return page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
    return item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '';
  });
}
async function createProject(page: Page, previous: string) {
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  // 新建后 URL 先清空 project 参数再写入新 id；null !== previous 会提前通过，必须等真实 id。
  await expect.poll(() => {
    const id = new URL(page.url()).searchParams.get('project');
    return id && id !== previous ? id : null;
  }).not.toBeNull();
  const targetId = new URL(page.url()).searchParams.get('project')!;
  expect(targetId).not.toBe(previous);
  await expect(page.locator(`[role="tab"][title="${targetId}"]`)).toHaveAttribute('aria-selected', 'true');
  return targetId;
}
async function switchProject(page: Page, projectId: string) {
  await page.locator(`[role="tab"][title="${projectId}"]`).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(projectId);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
}
async function travel(page: Page, workspace: Workspace, projectId: string, name: '撤销' | '重做') {
  const before = (await read(page, workspace, projectId)).project.revision;
  await page.getByRole('button', { name, exact: true }).click();
  await expect.poll(async () => (await read(page, workspace, projectId)).project.revision, { timeout: 20000 }).toBeGreaterThan(before);
}
async function history(page: Page, workspace: Workspace, projectId: string) {
  return (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json() as Promise<{
    undo: { label: string }[]; redo: { label: string }[] }>;
}
async function cutState(page: Page, workspace: Workspace, projectId: string, cutId: string) {
  return (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/cuts/${cutId}`)).json();
}
// 一次性播种：甲、乙两张卡与单向连线；只切甲，乙留在源项目。
async function seed(page: Page, workspace: Workspace) {
  await workspace.open(page);
  const sourceId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) =>
    workspace.execute(page, { commandId: crypto.randomUUID(), projectId: sourceId, type, expected, payload });
  await execute('thought.create', { id: 'moved', title: '待搬动', text: '待搬动正文', x: 160, y: 200 });
  await execute('thought.create', { id: 'kept', title: '留下', text: '留在源项目', x: 620, y: 200 });
  const seeded = await read(page, workspace, sourceId);
  await execute('connector.create', { id: 'line', start: { kind: 'bound', itemId: seeded.cards.find(card => card.id === 'moved')!.item.id, side: 'right' },
    end: { kind: 'bound', itemId: seeded.cards.find(card => card.id === 'kept')!.item.id, side: 'left' }, path: 'straight' });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  return { sourceId, seeded: await read(page, workspace, sourceId) };
}
async function cutMoved(page: Page, workspace: Workspace, sourceId: string) {
  await page.getByRole('button', { name: '待搬动', exact: true }).click();
  await page.locator('.canvas').press('Meta+x');
  await expect.poll(async () => (await read(page, workspace, sourceId)).cards.some(card => card.id === 'moved')).toBe(false);
  const envelope = JSON.parse(await readClipboard(page));
  expect(envelope.cut).toMatchObject({ sourceProjectId: sourceId });
  return envelope.cut as { cutId: string; sourceProjectId: string };
}
async function pasteInto(page: Page, targetId: string) {
  await expect(page.locator(`[role="tab"][title="${targetId}"]`)).toHaveAttribute('aria-selected', 'true');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pane.x + 420, pane.y + 260);
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.locator('.canvas').press('Meta+v');
}

const pasteboardReader = `import Cocoa
let pasteboard = NSPasteboard.general
print("changeCount \\(pasteboard.changeCount)")
for item in pasteboard.pasteboardItems ?? [] {
  for type in item.types where type.rawValue == "public.utf8-plain-text" || type.rawValue.hasPrefix("org.w3.web-custom-format.") {
    let data = item.data(forType: type)
    print("TYPE \\(type.rawValue) BYTES \\(data?.count ?? 0)")
    if let data, type.rawValue == "org.w3.web-custom-format.type-0" {
      try? data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
    }
    if let data, let text = String(data: data, encoding: .utf8) { print(text) }
  }
}
`;
function readSystemPasteboard() {
  mkdirSync(artifacts, { recursive: true });
  const swift = artifact('read-pasteboard.swift'), reader = artifact('read-pasteboard'), snapshot = artifact('system-snapshot.json');
  writeFileSync(swift, pasteboardReader);
  if (!process.env.FORKWISE_SKIP_SWIFTC) execFileSync('swiftc', ['-o', reader, swift]);
  return { pasteboard: execFileSync(reader, [snapshot], { encoding: 'utf8' }), plain: execFileSync('pbpaste', { encoding: 'utf8' }), snapshot };
}

async function runFlow(page: Page, workspace: Workspace, system: boolean) {
  const { sourceId, seeded } = await seed(page, workspace);
  const cut = await cutMoved(page, workspace, sourceId);
  const cutAfter = await read(page, workspace, sourceId);
  expect(await cutState(page, workspace, sourceId, cut.cutId)).toMatchObject({ state: 'eligible', revision: 0 });
  if (system) {
    // 真实窗口：系统剪贴板必须读到同一 cut 信封，不能只看页面剪贴板。
    // 剪切已提交，对象已从画布移除，不能再靠重复 Meta+x 重试；只等系统剪贴板落定后读一次。
    await expect.poll(() => readSystemPasteboard().pasteboard.includes(cut.cutId), { timeout: 30000, intervals: [500] }).toBe(true);
    const systemRead = readSystemPasteboard();
    writeFileSync(artifact('nspasteboard.txt'), systemRead.pasteboard);
    expect(systemRead.pasteboard).toContain(cut.cutId);
  }

  const targetId = await createProject(page, sourceId);
  await pasteInto(page, targetId);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await read(page, workspace, targetId)).cards.length).toBe(1);
  const target = await read(page, workspace, targetId);
  const pasted = target.cards[0]!;
  expect(pasted.id).not.toBe('moved');
  expect(pasted.item.id).not.toBe(seeded.cards.find(card => card.id === 'moved')!.item.id);
  expect(pasted.title).toBe('待搬动');
  // B 只放搬动的甲；未选中的外线不进入 B（D350），留下来的乙仍在 A。
  expect(target.connectors ?? []).toHaveLength(0);
  expect((await read(page, workspace, sourceId)).cards.map(card => card.id).sort()).toEqual(['kept']);
  expect(await read(page, workspace, sourceId)).toEqual(cutAfter);
  const sourceHistory = await history(page, workspace, sourceId);
  expect(sourceHistory.undo.at(-1)).toMatchObject({ label: 'canvas.cut' });
  expect(sourceHistory.undo.some(action => action.label === 'canvas.paste' || action.label === 'canvas.paste-cut')).toBe(false);
  expect(await cutState(page, workspace, sourceId, cut.cutId)).toMatchObject({ state: 'eligible', revision: 0 });

  // B 的撤销/重做只影响 B。
  await travel(page, workspace, targetId, '撤销');
  expect((await read(page, workspace, targetId)).cards).toHaveLength(0);
  expect(await read(page, workspace, sourceId)).toEqual(cutAfter);
  await travel(page, workspace, targetId, '重做');
  expect((await read(page, workspace, targetId)).cards.map(card => card.id)).toEqual([pasted.id]);
  expect(await read(page, workspace, sourceId)).toEqual(cutAfter);

  // 返回 A 撤销剪切只恢复 A，B 的内容保留（D353）。
  await switchProject(page, sourceId);
  await travel(page, workspace, sourceId, '撤销');
  const restored = await read(page, workspace, sourceId);
  expect(restored.cards.map(card => card.id).sort()).toEqual(['kept', 'moved']);
  expect(restored.connectors!.map(line => line.id)).toEqual(['line']);
  expect(await cutState(page, workspace, sourceId, cut.cutId)).toMatchObject({ state: 'cut-undone' });
  expect((await read(page, workspace, targetId)).cards.map(card => card.id)).toEqual([pasted.id]);
  await travel(page, workspace, sourceId, '重做');
  expect((await read(page, workspace, sourceId)).cards.map(card => card.id).sort()).toEqual(['kept']);

  // 本轮决定：保持剪贴板回 A 粘贴。资格仍是 eligible，恢复原身份与有效外线。
  await pasteInto(page, sourceId);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await read(page, workspace, sourceId)).cards.length).toBe(2);
  const backHome = await read(page, workspace, sourceId);
  const original = backHome.cards.find(card => card.id === 'moved')!;
  expect(original.item.id).toBe(seeded.cards.find(card => card.id === 'moved')!.item.id);
  expect(original.item.pose).not.toEqual(seeded.cards.find(card => card.id === 'moved')!.item.pose);
  expect((backHome.connectors ?? []).map(line => line.id)).toEqual(['line']);
  expect(await cutState(page, workspace, sourceId, cut.cutId)).toMatchObject({ state: 'consumed' });
  expect((await read(page, workspace, targetId)).cards.map(card => card.id)).toEqual([pasted.id]);

  // 两边分别撤销/重做，互不影响。
  await travel(page, workspace, sourceId, '撤销');
  expect((await read(page, workspace, sourceId)).cards.map(card => card.id)).toEqual(['kept']);
  expect(await cutState(page, workspace, sourceId, cut.cutId)).toMatchObject({ state: 'eligible' });
  expect((await read(page, workspace, targetId)).cards.map(card => card.id)).toEqual([pasted.id]);
  await travel(page, workspace, sourceId, '重做');
  expect((await read(page, workspace, sourceId)).cards.map(card => card.id).sort()).toEqual(['kept', 'moved']);
  // 撤销按钮作用于当前项目：切到 B 再操作，避免误改 A。
  await switchProject(page, targetId);
  await travel(page, workspace, targetId, '撤销');
  expect((await read(page, workspace, targetId)).cards).toHaveLength(0);
  expect((await read(page, workspace, sourceId)).cards.map(card => card.id).sort()).toEqual(['kept', 'moved']);
  await travel(page, workspace, targetId, '重做');
  expect((await read(page, workspace, targetId)).cards.map(card => card.id)).toEqual([pasted.id]);

  // 服务与页面重开：两边内容、身份与剪切资格都保持。
  await workspace.restart();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await read(page, workspace, sourceId)).cards.map(card => card.id).sort()).toEqual(['kept', 'moved']);
  expect((await read(page, workspace, targetId)).cards.map(card => card.id)).toEqual([pasted.id]);
  expect(await cutState(page, workspace, sourceId, cut.cutId)).toMatchObject({ state: 'consumed' });

  mkdirSync(artifacts, { recursive: true });
  writeFileSync(artifact(system ? 'headed-flow.json' : 'headless-flow.json'), JSON.stringify({
    issue: 45, run: system ? 'headed' : 'headless', at: new Date().toISOString(),
    sourceId, targetId, cutId: cut.cutId, pastedCardId: pasted.id, originalItemId: original.item.id,
  }, null, 2));
}

test.describe('跨项目剪切主流程', () => {
  test.skip(systemClipboard, '系统剪贴板验收只跑 headed 主流程');
  test('A 剪切→B 粘贴→回 A 粘贴→两边独立撤销重做→重开', async ({ page, workspace }) => {
    test.setTimeout(300000);
    await runFlow(page, workspace, false);
  });
});

test.describe('目标请求丢 ACK 后的恢复', () => {
  test.skip(systemClipboard, '系统剪贴板验收只跑 headed 主流程');
  test('服务端已提交但响应丢失，刷新按原 commandId 重放且只产生一批对象与一条历史', async ({ page, workspace }) => {
    test.setTimeout(180000);
    const { sourceId } = await seed(page, workspace);
    const cut = await cutMoved(page, workspace, sourceId);
    const targetId = await createProject(page, sourceId);
    let dropped = false;
    const route = '**/api/mapping/execute';
    await page.route(route, async handler => {
      const body = handler.request().postDataJSON() as { type?: string } | null;
      if (!dropped && body?.type === 'canvas.paste') {
        dropped = true;
        await handler.fetch();
        await handler.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '模拟响应丢失' }) });
        return;
      }
      await handler.continue();
    });
    await pasteInto(page, targetId);
    await expect(page.getByRole('alert')).toContainText('模拟响应丢失');
    // 服务端已提交：目标已有一张卡，客户端保留恢复记录。
    await expect.poll(async () => (await read(page, workspace, targetId)).cards.length).toBe(1);
    const recordKey = `forkwise.paste-pending.v1:${targetId}`;
    expect(await page.evaluate(key => localStorage.getItem(key), recordKey)).not.toBeNull();
    await page.unroute(route);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const target = await read(page, workspace, targetId);
    expect(target.cards).toHaveLength(1);
    const targetHistory = await history(page, workspace, targetId);
    expect(targetHistory.undo.filter(action => action.label === 'canvas.paste')).toHaveLength(1);
    expect(await page.evaluate(key => localStorage.getItem(key), recordKey)).toBeNull();
    expect(await cutState(page, workspace, sourceId, cut.cutId)).toMatchObject({ state: 'eligible', revision: 0 });
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(artifact('recovery-ack.json'), JSON.stringify({ issue: 45, at: new Date().toISOString(),
      targetId, cards: target.cards.length, pasteActions: targetHistory.undo.filter(action => action.label === 'canvas.paste').length }, null, 2));
  });
});

test.describe('丢 ACK 后页面内重试', () => {
  test.skip(systemClipboard, '系统剪贴板验收只跑 headed 主流程');
  test('重试按钮沿用原请求与恢复选项，成功后清理记录且不重复粘贴', async ({ page, workspace }) => {
    test.setTimeout(180000);
    const { sourceId } = await seed(page, workspace);
    await cutMoved(page, workspace, sourceId);
    const targetId = await createProject(page, sourceId);
    let dropped = false;
    await page.route('**/api/mapping/execute', async handler => {
      const body = handler.request().postDataJSON() as { type?: string } | null;
      if (!dropped && body?.type === 'canvas.paste') {
        dropped = true;
        await handler.fetch();
        await handler.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '模拟响应丢失' }) });
        return;
      }
      await handler.continue();
    });
    await pasteInto(page, targetId);
    await expect(page.getByRole('alert')).toContainText('模拟响应丢失');
    await page.unroute('**/api/mapping/execute');
    const recordKey = `forkwise.paste-pending.v1:${targetId}`;
    expect(await page.evaluate(key => localStorage.getItem(key), recordKey)).not.toBeNull();
    // 页面内重试必须带原 options：否则回执成功也不会清记录，后续粘贴被永久挡住。
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect((await read(page, workspace, targetId)).cards).toHaveLength(1);
    const targetHistory = await history(page, workspace, targetId);
    expect(targetHistory.undo.filter(action => action.label === 'canvas.paste')).toHaveLength(1);
    expect(await page.evaluate(key => localStorage.getItem(key), recordKey)).toBeNull();
  });
});

test.describe('恢复记录写入失败', () => {
  test.skip(systemClipboard, '系统剪贴板验收只跑 headed 主流程');
  test('写不进恢复记录时停止目标提交，源内容仍可由源历史恢复', async ({ page, workspace }) => {
    test.setTimeout(180000);
    const { sourceId } = await seed(page, workspace);
    await cutMoved(page, workspace, sourceId);
    const targetId = await createProject(page, sourceId);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (String(key).startsWith('forkwise.paste-pending.')) throw new Error('quota');
        return original.call(this, key, value);
      };
    });
    await pasteInto(page, targetId);
    await expect(page.getByRole('alert')).toContainText('无法保存粘贴恢复记录');
    expect((await read(page, workspace, targetId)).cards).toHaveLength(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise.paste-pending.')))).toEqual([]);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    // 源内容仍在原项目历史里：撤销剪切即可恢复。
    await switchProject(page, sourceId);
    await travel(page, workspace, sourceId, '撤销');
    const restored = await read(page, workspace, sourceId);
    expect(restored.cards.map(card => card.id).sort()).toEqual(['kept', 'moved']);
  });
});

test.describe('提交成功但读取失败', () => {
  test.skip(systemClipboard, '系统剪贴板验收只跑 headed 主流程');
  test('已确认提交先清记录，读取失败刷新后不重复粘贴', async ({ page, workspace }) => {
    test.setTimeout(180000);
    const { sourceId } = await seed(page, workspace);
    await cutMoved(page, workspace, sourceId);
    const targetId = await createProject(page, sourceId);
    let failedRead = false;
    const route = '**/api/mapping/projects/*/map*';
    await page.route(route, async handler => {
      if (!failedRead && handler.request().url().includes(targetId)) {
        failedRead = true;
        await handler.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '模拟读取失败' }) });
        return;
      }
      await handler.continue();
    });
    await pasteInto(page, targetId);
    await expect(page.getByRole('alert')).toContainText(/读取|无法|失败|本机服务/);
    expect((await read(page, workspace, targetId)).cards).toHaveLength(1);
    const recordKey = `forkwise.paste-pending.v1:${targetId}`;
    expect(await page.evaluate(key => localStorage.getItem(key), recordKey)).toBeNull();
    await page.unroute(route);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect((await read(page, workspace, targetId)).cards).toHaveLength(1);
    const targetHistory = await history(page, workspace, targetId);
    expect(targetHistory.undo.filter(action => action.label === 'canvas.paste')).toHaveLength(1);
  });
});

test.describe('AC5 系统剪贴板跨项目剪切', () => {
  test.skip(!systemClipboard, 'AC5 需真实窗口：FORKWISE_SYSTEM_CLIPBOARD=1 npx playwright test tests/canvas-cross-project-cut.spec.ts --workers=1');
  test('真实系统剪贴板读回同一 cut 信封并完成跨项目搬动', async ({ page, workspace }) => {
    test.setTimeout(300000);
    await runFlow(page, workspace, true);
  });
});

// 供 headed 回执引用原始系统载荷路径；headless 不读取。
export const systemArtifact = relative(repo, artifact('nspasteboard.txt'));
