import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, place, test } from './writing-board-fixture';
import type { ProjectState } from '../src/api';

test.use({ verificationTransport: true });

function moreTrigger(page: Page) {
  return page.getByRole('toolbar', { name: '卡片操作', exact: true }).getByRole('button', { name: '更多', exact: true });
}

function verificationEntry(page: Page) {
  return page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '公开查证', exact: true });
}

async function openVerification(page: Page) {
  await moreTrigger(page).click();
  await verificationEntry(page).click();
}

test('从卡片公开查证，审阅并下载原文，明确添加后可撤销、重做、重开和隔离复制', async ({ page, workspace }, info) => {
  await place(page, '查证这个数字');
  const before = await workspace.state();
  const trigger = moreTrigger(page);
  await page.setViewportSize({ width: 360, height: 720 });
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await trigger.click();
  await expect(verificationEntry(page)).toBeInViewport({ ratio: 1 });
  await verificationEntry(page).click();
  const dialog = page.getByRole('dialog', { name: '公开查证', exact: true });
  const cik = dialog.getByLabel('公司 CIK');
  await expect(dialog.getByText('当前卡片', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/使用本机测试夹具/)).toBeVisible();
  await expect(cik).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('分类体系（taxonomy）')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '更多', exact: true })
    .getByRole('button', { name: '关闭卡片菜单' })).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  await expect(verificationEntry(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cik).toBeFocused();
  await cik.dispatchEvent('compositionstart');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await cik.dispatchEvent('compositionend');

  await expect(dialog).toBeInViewport({ ratio: 1 });
  const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: info.outputPath('verification-form-narrow.png') });
  await page.setViewportSize({ width: 1360, height: 900 });
  await cik.fill('1234');
  await dialog.getByLabel('分类体系（taxonomy）').fill('us-gaap');
  await dialog.getByLabel('指标标签（tag）').fill('Assets');
  await dialog.getByLabel('单位', { exact: true }).fill('USD');
  await dialog.getByLabel('业务期间末日或时点').fill('2024-12-31');
  await dialog.getByLabel('已知截止日（含当天）').fill('2025-03-20');
  await dialog.getByRole('button', { name: '开始查证' }).click();
  await expect(dialog.getByRole('status')).toHaveText('模拟查证 部分完成');
  await expect(dialog.getByText('同期间披露存在冲突')).toBeVisible();
  await expect(dialog.getByText('9007199254740994.00 USD', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/未调用模型/)).toBeVisible();
  expect(await workspace.state()).toEqual(before);
  await page.screenshot({ path: info.outputPath('verification-review.png') });
  const raw = await readFile(new URL('../../backend/tests/fixtures/verification-companyfacts.json', import.meta.url));
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '下载查证原文' }).click();
  expect(await readFile((await (await download).path())!)).toEqual(raw);
  const adding = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
    response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'organize.add');
  await dialog.getByRole('button', { name: '添加为新卡' }).click();
  const receipt = await (await adding).json();
  expect(receipt.revision).toBe(before.project.revision + 1);
  const changePage = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${before.project.id}/changes?after=${before.project.revision}&limit=1`)).json();
  expect(changePage.changes).toMatchObject([{ revision: receipt.revision, after: { verificationOrigin: { hash: expect.any(String) } } }]);
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '添加为新卡' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭 公开查证' }).click();
  const saved = await workspace.state();
  const candidate = saved.cards[1]!;
  expect(saved.cards[0]).toEqual(before.cards[0]);
  expect(saved.connectors).toEqual(before.connectors);
  expect(candidate.verificationOrigin).toMatchObject({ fixture: true, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(candidate.aiOrigin).toBeUndefined();
  await expect(page.locator(`.react-flow__node[data-id="${candidate.item.id}"]`)).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[1]?.verificationOrigin).toEqual(candidate.verificationOrigin);
  await page.goto('about:blank');
  await workspace.restart();
  await workspace.open(page);
  const resultCard = page.getByRole('button', { name: 'SEC 披露 · Assets', exact: true });
  await expect(resultCard).toBeVisible();
  await expect(page.getByRole('button', { name: '模拟查证 · 下载夹具原文', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '项目导航' }).click();
  await page.getByRole('button', { name: '公开查证记录', exact: true }).click();
  const recorded = page.getByRole('dialog', { name: '公开查证记录', exact: true });
  await expect(recorded.getByRole('status')).toHaveText(/模拟查证.*已添加为新卡/);
  await expect(recorded.getByRole('option', { selected: true })).toHaveText(/模拟查证.*查证这个数字/);
  await recorded.getByRole('button', { name: '关闭 公开查证' }).click();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await resultCard.click();
  await page.keyboard.press('ControlOrMeta+c');
  const readClipboard = () => page.evaluate(async () => {
    try {
      const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
      return item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '';
    } catch (error) {
      // The async copy can replace the clipboard between read() and getType().
      if (error instanceof DOMException && error.name === 'InvalidStateError' &&
          error.message.includes('Clipboard data has changed')) return '';
      throw error;
    }
  });
  let clipboard = '';
  await expect.poll(async () => {
    const snapshot = await readClipboard();
    if (!snapshot.includes(candidate.item.id)) return '';
    clipboard = snapshot;
    return snapshot;
  }).toContain(candidate.title);
  expect(clipboard).not.toContain('verificationOrigin');
  expect(clipboard).not.toContain(candidate.verificationOrigin!.assetId);
  const frozenCard = (await workspace.state()).cards.find(card => card.id === candidate.id)!;
  expect(clipboard).toContain(frozenCard.body.versionId);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: saved.project.id,
    type: 'thought.title', expected: (await workspace.state()).cards.find(card => card.id === candidate.id)!.versionId,
    payload: { id: candidate.id, title: '后来更新的标题' } });
  await expect(page.getByRole('button', { name: '后来更新的标题', exact: true })).toBeVisible();
  await page.locator('.canvas').press('ControlOrMeta+v');
  await expect.poll(async () => (await workspace.state()).cards.find(card => card.title === candidate.title)?.verificationOrigin)
    .toEqual(candidate.verificationOrigin);
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => {
    const target = new URL(page.url()).searchParams.get('project');
    return !!target && target !== saved.project.id;
  }).toBe(true);
  const targetId = new URL(page.url()).searchParams.get('project')!;
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await page.locator('.canvas').press('ControlOrMeta+v');
  const target = async (): Promise<ProjectState> => (await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}`)).json();
  await expect.poll(async () => (await target()).cards.length).toBe(1);
  expect((await target()).cards[0]).toMatchObject({ title: candidate.title });
  expect((await target()).cards[0]?.verificationOrigin).toBeUndefined();
  await expect(page.getByRole('button', { name: '模拟查证 · 下载夹具原文', exact: true })).toHaveCount(0);
  expect((await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}/assets/${candidate.verificationOrigin!.assetId}/content`)).status()).toBe(404);
});

test.describe('最新来源访问失败', () => {
  test.use({ verificationTransport: 'denied-retry' });
  test('重试失败后主区标注旧结果，并明确采用第几次', async ({ page, workspace }) => {
    await place(page, '区分旧结果');
    await openVerification(page);
    const dialog = page.getByRole('dialog', { name: '公开查证', exact: true });
    await dialog.getByLabel('公司 CIK').fill('1234');
    await dialog.getByLabel('分类体系（taxonomy）').fill('us-gaap');
    await dialog.getByLabel('指标标签（tag）').fill('Assets');
    await dialog.getByLabel('单位', { exact: true }).fill('USD');
    await dialog.getByLabel('业务期间末日或时点').fill('2024-12-31');
    await dialog.getByLabel('已知截止日（含当天）').fill('2025-03-20');
    await dialog.getByRole('button', { name: '开始查证' }).click();
    await expect(dialog.getByText('同期间披露存在冲突')).toBeVisible();
    await dialog.getByRole('button', { name: '重试查证' }).click();
    await expect(dialog.getByText(/第 2 次查证访问失败.*403/)).toBeVisible();
    await expect(dialog.getByText(/模拟查证 部分完成/)).toBeVisible();
    await expect(dialog.getByText('下方显示第 1 次的结果。')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '添加为新卡' })).toHaveCount(0);
    expect((await workspace.state()).cards).toHaveLength(1);
    await dialog.getByRole('button', { name: '添加第 1 次结果' }).click();
    await expect(dialog.getByText(/已添加为新卡/)).toBeVisible();
  });
});

test('单一匹配可以审阅并安全退出，项目保留模拟查证记录', async ({ page, workspace }, info) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await place(page, '供应链观察', 460, 140);
  const initial = await workspace.state();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: initial.project.id,
    type: 'connector.create', expected: null, payload: { id: 'verification-review-connector',
      start: { kind: 'bound', itemId: initial.cards[0]!.item.id, side: 'left' },
      end: { kind: 'free', point: { x: 150, y: 300 } } } });
  await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
  const before = await workspace.state();
  await openVerification(page);
  const dialog = page.getByRole('dialog', { name: '公开查证', exact: true });
  const fields = [
    ['公司 CIK', '1234'], ['分类体系（taxonomy）', 'us-gaap'], ['指标标签（tag）', 'Assets'],
    ['单位', 'USD'], ['业务期间末日或时点', '2024-12-31'], ['已知截止日（含当天）', '2025-02-10'],
  ];
  await expect(dialog.getByRole('button', { name: '开始查证' })).toBeDisabled();
  for (const [label, value] of fields) await dialog.getByLabel(label!, { exact: true }).fill(value!);
  await page.screenshot({ path: info.outputPath('verification-input-760.png') });
  const submitted = page.waitForResponse(response => response.url().endsWith('/organize/tasks') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '开始查证' }).click();
  const response = await submitted;
  expect(response.request().postDataJSON()).toMatchObject({ includeTitle: false, blockIds: [],
    verification: { cik: '0000001234', taxonomy: 'us-gaap', tag: 'Assets', unit: 'USD',
      periodStart: null, periodEnd: '2024-12-31', knownByDate: '2025-02-10' } });
  expect((await response.json()).verificationFixture).toBe(true);
  await expect(dialog.getByRole('status')).toHaveText('模拟查证 可以审阅');
  await expect(dialog.getByText('找到符合已确认范围的披露')).toBeVisible();
  await expect(dialog.getByText('9007199254740993 USD', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/测试夹具，模拟 SEC EDGAR/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('verification-review-760.png') });
  expect(await workspace.state()).toEqual(before);
  await dialog.getByRole('button', { name: '关闭 公开查证' }).click();
  expect(await workspace.state()).toEqual(before);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-board-full', 'true');
  await page.getByRole('button', { name: '项目导航' }).click();
  await page.getByRole('button', { name: '公开查证记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '公开查证记录', exact: true });
  await expect(history.getByRole('option', { selected: true })).toHaveText(/模拟查证.*供应链观察/);
  await history.getByRole('button', { name: '添加为新卡' }).click();
  await expect(history.getByRole('status')).toContainText('已添加为新卡');
  await history.getByRole('button', { name: '关闭 公开查证' }).click();
  await expect(page.getByRole('complementary', { name: '写字板' })).toHaveCount(0);
  const { cards, connectors } = await workspace.state();
  expect(cards[0]).toEqual(before.cards[0]);
  expect(connectors).toEqual(before.connectors);
  expect(cards[1]!.verificationOrigin).toMatchObject({ fixture: true });
  await expect(page.locator(`.react-flow__node[data-id="${cards[1]!.item.id}"]`)).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '模拟查证 · 下载夹具原文' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('verification-candidate-760.png') });
  console.log('issue63-verification', JSON.stringify({ fixture: 'verification-companyfacts.json',
    width: 760, height: 900, input: response.request().postDataJSON().verification, state: 'matched' }));
});

test('普通卡的更多菜单仅在单选时提供公开查证', async ({ page, workspace }) => {
  await place(page, '查证入口甲', 90, 160);
  await place(page, '查证入口乙', 530, 280);
  const a = page.getByRole('button', { name: '查证入口甲', exact: true });
  await moreTrigger(page).click();
  await expect(verificationEntry(page)).toBeVisible();
  await a.click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(moreTrigger(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '公开查证', exact: true })).toHaveCount(0);
  await a.click();
  await moreTrigger(page).click();
  await expect(verificationEntry(page)).toBeVisible();
  expect((await workspace.state()).cards).toHaveLength(2);
});

test.describe('查证重试的资料缺口', () => {
  test.use({ verificationTransport: 'gaps-on-retry' });
  test('保留旧候选时显示最近缺口，新结果成功后仍可从项目记录查看同一缺口', async ({ page, workspace }) => {
    await place(page, '查看历次查证');
    await openVerification(page);
    const dialog = page.getByRole('dialog', { name: '公开查证', exact: true });
    await expect(dialog.getByText(/使用本机测试夹具/)).toBeVisible();
    await dialog.getByLabel('公司 CIK').fill('1234');
    await dialog.getByLabel('分类体系（taxonomy）').fill('us-gaap');
    await dialog.getByLabel('指标标签（tag）').fill('Assets');
    await dialog.getByLabel('单位', { exact: true }).fill('USD');
    await dialog.getByLabel('业务期间末日或时点').fill('2024-12-31');
    await dialog.getByLabel('已知截止日（含当天）').fill('2025-03-20');

    const gap = '没有查到符合业务期间和已知截止日的披露。';
    await dialog.getByRole('button', { name: '开始查证' }).click();
    await expect(dialog.getByText('同期间披露存在冲突')).toBeVisible();
    await dialog.getByRole('button', { name: '重试查证' }).click();
    await expect(dialog.getByText('第 2 次查证未得到可添加的结果。')).toBeVisible();
    await expect(dialog.getByRole('region', { name: '第 2 次查证资料缺口', exact: true })).toContainText(gap);
    await expect(dialog.getByRole('button', { name: '添加第 1 次结果' })).toBeEnabled();

    await dialog.getByRole('button', { name: '重试查证' }).click();
    await expect(dialog.getByText('模拟查证 可以审阅', { exact: true })).toBeVisible();
    await expect(dialog.getByText('找到符合已确认范围的披露')).toBeVisible();
    await dialog.getByRole('button', { name: '关闭 公开查证' }).click();
    await page.getByRole('button', { name: '项目导航' }).click();
    await page.getByRole('button', { name: '公开查证记录', exact: true }).click();
    const history = page.getByRole('dialog', { name: '公开查证记录', exact: true });
    await expect(history.getByText('找到符合已确认范围的披露')).toBeVisible();
    await expect(history.getByText(gap, { exact: true })).not.toBeVisible();
    await history.getByText('原卡版本和查证尝试', { exact: true }).click();
    const second = history.getByRole('listitem').filter({ hasText: /^第 2 次 ·/ });
    await second.getByText('查看这次结果', { exact: true }).click();
    await expect(second.getByRole('region', { name: '资料缺口', exact: true })).toContainText(gap);
    expect((await workspace.state()).cards).toHaveLength(1);
  });
});
