import type { Locator, Page } from '@playwright/test';
import type { Block } from '../../backend/src/mapping/contracts';
import { expect, test, type Workspace } from './writing-board-fixture';

const paragraphs = ['第一段库存观察。', '第二段 selection 测试。', '第三段库存补充。'];

async function openDocument(page: Page, workspace: Workspace, blocks?: Block[]) {
  const { project } = await workspace.state();
  const id = 'writing-board-tools-card';
  await workspace.execute(page, {
    type: 'thought.create',
    projectId: project.id,
    commandId: crypto.randomUUID(),
    expected: null,
    payload: { id, title: '按需编辑示例', text: '', x: 100, y: 100 },
  });
  const { body } = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: 'body.edit',
    projectId: project.id,
    commandId: crypto.randomUUID(),
    expected: body.versionId,
    payload: {
      id,
      blocks: blocks ?? paragraphs.map((text, index) => ({ id: `tools-paragraph-${index}`, type: 'text', text })),
    },
  });
  await page.reload();
  await page.locator('.react-flow__node').click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const editor = board.getByRole('textbox', { name: '卡片正文' });
  if (!blocks) await expect(editor.locator('p')).toHaveText(paragraphs);
  return { board, editor };
}

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 10; index++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(node => node === document.activeElement)) return;
  }
  await expect(target).toBeFocused({ timeout: 1000 });
}

test('静态阅读隐藏拖柄，悬停只显示当前块的编辑入口', async ({ page, workspace }) => {
  const { board, editor } = await openDocument(page, workspace);
  await page.mouse.move(4, 140);
  const handles = board.getByRole('button', { name: /^选择块：/ });
  for (const handle of await handles.all()) await expect(handle).toHaveCSS('opacity', '0');
  const before = await editor.locator('p').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  await editor.locator('p').nth(1).hover();
  await expect(handles.nth(1)).toHaveCSS('opacity', '1');
  await expect(handles.nth(0)).toHaveCSS('opacity', '0');
  await expect(handles.nth(2)).toHaveCSS('opacity', '0');
  await expect(board.getByRole('button', { name: '插入块', exact: true })).toBeVisible();
  await expect(board.getByRole('toolbar', { name: '文字格式' })).toHaveCount(0);
  expect(await editor.locator('p').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top))).toEqual(before);
});

test('Tab 聚焦第二段时可键盘打开块菜单和插入，取消保留触发焦点', async ({ page, workspace }) => {
  const { board, editor } = await openDocument(page, workspace);
  await page.mouse.move(4, 140);
  const handle = board.getByRole('button', { name: `选择块：${paragraphs[1]}`, exact: true });
  await board.getByRole('button', { name: '关闭正文', exact: true }).focus();
  await tabTo(page, handle);
  await expect(handle).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  const menu = board.getByRole('menu', { name: '转换块类型' });
  await expect(menu).toBeVisible();
  const [triggerBox, menuBox] = await Promise.all([handle.boundingBox(), menu.boundingBox()]);
  expect(Math.abs(menuBox!.x - triggerBox!.x)).toBeLessThan(85);
  await page.keyboard.press('Escape');
  await expect(handle).toBeFocused();
  const insert = board.getByRole('button', { name: '插入块', exact: true });
  await page.keyboard.press('Tab');
  await expect(insert).toBeFocused({ timeout: 1000 });
  await editor.locator('p').nth(2).hover();
  await expect(insert).toBeFocused({ timeout: 1000 });
  await page.keyboard.press('Enter');
  const filter = board.getByRole('textbox', { name: '筛选块类型' });
  await filter.fill('引用');
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await page.keyboard.insertText('新增引用');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).cards[0]!.body.blocks.map(({ type, text }) => [type, text])).toEqual([
    ['text', paragraphs[0]],
    ['text', paragraphs[1]],
    ['quote', '新增引用'],
    ['text', paragraphs[2]],
  ]);
});

test('Tab 进入键盘选区的格式工具并应用，恢复原文字选区', async ({ page, workspace }) => {
  const { board, editor } = await openDocument(page, workspace);
  await editor.locator('p').first().click({ position: { x: 3, y: 13 } });
  await page.keyboard.press('Home');
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight');
  const selection = () => page.evaluate(() => getSelection()?.toString());
  expect(await selection()).toBe('第一段');
  const bold = board.getByRole('button', { name: '加粗', exact: true });
  await expect(bold).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(bold).toBeFocused({ timeout: 1000 });
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  expect(await selection()).toBe('第一段');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).cards[0]!.body.blocks[0]!.marks).toEqual([{ type: 'bold', start: 0, end: 3 }]);
});

