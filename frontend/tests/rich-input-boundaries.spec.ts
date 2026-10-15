import { test, expect, place } from './writing-board-fixture';
test.use({ actionTimeout: 6000 });

test('段首新输入触发仅消费新标记，保留后方历史文字，撤销恢复完整原输入', async ({
  page,
  workspace,
}) => {
  await place(page, '前缀');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await editor.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '旧文 **未解释**');
    el.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    );
  });
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('旧文 **未解释**');
  await editor.press('Home');
  await page.keyboard.type('## ');
  await expect(editor.locator('h2')).toHaveText('旧文 **未解释**');
  await expect(editor.locator('strong')).toHaveCount(0);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([['text', '## 旧文 **未解释**']]);
});

test('浏览器组合事件优先，组合完成和历史标记的后续单字符不重新解释旧正文', async ({
  page,
  workspace,
}) => {
  await place(page, '组合');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.dispatchEvent('compositionstart', { data: '' });
  await editor.fill('## ');
  await editor.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  await expect(editor.locator('h2')).toHaveCount(0);
  await editor.dispatchEvent('compositionend', { data: '## ' });
  await page.keyboard.type(' ');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([['text', '##  ']]);
  await editor.fill('');
  await editor.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '**旧文*');
    el.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    );
  });
  await page.keyboard.type('*');
  await expect(editor).toHaveText('**旧文**');
  await expect(editor.locator('strong')).toHaveCount(0);
});

test('代码内普通富文和明确Markdown粘贴均为块内纯文字与空行', async ({ page, workspace }) => {
  await place(page, '代码粘贴');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.type('```txt');
  await editor.press('Enter');
  await editor.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '**raw**\n\n# next');
    clipboardData.setData('text/html', '<h1>wrong</h1>');
    el.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    );
  });
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([['code', '**raw**\n\n# next']]);
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: async () => '\n**literal**\n\n> plain',
    }),
  );
  await page.getByRole('button', { name: /^选择块：/ }).click();
  await page.getByRole('menuitem', { name: '粘贴为 Markdown', exact: true }).click();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text, b.marks ?? null]),
    )
    .toEqual([['code', '**raw**\n\n# next\n**literal**\n\n> plain', null]]);
  await expect(editor.locator('strong,h1,blockquote')).toHaveCount(0);
});

test('明确粘贴等待期间关闭原卡后，晚到剪贴板内容不能落到新卡片', async ({ page, workspace }) => {
  await place(page, '原目标');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('原文');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('原文');
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          (window as any).finishOldPaste = resolve;
        }),
    }),
  );
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '粘贴为纯文本', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishOldPaste))
    .toBe('function');
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await place(page, '新目标');
  await page.getByRole('button', { name: '编辑正文', exact: true }).last().click();
  await editor.click();
  await page.evaluate(() => (window as any).finishOldPaste('迟到内容'));
  await expect(editor).toBeEmpty();
  expect((await workspace.state()).cards.map((c) => c.body.blocks.map((b) => b.text))).toEqual([
    ['原文'],
    [''],
  ]);
});
