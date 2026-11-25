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
  await page.keyboard.press('Enter');
  await expect(selected).toHaveAccessibleName(fullName);
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '新建研究', exact: true })).toBeFocused();

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
