import { test, expect, place } from './writing-board-fixture';

test('从顶栏创建、改名和切换研究，项目导航和搜索跟随活动项目', async ({ page, workspace }) => {
  const selected = page.getByRole('tab', { selected: true });
  const firstId = await selected.getAttribute('title');
  const rename = page.getByRole('button', { name: '重命名当前项目', exact: true });
  const name = page.getByRole('textbox', { name: '项目名称', exact: true });
  const saveName = page.getByRole('button', { name: '保存名称', exact: true });

  await rename.click();
  await name.fill('芯片供给研究');
  await saveName.click();
  await expect(selected).toHaveText(/芯片供给研究/);
  await place(page, '设备产能与资本开支', 400, 245);
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect(selected).toHaveText(/未命名研究/);
  await rename.click();
  await name.fill('消费需求研究');
  await saveName.click();
  await expect(selected).toHaveText(/消费需求研究/);
  await place(page, '细分市场跟踪', 400, 245);
  const secondId = await selected.getAttribute('title');
  expect(secondId).not.toBe(firstId);
  for (const [id, title] of [[firstId, '设备产能与资本开支'], [secondId, '细分市场跟踪']]) {
    const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + id);
    expect(response.ok()).toBe(true);
    expect((await response.json()).cards.map((card: { title: string }) => card.title)).toEqual([title]);
  }

  const toggle = page.getByRole('button', { name: '项目导航', exact: true });
  const navigation = page.locator('.project-nav');
  const firstCard = page.getByRole('button', { name: '设备产能与资本开支', exact: true });
  const secondCard = page.getByRole('button', { name: '细分市场跟踪', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await navigation.getByRole('button', { name: /芯片供给研究/ }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(selected).toHaveAttribute('title', firstId);
  await expect(firstCard).toBeVisible();
  await expect(secondCard).toHaveCount(0);

  await toggle.click();
  await navigation.getByRole('button', { name: '固定', exact: true }).click();
  await page.getByRole('tab', { name: /消费需求研究/ }).click();
  await expect(selected).toHaveAttribute('title', secondId);
  await expect(page.getByRole('main')).toHaveAccessibleName('消费需求研究画布');
  await expect(navigation.getByRole('button', { name: /消费需求研究/ })).toHaveAttribute('aria-current', 'true');
  await expect(navigation.getByRole('button', { name: 'AI 整理记录', exact: true })).toBeInViewport();
  await expect(secondCard).toBeVisible();
  await expect(firstCard).toHaveCount(0);

  await page.getByRole('button', { name: '搜索当前项目卡片', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '搜索当前项目卡片' })).toBeVisible();
  await page.keyboard.press('Escape');
  await navigation.getByRole('button', { name: '取消固定', exact: true }).click();
  await toggle.click();
  await expect(navigation).toHaveCount(0);
});

test('760px 下长名称保持完整可访问文本，溢出页签和项目操作可达', async ({ page, workspace }) => {
  const longNames = Array.from({ length: 30 }, (_, index) =>
    '数据中心服务器投资周期与算力需求研究观察记录第' + String(index + 1).padStart(2, '0') + '期');
  for (const name of longNames) {
    await workspace.execute(page, {
      commandId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      type: 'project.create', expected: null, payload: { name },
    });
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.reload();
  const tabs = page.getByRole('tablist', { name: '研究项目' });
  await expect(tabs.getByRole('tab')).toHaveCount(longNames.length + 1);
  const selected = tabs.getByRole('tab', { selected: true });
  const last = tabs.getByRole('tab').last();
  const tabText = await last.textContent();
  const fullName = longNames.find(name => tabText?.includes(name))!;
  expect(fullName).toBeTruthy();
  await selected.focus();
  await page.keyboard.press('End');
  await expect(last).toBeFocused({ timeout: 2000 });
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(last).toHaveAccessibleName(fullName);
  expect(await last.evaluate(tab => getComputedStyle(tab).outlineStyle)).toBe('solid');
  expect(await last.evaluate(tab => {
    const name = tab.querySelector<HTMLElement>('.project-name')!;
    return name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis';
  })).toBe(true);
  const initialName = await selected.getAttribute('title');
  const create = page.getByRole('button', { name: '新建研究', exact: true });
  const toggle = page.getByRole('button', { name: '项目导航', exact: true });
  await page.keyboard.press('Shift+Tab');
  await expect(toggle).toBeFocused({ timeout: 2000 });
  await expect(selected).toHaveAttribute('title', initialName);
  await page.keyboard.press('Tab');
  await expect(selected).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(create).toBeFocused({ timeout: 2000 });
  await expect(selected).toHaveAttribute('title', initialName);
  await page.keyboard.press('Shift+Tab');
  await expect(selected).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.getByRole('tab').first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(last).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab').first()).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(selected).toHaveAccessibleName(fullName);
  await expect(last).toBeFocused();
  const previous = tabs.getByRole('tab').nth(longNames.length - 1);
  await page.keyboard.press('ArrowLeft');
  await expect(previous).toBeFocused();
  await expect(selected).toHaveAccessibleName(fullName);
  await page.keyboard.press('Space');
  await expect(previous).toHaveAttribute('aria-selected', 'true');
  await expect(previous).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(selected).toHaveAccessibleName(fullName);
  await page.keyboard.press('Tab');
  await expect(create).toBeFocused();

  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  const navigation = page.getByRole('complementary', { name: '项目导航' });
  const lastRow = navigation.getByRole('button', { name: new RegExp(fullName) });
  await lastRow.focus();
  await expect(lastRow).toBeInViewport({ ratio: 1 });
  await expect(navigation.getByRole('button', { name: '固定', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(navigation.getByRole('button', { name: 'AI 整理记录', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(lastRow).toHaveAttribute('aria-current', 'true');

  await page.getByRole('button', { name: '重命名当前项目', exact: true }).click();
  const name = page.getByRole('textbox', { name: '项目名称', exact: true });
  await expect(name).toHaveValue(fullName);
  await expect(name).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '下载可读摘要（Markdown）' })).toBeInViewport();
  await page.keyboard.press('Escape');
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '导入项目包', exact: true }).click(),
  ]);
  expect(picker.isMultiple()).toBe(false);
  await page.getByRole('dialog', { name: '导入项目包' }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '搜索当前项目卡片', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '搜索当前项目卡片' })).toBeVisible();
});