test('从大表切到小表的块柄时，Tab 保留块焦点与正文版本', async ({ page, workspace }) => {
  const { board, editor } = await openDocument(page, workspace, [
    { id: 'large-table', type: 'table', header: false, rows: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }, { text: 'D' }]] },
    { id: 'small-table', type: 'table', header: false, rows: [[{ text: 'E' }]] },
  ]);
  const before = (await workspace.state()).cards[0]!.body;
  await editor.locator('[data-block-id="large-table"] [data-cell="1,1"]').click();
  await page.keyboard.press('Escape');
  const handles = board.getByRole('button', { name: '选择块：table', exact: true });
  await board.getByRole('button', { name: '关闭正文', exact: true }).focus();
  await tabTo(page, handles.first());
  await page.keyboard.press('Tab');
  const insert = board.getByRole('button', { name: '插入块', exact: true });
  await expect(insert).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(handles.last()).toBeFocused({ timeout: 1500 });
  await page.keyboard.press('Tab');
  await expect(insert).toBeFocused();
  expect((await workspace.state()).cards[0]!.body).toEqual(before);
});

test('取消替换正文图片时，返回本次图片操作并保留原正文', async ({ page, workspace }) => {
  const { board, editor } = await openDocument(page, workspace);
  await editor.locator('p').nth(1).hover();
  await board.getByRole('button', { name: '插入块', exact: true }).click();
  const firstChooser = page.waitForEvent('filechooser');
  await board.getByRole('menuitem', { name: '图片', exact: true }).click();
  await (await firstChooser).setFiles({
    name: '合成原图.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>'),
  });
  const image = editor.getByRole('img', { name: '合成原图.svg' });
  await expect(image).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = (await workspace.state()).cards[0]!.body;
  await editor.press('Escape');
  const firstHandle = board.getByRole('button', { name: `选择块：${paragraphs[0]}`, exact: true });
  await board.getByRole('button', { name: '关闭正文', exact: true }).focus();
  await tabTo(page, firstHandle);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(firstHandle).toBeFocused();
  await image.hover();

  const input = board.getByLabel('选择正文图片文件');
  await input.evaluate(node => {
    node.addEventListener('cancel', event => {
      node.setAttribute('data-observed-cancel', String(event.isTrusted));
    }, { once: true });
  });
  const replace = page.getByRole('button', { name: '替换正文图片', exact: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true });
  try {
    await replace.click();
    await expect(input).toHaveAttribute('data-observed-cancel', 'true', { timeout: 1500 });
  } finally {
    await cdp.detach();
  }
  await expect(replace).toBeFocused({ timeout: 1500 });
  expect((await workspace.state()).cards[0]!.body).toEqual(before);
});

test.describe('760 px Chromium 触控', () => {
  test.use({ hasTouch: true, viewport: { width: 760, height: 900 } });

  test('触控选中第二段和原词后，应用格式保留同一文字选区', async ({ page, workspace }) => {
    const { board, editor } = await openDocument(page, workspace);
    const word = await editor.locator('p').nth(1).evaluate(node => {
      const range = document.createRange();
      range.setStart(node.firstChild!, 5);
      range.setEnd(node.firstChild!, 7);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.touchscreen.tap(word.x, word.y);
    await expect(board.getByRole('button', { name: '插入块', exact: true })).toBeVisible();
    await expect(board.getByRole('button', { name: `选择块：${paragraphs[1]}`, exact: true })).toHaveCSS('opacity', '1');
    await page.touchscreen.tap(word.x, word.y);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('selection');
    await board.getByRole('button', { name: '加粗', exact: true }).tap();
    await expect(editor.locator('p').nth(1).locator('strong')).toHaveText('selection');
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('selection');
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect((await workspace.state()).cards[0]!.body.blocks[1]!.marks).toEqual([{ type: 'bold', start: 4, end: 13 }]);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('');
    await expect(board.getByRole('toolbar', { name: '文字格式' })).toHaveCount(0);
  });
});
