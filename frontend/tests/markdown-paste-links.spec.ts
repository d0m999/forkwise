import { test, expect, place } from './writing-board-fixture';

test('当前围栏以Enter转换为可读代码，代码内Markdown与换行保持字面且可撤销重开', async ({
  page,
  workspace,
}) => {
  await place(page, '围栏');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.type('```js');
  await page.keyboard.press('Enter');
  await expect(editor.locator('pre')).toHaveCount(1);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('```js');
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect(editor.locator('pre')).toHaveCount(1);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await page.keyboard.type('**literal**');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# still literal');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('**literal**\n# still literal');
  await expect(editor.locator('strong,h1')).toHaveCount(0);
  const saved = (await workspace.state()).cards[0]!.body.blocks;
  expect(saved[0]).toMatchObject({ type: 'code', language: 'js', wrap: false });
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '围栏', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('pre')).toContainText('**literal**');
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(saved);
});

test('段首列表待办引用分隔线与成对行内快捷仅消费当前序列，逐项一次撤销', async ({
  page,
  workspace,
}) => {
  await place(page, '快捷范围');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  for (const [raw, selector] of [
    ['# ', 'h1'],
    ['### ', 'h3'],
    ['- ', '[data-list-type="bullet"]'],
    ['1. ', '[data-list-type="ordered"]'],
    ['[ ] ', '[data-list-type="todo"]'],
    ['> ', 'blockquote'],
    ['---', 'hr'],
    ['**bold**', 'strong'],
    ['*italic*', 'em'],
    ['~~strike~~', 's'],
    ['`literal`', 'code'],
    ['[site](https://example.com/)', 'a'],
  ]) {
    await editor.fill('');
    await editor.click();
    await page.keyboard.type(raw!);
    await expect(editor.locator(selector!)).toHaveCount(1);
    await editor.press('Meta+z');
    await expect
      .poll(async () =>
        (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text).join('\n'),
      )
      .toBe(raw);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
  }
});

test('当前键入标题快捷转换，一次撤销恢复完整触发文字且不误合并前史', async ({
  page,
  workspace,
}) => {
  await place(page, 'Markdown');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.type('history');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## ');
  await expect(editor.locator('h2')).toHaveCount(1);
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['text', 'history'],
      ['heading', ''],
    ]);
  await page.keyboard.press('Meta+z');
  await expect(editor).toContainText('## ');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['text', 'history'],
      ['text', '## '],
    ]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['history', '']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await page.keyboard.press('Meta+Shift+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['text', 'history'],
      ['text', '## '],
    ]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await page.keyboard.press('Meta+Shift+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[1]!.type)
    .toBe('heading');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const saved = await workspace.state();
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(saved.project.id, saved.cards[0]!.id, snapshot!);
  expect(agent.revision).toBe(saved.project.revision);
  expect(agent.body.blocks).toEqual(saved.cards[0]!.body.blocks);
  await workspace.restart();
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(saved.cards[0]!.body.blocks);
});
