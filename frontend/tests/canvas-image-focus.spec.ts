import { test, expect, place } from './writing-board-fixture';
import type { Locator } from '@playwright/test';

async function pasteImage(editor: Locator) {
  await editor.evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>'], '编辑区图片.svg', { type: 'image/svg+xml' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
}

test('空值contenteditable仍优先接收粘贴，画布不截走文字或单图', async ({ page, workspace }) => {
  const claimed = await page.locator('.canvas').evaluate(canvas => {
    const editor = document.createElement('div'); editor.setAttribute('contenteditable', '');
    editor.setAttribute('aria-label', '临时可编辑区'); canvas.append(editor); editor.focus();
    const data = new DataTransfer(); data.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>'], '编辑区图片.svg', { type: 'image/svg+xml' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }); editor.dispatchEvent(event);
    const result = { prevented: event.defaultPrevented, focused: document.activeElement === editor }; editor.remove(); return result;
  });
  expect(claimed, 'contenteditable空值具有原生可编辑语义，画布不应接管该粘贴').toEqual({ prevented: false, focused: true });
  expect((await workspace.state()).images).toEqual([]); expect((await workspace.state()).cards).toEqual([]);
});

test('已有input保持焦点时画布不接管合成单图事件，项目名称输入不变', async ({ page, workspace }) => {
  await page.getByRole('button', { name: '重命名当前项目', exact: true }).click();
  const input = page.getByRole('textbox', { name: '项目名称', exact: true }); await input.fill('保留当前名称输入');
  const claimed = await page.locator('.react-flow__pane').evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>'], 'input焦点.svg', { type: 'image/svg+xml' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(claimed).toBe(false); await expect(input).toBeFocused(); await expect(input).toHaveValue('保留当前名称输入');
  expect((await workspace.state()).images).toEqual([]); expect((await workspace.state()).cards).toEqual([]);
});

test('标题输入与合成输入期间粘贴不创建画布对象，组合输入继续保存在原卡', async ({ page, workspace }) => {
  await place(page, '标题焦点'); await page.getByRole('button', { name: '标题焦点', exact: true }).dblclick();
  const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.focus(); await pasteImage(editor);
  await editor.dispatchEvent('compositionstart'); await editor.fill('组合中的标题');
  await page.locator('.react-flow__pane').evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', '不应变成画布卡片');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor).toHaveValue('组合中的标题'); await expect(editor).toBeFocused();
  await editor.dispatchEvent('compositionend'); await editor.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards[0]!.title).toBe('组合中的标题');
  expect((await workspace.state()).cards).toHaveLength(1); expect((await workspace.state()).images).toEqual([]);
});

for (const kind of ['text', 'shape'] as const) test(`${kind}已有编辑入口优先，单图片粘贴不泄漏成画布图片或卡片`, async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: kind + '.create', expected: null,
    payload: kind === 'text' ? { id: 'focus-text', content: { runs: [{ text: '独立文字焦点' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 190 }, pose: { x: 250, y: 190, width: 190, height: 27 } }
      : { id: 'focus-shape', content: { shapeType: 'rectangle', shortText: '形状文字焦点' }, pose: { x: 250, y: 190, width: 190, height: 100 } } });
  await page.reload();
  if (kind === 'text') await page.locator('.canvas-text-content').dblclick();
  else { await page.getByRole('img', { name: '形状文字焦点', exact: true }).click(); await page.getByRole('button', { name: '编辑形状文字', exact: true }).click(); }
  const editor = page.getByRole('textbox', { name: kind === 'text' ? '独立文字' : '形状文字', exact: true });
  await editor.focus(); await pasteImage(editor);
  await expect(editor).toBeFocused(); expect((await workspace.state()).images).toEqual([]); expect((await workspace.state()).cards).toEqual([]);
});

test('正文内单图粘贴继续创建正文图片，独立图片与卡片数量不变', async ({ page, workspace }) => {
  await place(page, '正文焦点'); await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true }); await editor.click(); await pasteImage(editor);
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.some(block => block.type === 'image')).toBe(true);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).cards).toHaveLength(1); expect((await workspace.state()).images).toEqual([]);
});
