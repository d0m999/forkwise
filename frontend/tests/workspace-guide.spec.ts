import { expect, place, test } from './writing-board-fixture';
import type { Page } from '@playwright/test';

async function openReplay(page: Page) {
  const navigation = page.getByRole('button', { name: '项目导航', exact: true });
  if (await navigation.getAttribute('aria-expanded') !== 'true') await navigation.click();
  await page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '画布引导', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('项目内引导只从导航打开，键盘跳过后可立即在画布创建卡片', async ({ page, workspace }) => {
  const revision = (await workspace.state()).project.revision;
  const invitation = page.getByRole('region', { name: '画布引导' });
  const navigation = page.getByRole('button', { name: '项目导航', exact: true });
  await expect(invitation).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 440 });
  await navigation.press('Enter');
  await expect(invitation).toHaveCount(0);
  const replay = page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true });
  await replay.press('Enter');
  const dialog = page.getByRole('dialog', { name: '画布引导', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '跳过引导', exact: true }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(replay).toBeFocused();
  await navigation.press('Enter');
  await page.setViewportSize({ width: 1360, height: 900 });
  expect((await workspace.state()).project.revision).toBe(revision);
  await place(page, '跳过后直接记录');
  expect((await workspace.state()).cards[0]?.title).toBe('跳过后直接记录');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(invitation).toHaveCount(0);
});

test('偏好读取及保存失败可重试，首次项目加载失败后也可继续研究', async ({ page, workspace }) => {
  const failed = new Set<string>();
  await page.route('**/api/mapping/projects', route => route.fulfill({ status: 503, json: { message: '项目暂时无法打开' } }), { times: 1 });
  await page.route('**/api/workspace/guide', route => {
    const request = route.request();
    const action = request.method() === 'GET' ? 'read' : request.postDataJSON().preference as string;
    if (failed.has(action)) return route.continue();
    failed.add(action);
    return route.fulfill({ status: 503, json: { message: '偏好服务暂时不可用' } });
  });
  await page.reload();
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toBeVisible();
  await place(page, '偏好服务暂时异常时记录', 390, 210);
  await expect(page.getByRole('button', { name: '偏好服务暂时异常时记录', exact: true })).toBeVisible();
  const failedRead = await openReplay(page);
  await expect(failedRead.getByRole('alert')).toHaveText('暂时无法读取引导偏好。');
  await failedRead.getByRole('button', { name: '重试读取' }).click();
  await expect(failedRead.getByRole('alert')).toHaveCount(0);
  await failedRead.getByRole('button', { name: '跳过引导' }).click();
  await expect(failedRead.getByRole('alert')).toHaveText('暂时无法保存跳过偏好。');
  await failedRead.getByRole('button', { name: '重试跳过' }).click();
  await expect(failedRead).toHaveCount(0);
  const dialog = await openReplay(page);
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: '完成引导' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('暂时无法保存完成偏好。');
  await dialog.getByRole('button', { name: '重试完成' }).click();
  await expect(dialog).toHaveCount(0);
  const preference = await page.request.get(`${workspace.origin}/api/workspace/guide`);
  expect(await preference.json()).toEqual({ preference: 'completed' });
});

test('偏好晚到时不渲染会消失的跳过按钮，引导打开时失焦也不触发研究撤销', async ({ page, workspace }) => {
  await place(page, '仍在原项目', 390, 210);
  const before = await workspace.state();
  const endpoint = `${workspace.origin}/api/workspace/guide`;
  const saved = await page.request.put(endpoint, { headers: { Origin: workspace.origin }, data: { preference: 'completed' } });
  expect(saved.status()).toBe(204);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(endpoint, async route => { await pending; await route.continue(); }, { times: 1 });
  const read = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'GET');
  const dialog = page.getByRole('dialog', { name: '画布引导', exact: true });
  try {
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await openReplay(page);
    await expect(dialog.getByRole('button', { name: '跳过引导' })).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '下一步' })).toBeFocused();
  } finally {
    release();
  }
  expect(await (await read).json()).toEqual({ preference: 'completed' });
  await expect(dialog.getByRole('button', { name: '下一步' })).toBeFocused();
  const writes: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/mapping/execute')) writes.push(request.postDataJSON());
  });
  await dialog.getByRole('button', { name: '下一步' }).evaluate(button => (button as HTMLButtonElement).blur());
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await workspace.state()).toEqual(before);
  expect(writes).toEqual([]);
});