test('固定导航时导入遮罩覆盖背景项目行', async ({ page, workspace }) => {
  await place(page, '有悬浮工具条的单选卡片', 380, 300);
  const floating = page.locator('.card-floating.card-actions button').first();
  await expect(floating).toBeVisible();
  const tool = (await floating.boundingBox())!;
  const toggle = page.getByRole('button', { name: '项目导航', exact: true });
  await toggle.click();
  const navigation = page.getByRole('complementary', { name: '项目导航' });
  await navigation.getByRole('button', { name: '固定', exact: true }).click();
  const row = navigation.getByRole('button', { name: /未命名研究/ });
  const bounds = (await row.boundingBox())!;
  await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '导入项目包', exact: true }).click(),
  ]);
  const dialog = page.getByRole('dialog', { name: '导入项目包' });
  await expect(dialog).toBeVisible();
  for (const target of [bounds, tool]) {
    const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, point)).toBe('dialog-shade');
    await page.mouse.click(point.x, point.y);
  }
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  expect((await workspace.state()).project.name).toBe('未命名研究');
});

test('1360px 缩至 760px 后继续显示活动或键盘探索中的页签', async ({ page, workspace }) => {
  for (let i = 0; i < 9; i++) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      type: 'project.create', expected: null, payload: { name: '横向滚动时检查可见的长项目名称' + i } });
  }
  await page.reload();
  const tabs = page.getByRole('tablist', { name: '研究项目' });
  await expect(tabs.getByRole('tab')).toHaveCount(10);
  const middle = tabs.getByRole('tab').nth(2);
  const last = tabs.getByRole('tab').last();
  await middle.click();
  await expect(middle).toHaveAttribute('aria-selected', 'true');
  await expect(middle).toBeInViewport({ ratio: 1 });
  await page.locator('.react-flow__pane').click({ position: { x: 400, y: 245 } });
  await expect(middle).not.toBeFocused();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(middle).toBeInViewport({ ratio: 1, timeout: 2000 });

  await page.setViewportSize({ width: 1360, height: 900 });
  await middle.focus();
  await page.keyboard.press('End');
  await expect(last).toBeFocused();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(last).toBeInViewport({ ratio: 1, timeout: 2000 });
  await expect(last).toBeFocused();
  await expect(middle).toHaveAttribute('aria-selected', 'true');
});

