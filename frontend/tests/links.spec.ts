import { test, expect, place } from './writing-board-fixture';
test.use({ actionTimeout: 6000 });

test('链接单击仅预览，编辑取消保原件，明确打开才导航，移除保显示文；无选区CmdK默认地址', async ({
  page,
  workspace,
}) => {
  await place(page, '链接');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.type('[site](https://example.com/old)');
  await expect(editor.locator('a')).toHaveText('site');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(),
    url = page.url();
  await editor.locator('a').click();
  const preview = page.getByRole('dialog', { name: '链接预览', exact: true });
  await expect(preview).toBeVisible();
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
  await preview.getByRole('button', { name: '编辑链接', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '链接地址', exact: true })).toHaveValue(
    'https://example.com/old',
  );
  await page
    .getByRole('textbox', { name: '链接地址', exact: true })
    .fill('https://example.com/cancelled');
  await page.getByRole('button', { name: '取消链接', exact: true }).click();
  expect((await workspace.state()).cards[0]!.body).toEqual(before.cards[0]!.body);
  await editor.locator('a').click();
  await preview.getByRole('button', { name: '编辑链接', exact: true }).click();
  await page
    .getByRole('textbox', { name: '链接地址', exact: true })
    .fill('https://example.com/new');
  await page.getByRole('button', { name: '应用链接', exact: true }).click();
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/new');
  await editor.locator('a').click();
  await page
    .context()
    .route('https://example.com/**', (route) =>
      route.fulfill({ body: 'local navigation witness', contentType: 'text/plain' }),
    );
  const popup = page.waitForEvent('popup');
  await preview.getByRole('link', { name: '打开链接', exact: true }).click();
  const opened = await popup;
  await opened.waitForURL('https://example.com/new');
  await opened.close();
  await page.bringToFront();
  await preview.getByRole('button', { name: '移除链接', exact: true }).click();
  await expect(editor.locator('a')).toHaveCount(0);
  await expect(editor).toHaveText('site');
  await editor.press('Meta+z');
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/new');
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('End');
  await page.keyboard.type(' ');
  await editor.press('Meta+k');
  await page
    .getByRole('textbox', { name: '链接地址', exact: true })
    .fill('https://example.com/insert');
  await page.getByRole('button', { name: '应用链接', exact: true }).click();
  await expect(editor.locator('a').last()).toHaveText('https://example.com/insert');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('site https://example.com/insert');
});

test('链接编辑保留原生撤销，应用按钮上的撤销不穿透，关闭后画布可撤销', async ({ page, workspace }) => {
  await place(page, '链接撤销边界');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.insertText('保留已保存的正文');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = await workspace.state();
  expect(original.cards[0]!.body.blocks[0]!.text).toBe('保留已保存的正文');

  await page.keyboard.press('Control+k');
  const link = page.getByRole('dialog', { name: '编辑链接', exact: true });
  const address = link.getByRole('textbox', { name: '链接地址', exact: true });
  await expect(address).toBeFocused();
  await page.keyboard.type('x');
  await expect(address).toHaveValue('x');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(address).toHaveValue('');
  await page.keyboard.press('Tab');
  await expect(link.getByRole('textbox', { name: '显示文字', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  const apply = link.getByRole('button', { name: '应用链接', exact: true });
  await expect(apply).toBeFocused();
  await apply.evaluate(button => {
    button.addEventListener('keydown', event => {
      if (event.ctrlKey && event.key === 'z') button.dataset.receivedUndo = 'true';
    });
  });

  const undoRequests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/mapping/execute') &&
        request.postDataJSON()?.type === 'history.undo') undoRequests.push(request.postDataJSON().commandId);
  });
  await page.keyboard.press('Control+z');
  await expect(apply).toHaveAttribute('data-received-undo', 'true');
  await page.keyboard.press('Escape');
  await expect(link).toHaveCount(0);
  expect(undoRequests).toEqual([]);
  expect(await workspace.state()).toEqual(original);
  await expect(editor).toBeFocused();

  await page.getByRole('button', { name: '链接撤销边界', exact: true }).press('Control+z');
  await expect(editor).toHaveText('');
  await expect.poll(async () => (await workspace.state()).project.revision).toBe(original.project.revision + 1);
  expect(undoRequests).toHaveLength(1);
});