test('引导的真实步骤可只用键盘浏览，重看带回原项目、选区、焦点和写字板', async ({ page, workspace }) => {
  await place(page, '保持原卡片', 360, 210);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  const selected = page.locator('.react-flow__node.selected');
  const project = page.getByRole('tab', { selected: true });
  await expect(board).toContainText('保持原卡片');
  await expect(page.getByRole('region', { name: '画布引导' })).toHaveCount(0);
  const state = await workspace.state();
  const projectId = state.project.id;
  const history = async () => {
    const response = await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`);
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const before = await history();
  expect(before.undo.length).toBeGreaterThan(0);
  const writes: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/mapping/execute')) writes.push(request.postDataJSON());
  });
  await expect(selected).toHaveAttribute('data-id', state.cards[0]!.item.id);
  await expect(project).toHaveAttribute('title', projectId);
  for (const name of ['新建研究', '卡片', '分区']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();

  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  const replay = page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true });
  await editor.focus();
  await replay.click();
  const dialog = page.getByRole('dialog', { name: '画布引导', exact: true });
  const close = dialog.getByRole('button', { name: '关闭引导' });
  const next = dialog.getByRole('button', { name: '下一步' });
  await expect(close).toBeFocused();
  await expect(dialog).toContainText(/顶栏点击新建研究.*底部选卡片/);
  await page.keyboard.press('Shift+Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '跳过引导', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toContainText('在底部选分区，在画布上拖出一个框');
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '上一步' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: '新建研究与卡片' })).toBeVisible();
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(dialog).toContainText(/附着到卡片.*目标卡片.*解除附着/);
  for (const key of ['Control+z', 'Meta+Shift+z', 'Backspace', 'Delete', 'Control+g', 'Control+d']) {
    await page.keyboard.press(key);
  }
  await dialog.getByRole('button', { name: '完成引导' }).evaluate(button => {
    const text = new DataTransfer();
    text.setData('text/plain', '此剪贴板事件仅供引导测试');
    button.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: text }));
  });
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(board).toContainText('保持原卡片');
  await expect(selected).toHaveAttribute('data-id', state.cards[0]!.item.id);
  await expect(project).toHaveAttribute('title', projectId);
  await expect(page.getByRole('region', { name: '画布引导' })).toHaveCount(0);
  await replay.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: '新建研究与卡片' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(replay).toBeFocused();
  expect(writes).toEqual([]);
  expect(await workspace.state()).toEqual(state);
  expect(await history()).toEqual(before);
});

test('批注等待附着时 Esc 只关引导，回到画布后原 Escape 仍可用', async ({ page, workspace }) => {
  await place(page, '批注目标', 310, 200);
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: { x: 650, y: 220 } });
  const text = page.getByRole('textbox', { name: '独立文字', exact: true });
  await text.pressSequentially('独立批注');
  await text.press('Escape');
  const attach = page.getByRole('button', { name: '附着到卡片', exact: true });
  await attach.click();
  const targetPrompt = page.getByText('点击要附着的卡片', { exact: true });
  await expect(targetPrompt).toBeVisible();
  const before = await workspace.state();
  const dialog = await openReplay(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(targetPrompt).toBeVisible();
  await expect(attach).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(targetPrompt).toHaveCount(0);
  await attach.click();
  await page.getByRole('button', { name: '批注目标', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).attachments?.[0]?.target?.itemId).toBe(before.cards[0]!.item.id);
  await page.locator('.canvas-text-content').click();
  await page.getByRole('button', { name: '解除附着', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).attachments ?? []).toEqual([]);
});

test('查看引导不会结束正在输入的卡片标题', async ({ page, workspace }) => {
  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  await page.getByRole('button', { name: '卡片', exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: { x: 440, y: 180 } });
  const title = page.getByRole('textbox', { name: '卡片标题', exact: true });
  await expect(title).toBeFocused();
  const before = await workspace.state();
  await title.fill('稍后明确保存');
  const open = page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true });
  await expect(open).toBeDisabled();
  await open.click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(title).toBeFocused();
  await expect(title).toHaveValue('稍后明确保存');
  expect(await workspace.state()).toEqual(before);
  await title.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards[0]?.title).toBe('稍后明确保存');
});

test('在引导里松开空格后，下一次空白拖拽不会继续平移画布', async ({ page, workspace }) => {
  const before = await workspace.state();
  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  const replay = page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true });
  const transform = () => page.locator('.react-flow__viewport').getAttribute('style');
  const dragEmpty = async () => {
    await page.mouse.move(700, 340);
    await page.mouse.down();
    await page.mouse.move(750, 380, { steps: 5 });
    await page.mouse.up();
  };
  await page.getByRole('main').focus();
  const initial = await transform();
  await page.keyboard.down('Space');
  await dragEmpty();
  await expect.poll(transform).not.toBe(initial);
  await replay.click();
  const dialog = page.getByRole('dialog', { name: '画布引导', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    document.addEventListener('keyup', event => {
      if (event.code === 'Space') document.documentElement.dataset.guideSpaceReleased = 'true';
    }, { once: true });
  });
  await page.keyboard.up('Space');
  await expect(page.locator('html')).toHaveAttribute('data-guide-space-released', 'true', { timeout: 3000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const panned = await transform();
  await dragEmpty();
  expect(await transform()).toBe(panned);
  expect(await workspace.state()).toEqual(before);
});

test('分区键盘伸缩预览期间暂缓打开引导，预览仍可明确保存', async ({ page, workspace }) => {
  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  await page.getByRole('button', { name: '分区', exact: true }).click();
  await page.mouse.move(580, 240);
  await page.mouse.down();
  await page.mouse.move(910, 520, { steps: 7 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
  const before = await workspace.state();
  const resize = page.getByRole('button', { name: '调整分区范围：右边缘', exact: true });
  await resize.press('ArrowRight');
  const preview = page.locator('.frame-resize-overlay');
  const width = before.frames![0]!.pose.width + 10;
  await expect(preview).toHaveCSS('width', `${width}px`);
  const open = page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true });
  await expect(open).toBeDisabled({ timeout: 3000 });
  await open.click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(resize).toBeFocused();
  await expect(preview).toHaveCSS('width', `${width}px`);
  expect(await workspace.state()).toEqual(before);
  await resize.press('Enter');
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose.width).toBe(width);
  await expect(open).toBeEnabled();
});

test('清空独立文字后查看引导，不提交删除或消耗研究撤销', async ({ page, workspace }) => {
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: { x: 640, y: 220 } });
  const editor = page.getByRole('textbox', { name: '独立文字', exact: true });
  await editor.fill('原有批注');
  await editor.press('Escape');
  await expect(page.locator('.canvas-text-content')).toHaveText('原有批注');
  const before = await workspace.state();
  const history = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${before.project.id}/history`)).json();
  const beforeHistory = await history();
  const writes: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/mapping/execute')) writes.push(request.postDataJSON());
  });
  await page.locator('.canvas-text-content').dblclick();
  await editor.fill(' ');
  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  await expect(editor).toBeFocused();
  const replay = page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true });
  await expect(replay).toBeDisabled({ timeout: 3000 });
  await replay.click({ force: true });
  await expect(editor).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await workspace.state()).toEqual(before);
  expect(await history()).toEqual(beforeHistory);
  await editor.press('Escape');
  await expect.poll(async () => (await workspace.state()).texts).toEqual([]);
  await expect(replay).toBeEnabled();
});

