import { test, expect, place } from './writing-board-fixture';

const pdf = '%PDF-1.4\n';
const html = '<p>不应内联</p>';

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

test('已有普通卡从更多菜单添加首个附件，撤销后恢复紧凑卡面', async ({ page, workspace }) => {
  await place(page, '普通研究卡');
  const before = (await workspace.state()).cards[0]!;
  expect(before.attachments).toBeUndefined();
  await expect(page.getByRole('group', { name: '卡片附件' })).toHaveCount(0);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  const add = page.getByRole('dialog', { name: '更多' }).getByRole('button', { name: '添加附件' });
  await expect(add).toBeVisible({ timeout: 3000 });
  const chooser = page.waitForEvent('filechooser');
  await add.press('Enter');
  await (await chooser).setFiles({ name: '研究.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  const opened = page.getByRole('button', { name: '打开 研究.pdf', exact: true });
  await expect(opened).toBeVisible();
  const saved = (await workspace.state()).cards;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ id: before.id, title: before.title, body: before.body });
  expect(saved[0]!.attachments!.items.map(item => item.name)).toEqual(['研究.pdf']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('group', { name: '卡片附件' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '普通研究卡', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(opened).toBeVisible();
  await workspace.restart();
  await workspace.open(page);
  await expect(opened).toBeVisible();
  expect((await workspace.state()).cards[0]!.attachments).toEqual(saved[0]!.attachments);
});

test('复制单个附件到同项目已有同名卡，保留独立笔记和原件', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, text, x] of [['target-b', '乙原笔记', 80], ['target-c', '丙原笔记', 420]] as const) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
      payload: { id, title: '同名研究', text, x, y: 350 } });
  }
  await page.reload();
  await expect(page.getByRole('button', { name: '同名研究', exact: true })).toHaveCount(2);
  await dropFiles(page, [{ name: '来源.pdf', type: 'application/pdf', text: pdf }]);
  await expect(page.getByRole('button', { name: '打开 来源.pdf', exact: true })).toBeVisible();
  const sourceNode = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '来源', exact: true }) });
  const chooser = page.waitForEvent('filechooser');
  await sourceNode.getByRole('button', { name: '添加附件' }).click();
  await (await chooser).setFiles({ name: '附表.txt', mimeType: 'text/plain', buffer: Buffer.from('附表') });
  await expect(sourceNode.getByRole('button', { name: '打开 附表.txt' })).toBeVisible();
  const initial = (await workspace.state()).cards;
  const source = initial.find(card => card.title === '来源')!;
  const original = source.attachments!.items[0]!;
  const target = initial.find(card => card.id === 'target-b')!;
  const other = initial.find(card => card.id === 'target-c')!;
  const targetNode = page.locator(`.react-flow__node[data-id="${target.item.id}"]`);
  const copy = sourceNode.getByRole('button', { name: '复制 来源.pdf 到其他卡片' });
  await expect(copy).toBeVisible({ timeout: 3000 });
  await copy.press('Enter');
  const dialog = page.getByRole('dialog', { name: '复制附件到卡片' });
  const picker = dialog.getByRole('combobox', { name: '目标卡片' });
  await expect(picker).toBeFocused();
  await expect(dialog.getByRole('button', { name: '复制', exact: true })).toBeDisabled();
  await picker.press('Control+z');
  await picker.press('Tab');
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(picker).toBeFocused();
  const sameNameLabels = await picker.getByRole('option', { name: /同名研究/ }).allTextContents();
  expect(sameNameLabels).toHaveLength(2);
  expect(new Set(sameNameLabels).size).toBe(2);
  await picker.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(copy).toBeFocused();
  await copy.press('Enter');
  await picker.selectOption(target.id);
  await dialog.getByRole('button', { name: '复制', exact: true }).click();
  const copied = targetNode.getByRole('button', { name: '打开 来源.pdf' });
  await expect(copied).toBeVisible();
  const cards = (await workspace.state()).cards;
  expect(cards).toHaveLength(3);
  expect(cards.find(card => card.id === source.id)!.attachments).toEqual(source.attachments);
  expect(cards.find(card => card.id === other.id)!.attachments).toBeUndefined();
  const targetAfterCopy = cards.find(card => card.id === target.id)!;
  expect(targetAfterCopy.body).toEqual(target.body);
  expect(targetAfterCopy.attachments!.items).toEqual([{ id: expect.any(String), assetId: original.assetId, name: original.name }]);
  expect(targetAfterCopy.attachments!.items[0]!.id).not.toBe(original.id);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(copied).toHaveCount(0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(copied).toBeVisible();
  await targetNode.locator('.title-button').click();
  await targetNode.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('textbox', { name: '卡片正文' }).fill('只改乙笔记');
  await page.getByRole('button', { name: '关闭正文' }).click();
  await targetNode.getByRole('button', { name: '解除 来源.pdf' }).click();
  await expect(copied).toHaveCount(0);
  await workspace.restart();
  await workspace.open(page);
  await expect(sourceNode.getByRole('button', { name: '打开 来源.pdf' })).toBeVisible();
  const reopened = (await workspace.state()).cards;
  expect(reopened.find(card => card.id === source.id)).toMatchObject({ attachments: source.attachments, body: source.body });
  expect(reopened.find(card => card.id === other.id)!.body).toEqual(other.body);
  const reopenedTarget = reopened.find(card => card.id === target.id)!;
  expect(reopenedTarget.attachments?.items ?? []).toEqual([]);
  expect(reopenedTarget.body.blocks.map(block => block.text)).toEqual(['只改乙笔记']);
  const content = await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/assets/${original.assetId}/content`);
  expect(await content.body()).toEqual(Buffer.from(pdf));
});

for (const action of ['粘贴', '搜索快捷键'] as const) test(`附件复制对话框内的${action}不会触发背景画布操作`, async ({ page, workspace }) => {
  await place(page, '目标卡');
  await dropFiles(page, [{ name: '来源.pdf', type: 'application/pdf', text: pdf }]);
  const copy = page.getByRole('button', { name: '复制 来源.pdf 到其他卡片' });
  await copy.press('Enter');
  const dialog = page.getByRole('dialog', { name: '复制附件到卡片' });
  const picker = dialog.getByRole('combobox', { name: '目标卡片' });
  await expect(picker).toBeFocused();
  const search = page.getByRole('dialog', { name: '搜索当前项目卡片' });
  if (action === '搜索快捷键') {
    for (const key of ['Control+k', 'Meta+k']) {
      await picker.press(key);
      await expect(picker).toBeFocused();
      await expect(search).toBeHidden();
    }
    await picker.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(search).toBeVisible();
    return;
  }

  const paste = (target: typeof picker, text: string) => target.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  await paste(picker, '对话框中的文本');
  await picker.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await paste(page.locator('.react-flow__pane'), '画布中的文本');
  await expect.poll(async () => (await workspace.state()).cards.flatMap(card => card.body.blocks.map(block => block.text)))
    .toContain('画布中的文本');
  expect((await workspace.state()).cards).toHaveLength(3);
});

test('拖入 PDF、三个普通文件和图片分别建卡或图片，中文名可打开，其余附件可用键盘展开', async ({ page, workspace }) => {
  await dropFiles(page, [{ name: '财报.pdf', type: 'application/pdf', text: pdf }]);
  await expect(page.getByRole('button', { name: '打开 财报.pdf', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '财报', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-pdf-card.png') });
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
  await page.screenshot({ path: test.info().outputPath('02-html-card.png') });
  const htmlPopupPromise = page.waitForEvent('popup');
  const downloadPromise = htmlPopupPromise.then(popup => popup.waitForEvent('download', { timeout: 8000 }));
  await page.getByRole('button', { name: '打开 页面.html', exact: true }).click();
  const htmlPopup = await htmlPopupPromise;
  expect((await downloadPromise).suggestedFilename()).toContain('页面');
  await expect(page.getByRole('status')).not.toHaveText(/弹窗被拦截|附件未能下载/);
  if (!htmlPopup.isClosed()) await htmlPopup.close();

  await dropFiles(page, [
    { name: '甲.txt', type: 'text/plain', text: '甲' },
    { name: '乙.txt', type: 'text/plain', text: '乙' },
    { name: '丙.txt', type: 'text/plain', text: '丙' },
  ], 420, 80);
  await expect.poll(async () => (await workspace.state()).cards.map(card => card.title).sort()).toEqual(['丙', '乙', '甲', '财报', '页面']);
  await page.screenshot({ path: test.info().outputPath('03-three-files.png') });

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="green"/></svg>';
  await dropFiles(page, [{ name: '图.svg', type: 'image/svg+xml', text: svg }], 420, 320);
  await expect.poll(async () => (await workspace.state()).images?.length ?? 0).toBe(1);
  expect((await workspace.state()).cards.filter(card => card.attachments?.items.some(item => item.name === '图.svg'))).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('04-image-and-files.png') });

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
  await page.screenshot({ path: test.info().outputPath('05-attachments-expanded.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开 补充三.pdf', exact: true })).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('06-attachments-collapsed.png') });
});
