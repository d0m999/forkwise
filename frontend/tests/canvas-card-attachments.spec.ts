import { mkdirSync } from 'node:fs';
import { test, expect } from './writing-board-fixture';

const pdf = '%PDF-1.4\n';
const html = '<p>不应内联</p>';
const shots = '/Users/d0m999/Desktop/forkwise/backend/artifacts/issue36-20261114/screenshots';
mkdirSync(shots, { recursive: true });

async function dropFiles(page: import('@playwright/test').Page, files: { name: string; type: string; text: string }[], x = 80, y = 80) {
  await page.locator('.react-flow__pane').evaluate((pane, input) => {
    const data = new DataTransfer();
    for (const file of input.files) data.items.add(new File([file.text], file.name, { type: file.type }));
    const rect = pane.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: rect.x + input.x, clientY: rect.y + input.y, dataTransfer: data };
    pane.dispatchEvent(new DragEvent('dragover', init));
    pane.dispatchEvent(new DragEvent('drop', init));
  }, { files, x, y });
}

test('拖入 PDF、三个普通文件和图片分别建卡或图片，中文名可打开，其余附件可用键盘展开', async ({ page, workspace }) => {
  await dropFiles(page, [{ name: '财报.pdf', type: 'application/pdf', text: pdf }]);
  await expect(page.getByRole('button', { name: '打开 财报.pdf', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '财报', exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/01-pdf-card.png` });
  const state = await workspace.state();
  expect(state.cards).toHaveLength(1);
  expect(state.cards[0]!.attachments?.items.map(item => item.name)).toEqual(['财报.pdf']);
  expect(state.images ?? []).toEqual([]);

  const opener = page.getByRole('button', { name: '打开 财报.pdf', exact: true });
  await opener.focus();
  const popupPromise = page.waitForEvent('popup', { timeout: 8000 });
  await page.keyboard.press('Enter');
  const popup = await popupPromise;
  await page.waitForTimeout(300);
  await expect(page.getByRole('status'), '新标签打开成功时不应报“弹窗被拦截”').not.toHaveText(/弹窗被拦截/);
  await popup.close();

  await dropFiles(page, [{ name: '页面.html', type: 'text/html', text: html }], 80, 280);
  await expect(page.getByRole('button', { name: '打开 页面.html', exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/02-html-card.png` });
  const htmlDownload = page.waitForEvent('download', { timeout: 8000 });
  await page.getByRole('button', { name: '打开 页面.html', exact: true }).click();
  expect((await htmlDownload).suggestedFilename()).toContain('页面');

  await dropFiles(page, [
    { name: '甲.txt', type: 'text/plain', text: '甲' },
    { name: '乙.txt', type: 'text/plain', text: '乙' },
    { name: '丙.txt', type: 'text/plain', text: '丙' },
  ], 420, 80);
  await expect.poll(async () => (await workspace.state()).cards.map(card => card.title).sort()).toEqual(['丙', '乙', '甲', '财报', '页面']);
  await page.screenshot({ path: `${shots}/03-three-files.png` });

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>';
  await dropFiles(page, [{ name: '图.svg', type: 'image/svg+xml', text: svg }], 420, 320);
  await expect.poll(async () => (await workspace.state()).images?.length ?? 0).toBe(1);
  expect((await workspace.state()).cards.filter(card => card.attachments?.items.some(item => item.name === '图.svg'))).toEqual([]);
  await page.screenshot({ path: `${shots}/04-image-and-files.png` });

  const projectId = state.project.id;
  const host = await workspace.state();
  const card = host.cards.find(value => value.title === '财报')!;
  for (const name of ['补充一.pdf', '补充二.pdf', '补充三.pdf']) {
    const assetId = crypto.randomUUID();
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null, payload: { id: assetId, name, mime: 'application/pdf', base64: Buffer.from(pdf).toString('base64'), kind: 'file' } });
    const latest = (await workspace.state()).cards.find(value => value.id === card.id)!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'card.attachment.add', expected: { attachments: latest.attachments?.versionId ?? null }, payload: { id: card.id, assetId, name } });
  }
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const more = page.getByRole('button', { name: '还有 1 项', exact: true }).first();
  await more.click();
  await expect(page.getByRole('button', { name: '打开 补充三.pdf', exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/05-attachments-expanded.png` });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开 补充三.pdf', exact: true })).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.screenshot({ path: `${shots}/06-attachments-collapsed.png` });
});