for (const preference of ['跳过引导', '完成引导']) {
  test(`${preference}在工作台重开和全新浏览器上下文中保留，并可从第一步重看`, async ({ browser, workspace }) => {
    const launch = () => browser.newContext({ viewport: { width: 320, height: 440 } });
    const savePreference = (page: Page) => page.waitForResponse(response => response.url().endsWith('/api/workspace/guide') && response.request().method() === 'PUT');
    const initial = await workspace.state();
    const first = await launch();
    try {
      const page = await first.newPage();
      await workspace.open(page);
      const invitation = page.getByRole('region', { name: '画布引导' });
      await expect(invitation).toHaveCount(0);
      const dialog = await openReplay(page);
      const saved = savePreference(page);
      if (preference === '跳过引导') await dialog.getByRole('button', { name: '跳过引导' }).press('Enter');
      else {
        await dialog.getByRole('button', { name: '下一步' }).click();
        await dialog.getByRole('button', { name: '下一步' }).click();
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(12);
        expect(box.x + box.width).toBeLessThanOrEqual(308);
        expect(box.y).toBeGreaterThanOrEqual(12);
        expect(box.y + box.height).toBeLessThanOrEqual(428);
        await expect(dialog.getByRole('button', { name: '完成引导' })).toBeInViewport();
        await dialog.getByRole('button', { name: '完成引导' }).click();
      }
      await expect(dialog).toHaveCount(0);
      expect((await saved).status()).toBe(204);
    } finally {
      await first.close();
    }
    await workspace.restart();
    const reopened = await launch();
    try {
      const page = await reopened.newPage();
      const read = page.waitForResponse(response => response.url().endsWith('/api/workspace/guide') && response.request().method() === 'GET');
      await workspace.open(page);
      expect(await (await read).json()).toEqual({ preference: preference === '跳过引导' ? 'skipped' : 'completed' });
      const invitation = page.getByRole('region', { name: '画布引导' });
      await expect(invitation).toHaveCount(0);
      const dialog = await openReplay(page);
      await expect(dialog.getByRole('heading', { name: '新建研究与卡片' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('status')).toHaveText('已保存到本机');
      await expect(invitation).toHaveCount(0);
      expect(await workspace.state(page)).toEqual(initial);
    } finally {
      await reopened.close();
    }
  });
}

test('撤权时关闭引导并把焦点还给项目导航', async ({ page, workspace }) => {
  const dialog = await openReplay(page);
  await expect(dialog.getByRole('button', { name: '关闭引导' })).toBeFocused();
  workspace.revoke();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '项目导航', exact: true })).toBeFocused();
  await expect(page.getByText('授权已失效，请从本机启动入口重新打开；未确认草稿已保留')).toBeVisible();
});