test('写字板打开时顶栏导出菜单可真实命中和下载', async ({ page, workspace }) => {
  await place(page, '写字板打开时导出的卡片');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '写字板' })).toBeVisible();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true }).click({ timeout: 2000 }),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  expect((await workspace.state()).cards.map(card => card.title)).toEqual(['写字板打开时导出的卡片']);
});

test('写字板打开时关闭搜索，顶栏的搜索记录失败入口可点击重试', async ({ page, workspace }) => {
  await place(page, '搜索记录与写字板');
  expect((await workspace.state()).cards).toHaveLength(1);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '写字板' })).toBeVisible();
  let fails = true;
  const recordIds: string[] = [];
  await page.route('**/api/mapping/execute', route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'search.record') return route.continue();
    recordIds.push(command.commandId);
    return fails ? route.abort('failed') : route.continue();
  });
  await page.getByRole('button', { name: '搜索当前项目卡片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '搜索当前项目卡片' });
  await dialog.getByRole('searchbox', { name: '关键词' }).fill('搜索记录');
  await dialog.getByRole('button', { name: '关闭搜索', exact: true }).click();
  const retry = page.getByRole('button', { name: '重试保存搜索记录', exact: true });
  await expect(dialog).toBeHidden();
  await expect(retry).toBeVisible();
  fails = false;
  await retry.click({ timeout: 2000 });
  await expect(retry).toBeHidden();
  expect(recordIds).toHaveLength(2);
  expect(recordIds[1]).toBe(recordIds[0]);
});

test('1360px 和 760px 的撤销和重做提示均处于工作台顶栏下方', async ({ page, workspace }) => {
  await place(page, '需要撤销并恢复的研究卡片');
  const topbar = page.locator('.topbar');
  const notice = page.locator('.history-notice');
  for (const width of [1360, 760]) {
    await page.setViewportSize({ width, height: 900 });
    for (const action of ['撤销', '重做']) {
      await topbar.getByRole('button', { name: action, exact: true }).click();
      await expect(notice).toContainText(action);
      const bar = (await topbar.boundingBox())!;
      const tip = (await notice.boundingBox())!;
      expect(tip.y).toBeGreaterThan(bar.y + bar.height);
    }
  }
  expect((await workspace.state()).cards).toHaveLength(1);
});

for (const focus of ['页签', '项目行', '其它仍存活的控件']) {
  test(`真实撤权撤下项目；焦点原在${focus}`, async ({ page, workspace }) => {
    const toggle = page.getByRole('button', { name: '项目导航', exact: true });
    const create = page.getByRole('button', { name: '新建研究', exact: true });
    const tab = page.getByRole('tab', { selected: true });
    await toggle.click();
    const row = page.getByRole('complementary', { name: '项目导航' }).getByRole('button', { name: /未命名研究/ });
    const previouslyFocused = focus === '页签' ? tab : row;
    await previouslyFocused.focus();
    await expect(previouslyFocused).toBeFocused();
    if (focus === '其它仍存活的控件') await create.focus();
    workspace.revoke();
    await expect(page.getByText('授权已失效，请从本机启动入口重新打开；未确认草稿已保留', { exact: true })).toBeVisible();
    await expect(tab).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(focus === '其它仍存活的控件' ? create : toggle).toBeFocused({ timeout: 2000 });
  });
}

