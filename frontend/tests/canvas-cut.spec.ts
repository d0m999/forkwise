import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test, type Workspace } from './writing-board-fixture';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const artifacts = join(repo, 'backend/artifacts/issue33-20261107');
const evidence = join(repo, 'docs/plans/evidence/issue-33-same-project-cut-2026-11-07.json');
const systemClipboard = process.env.FORKWISE_SYSTEM_CLIPBOARD === '1';
const artifact = (name: string) => join(artifacts, name);
const artifactRef = (name: string) => relative(repo, artifact(name));
type CheckStatus = 'EXECUTED' | 'NOT_RUN';

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
  execFileSync('swiftc', ['-o', reader, swift]);
  return {
    pasteboard: execFileSync(reader, [snapshot], { encoding: 'utf8' }),
    plain: execFileSync('pbpaste', { encoding: 'utf8' }),
    snapshot,
  };
}

async function runCutFlow(page: Page, workspace: Workspace, system: boolean) {
  const checks: Record<string, { status: CheckStatus; via: string }> = {};
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) =>
    workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  const read = () => workspace.state();
  // 历史按钮是异步命令：等到项目 revision 前进再断言，避免点击落在保存阻塞窗口里。
  const travel = async (name: '撤销' | '重做') => {
    const before = (await read()).project.revision;
    await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(async () => (await read()).project.revision, { timeout: 20000 }).toBeGreaterThan(before);
  };
  const cutState = async (cutId: string) => {
    const response = await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/cuts/${cutId}`);
    return { status: response.status(), body: await response.json() };
  };
  await execute('thought.create', { id: 'a', title: '甲', text: '甲的正文', x: 120, y: 160 });
  await execute('thought.create', { id: 'b', title: '乙', text: '乙的正文', x: 620, y: 160 });
  const seeded = await read();
  const a = seeded.cards.find(card => card.id === 'a')!;
  const b = seeded.cards.find(card => card.id === 'b')!;
  await execute('connector.create', { id: 'line', start: { kind: 'bound', itemId: a.item.id, side: 'right' },
    end: { kind: 'bound', itemId: b.item.id, side: 'left' }, path: 'straight' });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  mkdirSync(artifacts, { recursive: true });

  // AC1：浏览器权限层真实拒绝 clipboard.write（CDP Browser.setPermission=denied），
  // 不改写 navigator.clipboard.write、不靠 JS 打桩；前置 probe 证明权限确实被拒。
  const cdp = await page.context().newCDPSession(page);
  const clipboardPermission = { name: 'clipboard-write' };
  await cdp.send('Browser.setPermission', { permission: clipboardPermission, setting: 'denied', origin: workspace.origin });
  const writeRejected = await page.evaluate(async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['probe'], { type: 'text/plain' }) })]);
      return false;
    } catch { return true; }
  });
  expect(writeRejected).toBe(true);
  await page.getByRole('button', { name: '甲', exact: true }).click();
  await page.locator('.canvas').press('Meta+x');
  await expect(page.getByRole('alert')).toContainText('无法写入剪贴板');
  const afterDenied = await read();
  expect(afterDenied.cards.map(card => card.id).sort()).toEqual(['a', 'b']);
  expect(afterDenied.connectors!.map(line => line.id)).toEqual(['line']);
  const deniedHistory = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
  expect(deniedHistory.undo.some((action: { label: string }) => action.label === 'canvas.cut')).toBe(false);
  checks.clipboardDenied = { status: 'EXECUTED', via: 'CDP Browser.setPermission(clipboard-write=denied) 让真实 navigator.clipboard.write reject（前置 probe 已断言），Meta+x 后对象/连线/历史不变；OS 层 NSPasteboard 写入失败仍未构造' };
  await cdp.send('Browser.setPermission', { permission: clipboardPermission, setting: 'granted', origin: workspace.origin });
  await cdp.detach();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(pane.x + 380, pane.y + 420);
  await page.getByRole('button', { name: '甲', exact: true }).click();
  await page.locator('.canvas').press('Meta+x');
  await expect.poll(async () => (await read()).cards.map(card => card.id)).toEqual(['b']);
  const cut = await read();
  expect(cut.connectors).toEqual([]);
  checks.remove = { status: 'EXECUTED', via: 'Meta+x 后 read(project) 只剩乙且连线消失' };

  const readPageClipboard = () => page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
    return item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '';
  });
  await expect.poll(async () => await readPageClipboard()).toContain('"cut"');
  const raw = await readPageClipboard();
  writeFileSync(artifact('browser-clipboard-cut.json'), raw);
  const envelope = JSON.parse(raw);
  expect(envelope.cut).toMatchObject({ sourceProjectId: projectId });
  expect(typeof envelope.cut.cutId).toBe('string');
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'eligible', revision: 0 });
  checks.envelope = { status: 'EXECUTED', via: `页面剪贴板含 cut.sourceProjectId/cutId，服务端记录 eligible；原始载荷 ${artifactRef('browser-clipboard-cut.json')}` };
  if (system) {
    // headed 运行里系统剪贴板与页面剪贴板共用同一份写入：从 NSPasteboard 读回同一切割信封。
    const current = readSystemPasteboard();
    writeFileSync(artifact('nspasteboard.txt'), current.pasteboard);
    writeFileSync(artifact('pbpaste.txt'), current.plain);
    expect(current.plain).toContain('甲');
    expect(current.pasteboard).toContain('application/x-forkwise-canvas');
    expect(current.pasteboard).toContain(envelope.cut.cutId);
    expect(JSON.parse(readFileSync(current.snapshot, 'utf8')).cut).toEqual(envelope.cut);
    checks.systemClipboard = { status: 'EXECUTED', via: `NSPasteboard 读回同一剪切信封；原始载荷 ${artifactRef('nspasteboard.txt')}` };
  } else {
    checks.systemClipboard = { status: 'NOT_RUN', via: 'headless 无系统剪贴板；AC5 系统侧需 FORKWISE_SYSTEM_CLIPBOARD=1 的 headed 项目' };
  }

  // AC2 + AC3：首次粘贴恢复原身份与外线，第二次粘贴生成副本。
  await page.locator('.canvas').press('Meta+v');
  await expect.poll(async () => (await read()).cards.length).toBe(2);
  const restored = await read();
  const back = restored.cards.find(card => card.id === 'a')!;
  expect(back.item.id).toBe(a.item.id);
  expect(back.versionId).not.toBe(a.versionId);
  expect(restored.connectors!.map(line => line.id)).toEqual(['line']);
  expect(restored.connectors![0]!.start).toMatchObject({ kind: 'bound', itemId: a.item.id });
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'consumed', revision: 1 });
  checks.firstMove = { status: 'EXECUTED', via: 'Meta+v 后原 id/item id 恢复、版本更新、外线恢复，服务端 consumed' };

  await page.locator('.canvas').press('Meta+v');
  await expect.poll(async () => (await read()).cards.length).toBe(3);
  const copied = await read();
  const extra = copied.cards.filter(card => card.id !== 'a' && card.id !== 'b');
  expect(extra).toHaveLength(1);
  expect(copied.connectors!.map(line => line.id)).toEqual(['line']);
  const identity = await page.request.get(
    `${workspace.origin}/api/mapping/projects/${projectId}/cards/${extra[0]!.id}/identity`);
  expect(await identity.json()).toMatchObject({ availability: 'available' });
  checks.secondPaste = { status: 'EXECUTED', via: '第二次 Meta+v 生成新身份副本且不复制外线' };

  // AC3 + AC5：撤销首次粘贴回到可首次搬动，撤销剪切回到原件，重做重新消费。
  await travel('撤销');
  await expect.poll(async () => (await read()).cards.length).toBe(2);
  await travel('撤销');
  await expect.poll(async () => (await read()).cards.map(card => card.id)).toEqual(['b']);
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'eligible', revision: 2 });
  await page.locator('.canvas').press('Meta+v');
  await expect.poll(async () => (await read()).cards.length).toBe(2);
  expect((await read()).cards.some(card => card.id === 'a')).toBe(true);
  await travel('撤销');
  await expect.poll(async () => (await read()).cards.map(card => card.id)).toEqual(['b']);
  await travel('撤销');
  await expect.poll(async () => (await read()).cards.map(card => card.id).sort()).toEqual(['a', 'b']);
  expect((await read()).connectors!.map(line => line.id)).toEqual(['line']);
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'cut-undone' });
  checks.undoCut = { status: 'EXECUTED', via: '撤销首次粘贴→eligible 且重试恢复原身份；撤销剪切→原件与外线回来且 cut-undone' };

  // 重做按撤销的逆序回放：先剪切、再首次搬动；资格随对象一起回到 eligible→consumed。
  await travel('重做');
  await expect.poll(async () => (await read()).cards.length).toBe(1);
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'eligible' });
  await travel('重做');
  await expect.poll(async () => (await read()).cards.length).toBe(2);
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'consumed' });
  await travel('撤销');
  await expect.poll(async () => (await read()).cards.length).toBe(1);
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'eligible' });
  await travel('重做');
  await expect.poll(async () => (await read()).cards.length).toBe(2);
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'consumed' });
  checks.redo = { status: 'EXECUTED', via: '重做按逆序恢复剪切(eligible)→首次搬动(consumed)，再撤销/重做仍同步' };

  // 菜单入口的可访问性：首项自动聚焦、Esc 关闭并归还焦点、IME 组合期间的 Esc 不误关。
  const copyTrigger = page.getByRole('button', { name: '复制', exact: true });
  const copyMenu = page.getByRole('menu', { name: '复制操作' });
  await copyTrigger.click();
  await expect(copyMenu).toBeVisible();
  await expect(copyMenu.getByRole('menuitem').first()).toBeFocused();
  // 对照：不带组合状态的合成 Esc 确实能到达处理器并关闭菜单，排除「事件没派发到」的假阳性。
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await expect(copyMenu).toBeHidden();
  await copyTrigger.click();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })));
  await expect(copyMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(copyMenu).toBeHidden();
  await expect(copyTrigger).toBeFocused();
  checks.menuKeyboard = { status: 'EXECUTED', via: '真实键盘 Esc 关闭并归还焦点，菜单首项自动聚焦；合成 Esc 对照确认事件可达处理器' };
  checks.menuImeGuard = { status: 'NOT_RUN', via: '只有合成 KeyboardEvent(isComposing) 的守卫断言；Playwright 只能派发 CDP/DOM 合成事件，真实 OS 输入法组合需系统 IME 参与，headless 与 headed 均无法在自动化内构造，按规格不计 PASS' };

  // AC4：替换剪贴板不复活原件，撤销剪切仍可用。
  await page.getByRole('button', { name: '乙', exact: true }).click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByRole('menuitem', { name: '剪切到剪贴板' }).click();
  await expect.poll(async () => (await read()).cards.some(card => card.id === 'b')).toBe(false);
  await page.getByRole('button', { name: '甲', exact: true }).click();
  await page.locator('.canvas').press('Meta+c');
  await expect.poll(async () => (await read()).cards.some(card => card.id === 'b')).toBe(false);
  // 替换后粘贴必须走普通副本路径，不能把乙的原件复活成新副本。
  await page.locator('.canvas').press('Meta+v');
  await expect.poll(async () => (await read()).cards.some(card => card.id === 'b')).toBe(false);
  await travel('撤销');
  await travel('撤销');
  await expect.poll(async () => (await read()).cards.some(card => card.id === 'b')).toBe(true);
  checks.menu = { status: 'EXECUTED', via: '菜单「剪切到剪贴板」走同一 canvas.cut 命令' };
  checks.replaceClipboard = { status: 'EXECUTED', via: '剪切乙后复制甲并 Meta+v：乙不复活，副本可撤销，源历史撤销仍恢复乙' };

  await workspace.restart();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const reopened = await read();
  expect(reopened.cards.map(card => card.id).sort()).toEqual(['a', 'b']);
  expect((await cutState(envelope.cut.cutId)).body).toMatchObject({ state: 'consumed' });
  checks.reopen = { status: 'EXECUTED', via: 'workspace.restart() + reload 后对象、连线与资格一致' };

  const receipt = { issue: 33, scope: system ? 'system-clipboard' : 'page-clipboard-only',
    run: system ? 'headed' : 'headless', at: new Date().toISOString(),
    ac: {
      AC1: ['clipboardDenied', 'remove'],
      AC2: ['firstMove'],
      AC3: ['firstMove', 'secondPaste', 'undoCut', 'redo'],
      AC4: ['replaceClipboard', 'menu'],
      AC5: ['reopen', 'systemClipboard', 'redo'],
    },
    checks,
    unverified: [
      '写入期间源版本变化的浏览器侧失败时序未单独构造（后端真实 SQLite 的 VERSION_CONFLICT 已覆盖）',
      'OS 层系统剪贴板写入失败未构造：已用 CDP 权限层真实拒绝覆盖浏览器侧 write 失败，NSPasteboard 写入失败需 OS 级故障注入',
      '真实 OS IME 组合输入未构造：自动化只能派发 CDP/DOM 合成事件，守卫证据已与真实键盘证据分开记录',
      '丢 ACK 用 route.fetch + 503 构造（服务端已提交、客户端响应失败）；真实网络分区与进程被杀未构造',
      '40/41 步裁剪由后端真实 SQLite 用例覆盖，浏览器未重复',
      '外端并发修改（AC5）的拒绝路径由独立用例回执承接，见 linkedReceipts.outerChanged',
    ],
    sources: { browserClipboard: artifactRef('browser-clipboard-cut.json') },
    linkedReceipts: { outerChanged: artifactRef('outer-end-changed.json') } };
  writeFileSync(system ? evidence : artifact('headless-paths.json'), JSON.stringify(receipt, null, 2));
  if (system) {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, JSON.stringify(receipt, null, 2));
  }
  writeFileSync(artifact(system ? 'headed-state.json' : 'headless-state.json'), JSON.stringify(reopened, null, 2));
  expect(readFileSync(artifact(system ? 'headed-state.json' : 'headless-state.json'), 'utf8')).toContain('"cards"');
}

test.describe('页面剪贴板剪切状态机', () => {
  test.skip(systemClipboard, 'headed 项目由系统剪贴板用例覆盖完整流程');
  test('菜单与真实键盘剪切、首次搬动、副本、撤销、重开', async ({ page, workspace }) => {
    test.setTimeout(240000);
    await workspace.open(page);
    await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
    await runCutFlow(page, workspace, false);
  });
});

test.describe('AC5 系统剪贴板剪切验收', () => {
  test.skip(!systemClipboard, 'AC5 系统侧验证需真实窗口：FORKWISE_SYSTEM_CLIPBOARD=1 npx playwright test tests/canvas-cut.spec.ts');
  test('真实系统剪贴板剪切、首次搬动、副本、撤销与重开', async ({ page, workspace }) => {
    test.setTimeout(240000);
    await workspace.open(page);
    await runCutFlow(page, workspace, true);
  });
});

test.describe('跨项目剪切包边界', () => {
  test.skip(systemClipboard, '系统剪贴板验收只跑主流程');
  test('异项目剪切包明确拒绝，目标项目不写入', async ({ page, workspace }) => {
    test.setTimeout(180000);
    await workspace.open(page);
    const sourceId = (await workspace.state()).project.id;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: sourceId, type: 'thought.create',
      expected: null, payload: { id: 'moved', title: '待搬动', text: '正文', x: 160, y: 200 } });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: '待搬动', exact: true }).click();
    await page.locator('.canvas').press('Meta+x');
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
    const listProjects = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects`)).json() as Promise<{ id: string }[]>;
    const before = await listProjects();
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect.poll(async () => (await listProjects()).length).toBe(before.length + 1);
    const targetId = (await listProjects()).find(project => !before.some(previous => previous.id === project.id))!.id;
    await expect(page.locator(`[role="tab"][title="${targetId}"]`)).toHaveAttribute('aria-selected', 'true');
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + 420, pane.y + 300);
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await page.locator('.canvas').press('Meta+v');
    await expect(page.getByRole('alert')).toContainText('跨项目剪切尚未支持');
    const target = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}`)).json();
    expect(target.cards).toHaveLength(0);
    expect(target.connectors ?? []).toHaveLength(0);
  });
});

test.describe('外端在剪切后被修改', () => {
  test('首次粘贴前外端被移动时经真实入口拒绝，画布与剪切资格不变', async ({ page, workspace }) => {
    test.setTimeout(180000);
    const checks: Record<string, { status: CheckStatus; via: string }> = {};
    mkdirSync(artifacts, { recursive: true });
    await workspace.open(page);
    const projectId = (await workspace.state()).project.id;
    const execute = (type: string, payload: unknown, expected: unknown = null) =>
      workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
    await execute('thought.create', { id: 'a', title: '甲', text: '甲的正文', x: 120, y: 160 });
    await execute('thought.create', { id: 'b', title: '乙', text: '乙的正文', x: 620, y: 160 });
    const seeded = await workspace.state();
    const a = seeded.cards.find(card => card.id === 'a')!;
    await execute('connector.create', { id: 'line', start: { kind: 'bound', itemId: a.item.id, side: 'right' },
      end: { kind: 'bound', itemId: seeded.cards.find(card => card.id === 'b')!.item.id, side: 'left' }, path: 'straight' });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: '甲', exact: true }).click();
    await page.locator('.canvas').press('Meta+x');
    await expect.poll(async () => (await workspace.state()).cards.map(card => card.id)).toEqual(['b']);
    const envelope = JSON.parse(await page.evaluate(async () => {
      const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
      return item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '';
    }));
    const cutUrl = `${workspace.origin}/api/mapping/projects/${projectId}/cuts/${envelope.cut.cutId}`;
    // 外端在剪切之后被移动：首次粘贴必须经真实 UI 拒绝，而不是按当前几何静默恢复连线。
    const moved = (await workspace.state()).cards.find(card => card.id === 'b')!;
    await execute('card.edit', { id: 'b', text: '乙的新正文，长度明显增加以触发增高', x: 640, y: 480 },
      { body: moved.body.versionId, pose: moved.item.versionId });
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await page.locator('.canvas').press('Meta+v');
    await expect(page.getByRole('alert')).toContainText('剪切后外部连线端点已变化');
    const after = await workspace.state();
    expect(after.cards.map(card => card.id)).toEqual(['b']);
    expect(after.connectors ?? []).toEqual([]);
    expect(await (await page.request.get(cutUrl)).json()).toMatchObject({ state: 'eligible', revision: 0 });
    checks.outerChanged = { status: 'EXECUTED', via: '真实 UI：Meta+x → card.edit 移动外端 → Meta+v 被 CUT_OUTER_CHANGED 拒绝；alert 文案、画布对象/连线、cut 资格均核验' };

    // AC5：服务重开后拒绝结论与在途资格仍成立，不因重启倒灌成可粘贴。
    await workspace.restart();
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const reopened = await workspace.state();
    expect(reopened.cards.map(card => card.id)).toEqual(['b']);
    expect(reopened.connectors ?? []).toEqual([]);
    expect(await (await page.request.get(cutUrl)).json()).toMatchObject({ state: 'eligible', revision: 0 });
    checks.outerChangedReopen = { status: 'EXECUTED', via: 'workspace.restart() + reload 后对象、连线与 eligible/revision 0 一致，拒绝结论跨重启保持' };

    // 每阶段一份汇总：该场景独立成回执，ac 只登记本用例真正执行的检查，不并入主流程 checks。
    const receipt = { issue: 33, scope: systemClipboard ? 'system-clipboard' : 'page-clipboard-only',
      run: systemClipboard ? 'headed' : 'headless', at: new Date().toISOString(),
      ac: { AC2: ['outerChanged'], AC5: ['outerChanged', 'outerChangedReopen'] },
      checks,
      unverified: ['外端为组合/分区时的真实 UI 拒绝路径未单独构造（后端真实 SQLite 已覆盖）',
        'OS 层系统剪贴板写入失败与真实 OS IME 组合输入未构造，见主回执 unverified'],
      sources: { cutId: envelope.cut.cutId } };
    writeFileSync(artifact('outer-end-changed.json'), JSON.stringify(receipt, null, 2));
    expect(readFileSync(artifact('outer-end-changed.json'), 'utf8')).toContain('"outerChangedReopen"');
  });
});

test.describe('剪切 ACK 丢失后的 journal 重放', () => {
  test.skip(systemClipboard, '系统剪贴板验收只跑主流程');
  test('丢 ACK 后重开按原请求重放剪切，不重复删除也不降级剪贴板', async ({ page, workspace }) => {
    test.setTimeout(180000);
    await workspace.open(page);
    await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
    const projectId = (await workspace.state()).project.id;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create',
      expected: null, payload: { id: 'replay', title: '待重放', text: '正文', x: 160, y: 200 } });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    let dropped = true;
    await page.route('**/api/mapping/execute', async route => {
      if (dropped && route.request().postDataJSON().type === 'canvas.cut') {
        // 请求真正到达服务端并提交，再把响应换成失败：构造「服务端已执行、客户端丢 ACK」。
        await route.fetch();
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'ACK lost' }) });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '待重放', exact: true }).click();
    await page.locator('.canvas').press('Meta+x');
    await expect(page.getByRole('alert')).toBeVisible();
    // 服务端已提交：原件已移除、剪切记录已建立；客户端因丢 ACK 保留原 commandId 的 journal。
    await expect.poll(async () => (await workspace.state()).cards.map(card => card.id)).toEqual([]);
    const raw = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
      return item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '';
    });
    const envelope = JSON.parse(raw);
    expect(envelope.cut).toMatchObject({ sourceProjectId: projectId });
    expect(await page.evaluate(() => localStorage.getItem('forkwise.cut-pending.v1'))).toContain(envelope.cut.cutId);
    dropped = false;
    await page.unroute('**/api/mapping/execute');
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    // 重放同一 commandId：后端 receipt 幂等，不重复删除、不重复推进资格、不重复写历史。
    await expect.poll(async () => (await workspace.state()).cards.map(card => card.id)).toEqual([]);
    const cut = await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/cuts/${envelope.cut.cutId}`);
    expect(await cut.json()).toMatchObject({ state: 'eligible', revision: 0 });
    const history = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
    expect(history.undo.filter((action: { label: string }) => action.label === 'canvas.cut')).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.getItem('forkwise.cut-pending.v1'))).toBeNull();
  });
});