test('改名对话框的 Tab 与 Shift+Tab 留在对话框，Esc 和保存恢复触发器焦点', async ({ page, workspace }) => {
  const rename = page.getByRole('button', { name: '重命名当前项目', exact: true });
  const dialog = page.getByRole('dialog', { name: '重命名项目' });
  const name = dialog.getByRole('textbox', { name: '项目名称', exact: true });
  const save = dialog.getByRole('button', { name: '保存名称', exact: true });
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  await rename.focus();
  await page.keyboard.press('Enter');
  await expect(name).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused({ timeout: 2000 });
  await page.keyboard.press('Tab');
  await expect(name).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(rename).toBeFocused();
  await page.keyboard.press('Enter');
  await name.fill('焦点恢复后的项目名称');
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(rename).toBeFocused();
  expect((await workspace.state()).project.name).toBe('焦点恢复后的项目名称');
});

test('改名对话框内非文本按钮的快捷键不会撤销画布，名称仍可原生撤销', async ({ page, workspace }) => {
  await place(page, '改名对话框后仍存在的卡片');
  const before = await workspace.state();
  const historyCommands: string[] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/api/mapping/execute')) return;
    const type = request.postDataJSON().type;
    if (type === 'history.undo' || type === 'history.redo') historyCommands.push(type);
  });
  await page.getByRole('button', { name: '重命名当前项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名项目' });
  const name = dialog.getByRole('textbox', { name: '项目名称', exact: true });
  await name.press('Meta+a');
  await name.pressSequentially('新名称');
  await name.press('Meta+z');
  await expect(name).toHaveValue('新名');
  const historyRequest = page.waitForRequest(request => request.url().endsWith('/api/mapping/execute') &&
    ['history.undo', 'history.redo'].includes(request.postDataJSON().type), { timeout: 1000 }).catch(() => null);
  for (const label of ['取消', '保存名称']) {
    await dialog.getByRole('button', { name: label, exact: true }).press('Meta+z');
  }
  expect(await historyRequest).toBeNull();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await workspace.state()).toEqual(before);
  expect(historyCommands).toEqual([]);
});

for (const outcome of ['延迟', '失败']) {
  test(`改名已保存但项目列表${outcome}时，活动页签、导航与画布立即同步`, async ({ page, workspace }) => {
    const title = '完成改名后的长名称用于核对活动研究仍完整可见';
    for (let i = 0; i < 5; i++) {
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: crypto.randomUUID(),
        type: 'project.create', expected: null, payload: { name: '用于形成横向溢出的独立研究名称' + i } });
    }
    await page.setViewportSize({ width: 760, height: 900 });
    await page.reload();
    const tabs = page.getByRole('tablist', { name: '研究项目' });
    const selected = tabs.getByRole('tab', { selected: true });
    await expect(tabs.getByRole('tab')).toHaveCount(6);
    const selectedId = await selected.getAttribute('title');
    await page.getByRole('button', { name: '项目导航', exact: true }).click();
    const navigation = page.getByRole('complementary', { name: '项目导航' });
    const rename = page.getByRole('button', { name: '重命名当前项目', exact: true });
    await rename.click();
    const name = page.getByRole('textbox', { name: '项目名称', exact: true });
    await name.fill(title);
    await tabs.evaluate(tablist => { tablist.scrollLeft = tablist.scrollWidth; });
    await expect(selected).not.toBeInViewport();

    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let listRequests = 0;
    await page.route('**/api/mapping/projects', async route => {
      listRequests++;
      if (outcome === '失败') return route.abort('failed');
      await delayed;
      await route.continue();
    });
    try {
      const ack = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
        response.request().postDataJSON().type === 'project.rename');
      await page.getByRole('button', { name: '保存名称', exact: true }).click();
      expect((await ack).status()).toBe(200);
      await expect.poll(() => listRequests).toBeGreaterThan(0);
      await expect(page.getByRole('main')).toHaveAccessibleName(title + '画布');
      await expect(selected).toHaveAccessibleName(title, { timeout: 2000 });
      await expect(selected).toHaveAttribute('title', selectedId);
      await expect(selected).toBeInViewport({ ratio: 1 });
      await expect(navigation.getByRole('button', { name: new RegExp(title) })).toHaveAttribute('aria-current', 'true');
    } finally { release(); }
  });
}
