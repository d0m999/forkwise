import { test, expect, place } from './writing-board-fixture';
import { openMapping } from '../../backend/src/mapping/storage';

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

  const clipboard = await page.evaluateHandle(() => {
    const clipboard = navigator.clipboard;
    const readDescriptor = Object.getOwnPropertyDescriptor(clipboard, 'read');
    let reads = 0;
    let rejectRead!: (reason: DOMException) => void;
    // 用例只注入合成事件，不读取系统剪贴板。让产品等待这次读取，再由测试拒绝。
    const pendingRead = new Promise<ClipboardItem[]>((_, reject) => { rejectRead = reject; });
    Object.defineProperty(clipboard, 'read', {
      configurable: true,
      value: () => {
        reads++;
        return pendingRead;
      },
    });
    return {
      readCount: () => reads,
      rejectRead: () => rejectRead(new DOMException('剪贴板读取不可用', 'NotAllowedError')),
      restore: () => {
        if (readDescriptor) Object.defineProperty(clipboard, 'read', readDescriptor);
        else Reflect.deleteProperty(clipboard, 'read');
      },
    };
  });
  const paste = (target: typeof picker, text: string) => target.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
  const cardBodies = async () => (await workspace.state()).cards.map(({ id, body }) => ({ id, body }));
  try {
    const before = await cardBodies();
    expect(before).toHaveLength(2);
    await paste(picker, '对话框中的文本');
    expect(await clipboard.evaluate(probe => probe.readCount())).toBe(0);
    expect(await cardBodies()).toEqual(before);
    await picker.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');

    expect(await paste(page.locator('.react-flow__pane'), '画布中的文本')).toBe(true);
    expect(await clipboard.evaluate(probe => probe.readCount())).toBe(1);
    expect(await cardBodies()).toEqual(before);
    await clipboard.evaluate(probe => probe.rejectRead());
    await expect.poll(async () => (await cardBodies()).length).toBe(3);

    const after = await cardBodies();
    const originalIds = new Set(before.map(card => card.id));
    expect(after.filter(card => originalIds.has(card.id))).toEqual(before);
    expect(after.filter(card => !originalIds.has(card.id)).map(card => card.body.blocks.map(block => block.text)))
      .toEqual([['画布中的文本']]);
  } finally {
    await clipboard.evaluate(probe => probe.restore());
    await clipboard.dispose();
  }
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

test('画布长附件名保留文件末尾，窄窗可在写字板复制并回到原操作', async ({ page, workspace }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const filename = '2026年研究原始资料-客户与主要产品线经营变化-季度同期数据对照-最后修订版-附录第七节.pdf';
  await place(page, '乙卡', 360, 300);
  await dropFiles(page, [{ name: filename, type: 'application/pdf', text: pdf }], 70, 100);
  const canvasAttachment = page.getByRole('button', { name: `打开 ${filename}`, exact: true });
  await expect(canvasAttachment).toBeVisible();
  const nameFits = (name: typeof canvasAttachment) => name.evaluate(button => button.scrollWidth <= button.clientWidth);
  await expect.poll(async () => nameFits(canvasAttachment)).toBe(true);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await canvasAttachment.evaluate(button => {
    const text = button.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length - 4);
    range.setEnd(text, text.textContent!.length);
    return range.getBoundingClientRect().bottom <= button.closest('article')!.getBoundingClientRect().bottom;
  })).toBe(true);

  const source = page.locator('.react-flow__node').filter({ has: canvasAttachment });
  await source.locator('.title-button').click();
  await source.getByRole('button', { name: '编辑正文' }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const boardList = board.getByRole('group', { name: '卡片附件' });
  const boardAttachment = boardList.getByRole('button', { name: `打开 ${filename}`, exact: true });
  await expect(boardAttachment).toBeVisible({ timeout: 3000 });
  expect(await nameFits(boardAttachment)).toBe(true);
  const copy = boardList.getByRole('button', { name: `复制 ${filename} 到其他卡片` });
  const dialog = page.getByRole('dialog', { name: '复制附件到卡片' });
  const picker = dialog.getByRole('combobox', { name: '目标卡片' });
  await copy.press('Enter');
  await expect(picker).toBeFocused();
  await picker.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(copy).toBeFocused();
  await copy.press('Enter');
  await picker.selectOption({ label: '乙卡' });
  await dialog.getByRole('button', { name: '复制', exact: true }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(copy).toBeFocused();
  const targetRead = async () => (await workspace.state()).cards.find(card => card.title === '乙卡')!;
  await expect.poll(async () => (await targetRead()).attachments?.items[0]?.name).toBe(filename);
  const saved = await workspace.state();
  const target = await targetRead();
  const targetNode = page.locator(`.react-flow__node[data-id="${target.item.id}"]`);
  const targetAttachment = targetNode.getByRole('button', { name: `打开 ${filename}`, exact: true });
  await board.getByRole('button', { name: '返回画布' }).click();
  await expect(targetAttachment).toBeVisible();
  expect(saved.cards.find(card => card.id !== target.id)!.attachments!.items[0]!.assetId)
    .toEqual(target.attachments!.items[0]!.assetId);
});

test('写字板能添加第一个附件，选择另一卡等待保存时仍显示原卡附件', async ({ page, workspace }) => {
  await place(page, '原卡', 80, 120);
  await place(page, '另一卡', 430, 300);
  const state = await workspace.state();
  const original = state.cards.find(card => card.title === '原卡')!;
  const other = state.cards.find(card => card.title === '另一卡')!;
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const sourceNode = node(original.item.id), otherNode = node(other.item.id);
  await sourceNode.locator('.title-button').click();
  await sourceNode.getByRole('button', { name: '编辑正文' }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const list = board.getByRole('group', { name: '卡片附件' });
  await expect(sourceNode.getByRole('group', { name: '卡片附件' })).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await list.getByRole('button', { name: '添加附件' }).click();
  await (await chooser).setFiles({ name: '原卡资料.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  const opened = list.getByRole('button', { name: '打开 原卡资料.pdf' });
  await expect(opened).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');

  let release!: () => void;
  const holdBody = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type === 'body.edit') await holdBody;
    await route.continue();
  });
  try {
    const editor = board.getByRole('textbox', { name: '卡片正文' });
    await editor.fill('原卡正在保存的笔记');
    await expect(board.getByText('正在保存…', { exact: true })).toBeVisible();
    await otherNode.locator('.title-button').click();
    await expect(otherNode).toHaveClass(/\bselected\b/);
    await expect(board.getByRole('heading', { name: '原卡' })).toBeVisible();
    await expect(opened).toBeVisible();
    release();
    await expect.poll(async () => (await workspace.state()).cards.find(card => card.id === original.id)!.body.blocks[0]!.text)
      .toBe('原卡正在保存的笔记');
    const cards = (await workspace.state()).cards;
    expect(cards.find(card => card.id === original.id)!.attachments?.items[0]?.name).toBe('原卡资料.pdf');
    expect(cards.find(card => card.id === other.id)!.attachments).toBeUndefined();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('附件写入等待确认时，已打开的复制框保留目标，保存后恢复提交和焦点', async ({ page, workspace }) => {
  await place(page, '乙卡', 385, 300);
  await dropFiles(page, [{ name: '来源.pdf', type: 'application/pdf', text: pdf }]);
  const source = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '来源', exact: true }) });
  await source.locator('.title-button').click();
  await source.getByRole('button', { name: '编辑正文' }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const copy = board.getByRole('button', { name: '复制 来源.pdf 到其他卡片' });
  const dialog = page.getByRole('dialog', { name: '复制附件到卡片' });
  const picker = dialog.getByRole('combobox', { name: '目标卡片' });
  const confirm = dialog.getByRole('button', { name: '复制', exact: true });
  let releaseUpload!: () => void, releaseAdd!: () => void;
  const upload = new Promise<void>(resolve => { releaseUpload = resolve; });
  const add = new Promise<void>(resolve => { releaseAdd = resolve; });
  let copyWrites = 0;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'card.attachment.add' && command.payload.name === '来源.pdf') copyWrites++;
    if (command.payload?.name === '补充.txt') {
      if (command.type === 'asset.save') await upload;
      if (command.type === 'card.attachment.add') await add;
    }
    await route.continue();
  });
  try {
    const uploadSent = page.waitForRequest(request => request.method() === 'POST' &&
      request.url().endsWith('/execute') && request.postDataJSON().type === 'asset.save');
    const chooser = page.waitForEvent('filechooser');
    await board.getByRole('button', { name: '添加附件' }).click();
    await (await chooser).setFiles({ name: '补充.txt', mimeType: 'text/plain', buffer: Buffer.from('补充') });
    await uploadSent;
    await copy.press('Enter');
    await picker.selectOption({ label: '乙卡' });
    const addSent = page.waitForRequest(request => request.method() === 'POST' &&
      request.url().endsWith('/execute') && request.postDataJSON().payload.name === '补充.txt' &&
      request.postDataJSON().type === 'card.attachment.add');
    releaseUpload();
    await addSent;
    await picker.evaluate(element => element.closest('form')!.requestSubmit());
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '取消' })).toBeEnabled();
    await expect(picker).toHaveValue((await workspace.state()).cards.find(card => card.title === '乙卡')!.id);
    expect(copyWrites).toBe(0);
    releaseAdd();
    await expect(confirm).toBeEnabled();
    await confirm.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await workspace.state()).cards.find(card => card.title === '乙卡')?.attachments?.items[0]?.name)
      .toBe('来源.pdf');
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(copy).toBeFocused();
    expect(copyWrites).toBe(1);
  } finally {
    releaseUpload();
    releaseAdd();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('等待切换项目时旧写字板附件仍可读，添加、复制和解除不可写', async ({ page, workspace }) => {
  await dropFiles(page, [{ name: '原项目资料.pdf', type: 'application/pdf', text: pdf }]);
  await expect(page.getByRole('button', { name: '打开 原项目资料.pdf' })).toBeVisible();
  const first = await workspace.state();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: 'other-project', type: 'project.create', expected: null,
    payload: { name: '新项目' } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const source = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '原项目资料', exact: true }) });
  await source.locator('.title-button').click();
  await source.getByRole('button', { name: '编辑正文' }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  let release!: () => void;
  const waitForProject = new Promise<void>(resolve => { release = resolve; });
  const targetMap = '/api/mapping/projects/other-project/map';
  await page.route(url => url.pathname === targetMap, async route => {
    await waitForProject;
    await route.continue();
  });
  try {
    const nextTab = page.getByRole('tab', { name: '新项目', exact: true });
    const pending = page.waitForRequest(request => new URL(request.url()).pathname === targetMap);
    await nextTab.click();
    await pending;
    await expect(board.getByRole('button', { name: '打开 原项目资料.pdf' })).toBeEnabled();
    for (const name of ['添加附件', '复制 原项目资料.pdf 到其他卡片', '解除 原项目资料.pdf']) {
      await expect.soft(board.getByRole('button', { name, exact: true })).toBeDisabled({ timeout: 1000 });
    }
    release();
    await expect(nextTab).toHaveAttribute('aria-selected', 'true');
    await expect(board).toHaveCount(0);
    const previous = await page.request.get(`${workspace.origin}/api/mapping/projects/${first.project.id}`);
    expect((await previous.json()).cards[0].attachments).toEqual(first.cards[0]!.attachments);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

const attachmentOutcomes = {
  confirmed: '写字板添加附件的迟到回执只保存在原项目，当前项目和 URL 保持在目标',
  rejected: '上一项目添加附件被明确拒绝，当前项目显示失败且无需重试',
  lost: '上一项目添加附件丢失回执，重试原请求保留当前项目正文和焦点',
  readback: '原附件确认后的项目重读晚到，不触发目标项目草稿保存',
  readbackFailed: '原附件已确认而项目重读失败，切换项目后仍按已保存处理',
  retryDenied: '上一项目附件首次回执丢失后重试被拒，仍保留原请求等待确认',
  lostBefore: '原项目关联回执先于目标加载丢失，仍能从目标重试且等待期间附件只读',
  readFailedBefore: '原项目关联已确认，重读先于目标加载失败也能结清',
  rejectedRead: '原项目关联先被明确拒绝，重读期间切换后仍显示明确结果',
  assetAfter: '文件原件回执晚于项目切换仍关联原卡',
  assetAfterFailure: '文件原件结果未确认且项目已切换，原卡无新关联并明确提示',
};
for (const [outcome, name] of Object.entries(attachmentOutcomes)) test(name, async ({ page, workspace }) => {
  const lostAck = outcome === 'lost' || outcome === 'retryDenied' || outcome === 'lostBefore';
  const failedSourceRead = outcome === 'readbackFailed' || outcome === 'readFailedBefore';
  const sourceReadback = outcome === 'readback' || failedSourceRead || outcome === 'rejectedRead';
  const rejectedAdd = outcome === 'rejected' || outcome === 'rejectedRead';
  const assetAfter = outcome === 'assetAfter' || outcome === 'assetAfterFailure';
  await place(page, '原项目卡片');
  const { project: source, cards: [card] } = await workspace.state();
  const destinationId = 'attachment-destination';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: destinationId,
    type: 'project.create', expected: null, payload: { name: '目标项目' } });
  if (lostAck || sourceReadback) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: destinationId,
      type: 'thought.create', expected: null, payload: { id: 'destination-card', title: '目标项目卡片', text: '', x: 100, y: 120 } });
  }
  const targetOriginal = 'destination-asset';
  if (outcome === 'lostBefore') {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: destinationId, type: 'asset.save', expected: null,
      payload: { id: targetOriginal, name: '目标原件.pdf', mime: 'application/pdf', kind: 'file', base64: Buffer.from(pdf).toString('base64') } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: destinationId, type: 'card.attachment.add', expected: { attachments: null },
      payload: { id: 'destination-card', name: '目标原件.pdf', assetId: targetOriginal } });
  }
  const readDestination = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${destinationId}`)).json();
  const startingPose = (await readDestination()).cards[0]?.item.pose;
  await page.reload();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', source.id);
  await page.getByRole('button', { name: '原项目卡片', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const destinationTab = page.getByRole('tab', { name: '目标项目', exact: true });

  let releaseAsset!: () => void, releaseDestination!: () => void, releaseAdd!: () => void, releaseSource!: () => void;
  const assetAck = new Promise<void>(resolve => { releaseAsset = resolve; });
  const destinationRead = new Promise<void>(resolve => { releaseDestination = resolve; });
  const addAck = new Promise<void>(resolve => { releaseAdd = resolve; });
  const sourceRead = new Promise<void>(resolve => { releaseSource = resolve; });
  const attempts: { type: string; projectId: string; commandId: string; id: string; assetId?: string }[] = [];
  let destinationRequested = false, destinationBodyWrites = 0, watchSource = false, sourceRequested = false;
  await page.route('**/api/mapping/execute', async route => {
    const { type, projectId, commandId, payload } = route.request().postDataJSON();
    if (type === 'body.edit' && projectId === destinationId) destinationBodyWrites++;
    if (payload?.name !== '在途附件.pdf' || (type !== 'asset.save' && type !== 'card.attachment.add')) return route.continue();
    const firstAdd = type === 'card.attachment.add' && attempts.length === 1;
    if (type === 'card.attachment.add' && outcome === 'retryDenied' && attempts.length === 2) {
      const host = openMapping(workspace.directory);
      const token = host.access.issue('human', [destinationId]);
      try {
        const denied = await route.fetch({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } });
        expect(denied.status()).toBe(403);
        expect((await denied.json()).code).toBe('PROJECT_FORBIDDEN');
        attempts.push({ type, projectId, commandId, id: payload.id, assetId: payload.assetId });
        return await route.fulfill({ response: denied });
      } finally {
        try { host.access.revoke(host.access.authenticate(token).tokenHash); } finally { host.close(); }
      }
    }
    if (firstAdd && rejectedAdd) {
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: source.id,
        type: 'card.attachment.add', expected: { attachments: null },
        payload: { id: card!.id, assetId: payload.assetId, name: '同时关联.pdf' } });
    }
    const response = await route.fetch();
    expect(response.status()).toBe(type === 'card.attachment.add' && rejectedAdd ? 409 : 200);
    attempts.push({ type, projectId, commandId, id: payload.id, assetId: payload.assetId });
    await (type === 'asset.save' ? assetAck : addAck);
    if (firstAdd && lostAck || type === 'asset.save' && outcome === 'assetAfterFailure') return route.abort('failed');
    await route.fulfill({ response });
  });
  await page.route(url => url.pathname === `/api/mapping/projects/${destinationId}/map` && url.searchParams.get('view') === 'index', async route => {
    destinationRequested = true;
    await destinationRead;
    await route.continue();
  });
  await page.route(url => url.pathname === `/api/mapping/projects/${source.id}/map` && url.searchParams.get('view') === 'index', async route => {
    if (watchSource) {
      sourceRequested = true;
      await sourceRead;
      if (failedSourceRead) return route.abort('failed');
    }
    await route.continue();
  });
  try {
    const chooser = page.waitForEvent('filechooser');
    await board.getByRole('button', { name: '添加附件' }).click();
    await (await chooser).setFiles({ name: '在途附件.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
    await expect.poll(() => attempts.map(entry => entry.type)).toEqual(['asset.save']);
    await destinationTab.click();
    await expect.poll(() => destinationRequested).toBe(true);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', source.id);
    if (assetAfter) {
      releaseDestination();
      await expect(destinationTab).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(new RegExp(`[?&]project=${destinationId}$`));
    }
    releaseAsset();
    if (outcome === 'assetAfterFailure') {
      await expect(page.getByRole('alert').filter({ hasText: '上一项目附件未添加' })).toBeVisible({ timeout: 4000 });
      await expect(destinationTab).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(new RegExp(`[?&]project=${destinationId}$`));
      expect((await (await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}`)).json()).cards[0].attachments).toBeUndefined();
      expect(attempts.map(entry => entry.type)).toEqual(['asset.save']);
      expect((await readDestination()).cards).toEqual([]);
      return;
    }
    await expect.poll(() => attempts.map(entry => entry.type), { timeout: 5000 }).toEqual(['asset.save', 'card.attachment.add']);
    expect(attempts.every(entry => entry.projectId === source.id)).toBe(true);
    expect(attempts[1]).toMatchObject({ id: card!.id, assetId: attempts[0]!.id });
    if (sourceReadback) {
      watchSource = true;
      releaseAdd();
      await expect.poll(() => sourceRequested).toBe(true);
    }

    if (outcome === 'lostBefore') {
      releaseAdd();
      await expect(page.getByRole('status')).toHaveText('保存未完成');
    }
    if (outcome === 'readFailedBefore') {
      const readFailed = page.waitForEvent('requestfailed', request =>
        new URL(request.url()).pathname === `/api/mapping/projects/${source.id}/map`);
      releaseSource();
      await readFailed;
      await expect(page.getByRole('status')).toHaveText('附件已保存，列表读取失败', { timeout: 4000 });
    }
    releaseDestination();
    await expect(destinationTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`[?&]project=${destinationId}$`));

    const exportButton = page.getByRole('button', { name: '导出', exact: true });
    const exportSummary = page.getByRole('menuitem', { name: '下载可读摘要（Markdown）' });
    const retry = page.getByRole('button', { name: '重试上一项目保存' });
    await exportButton.click();
    if (outcome === 'readFailedBefore' || outcome === 'rejectedRead') {
      if (outcome === 'rejectedRead') {
        releaseSource();
        await expect(page.getByRole('alert').filter({ hasText: '上一项目附件未添加' })).toBeVisible({ timeout: 4000 });
        await expect(retry).toHaveCount(0);
      } else {
        await expect(page.getByText('上一项目附件已保存', { exact: true })).toBeVisible({ timeout: 4000 });
      }
    } else if (lostAck || sourceReadback) {
      await expect(exportSummary).toBeDisabled();
      if (lostAck) {
        releaseAdd();
        await expect(retry).toBeEnabled();
      }
      await page.getByRole('button', { name: '目标项目卡片', exact: true }).click();
      await page.getByRole('button', { name: '编辑正文', exact: true }).click();
      if (outcome === 'lostBefore') {
        const open = board.getByRole('button', { name: '打开 目标原件.pdf' });
        await expect(open).toBeEnabled();
        const content = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${targetOriginal}/content`));
        const popup = page.waitForEvent('popup');
        await open.click();
        expect((await content).ok()).toBe(true);
        const openedPopup = await popup;
        await openedPopup.waitForURL(url => url.pathname.endsWith(`/${targetOriginal}/content`));
        await openedPopup.close();
        for (const name of ['添加附件', '复制 目标原件.pdf 到其他卡片', '解除 目标原件.pdf']) {
          await expect(board.getByRole('button', { name, exact: true })).toBeDisabled({ timeout: 3000 });
        }
      }
      const editor = board.getByRole('textbox', { name: '卡片正文' });
      await expect(editor).toBeVisible();
      const now = Date.now();
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now + 200);
      await editor.fill('保留目标项目独立草稿');
      const draftStatus = await page.getByRole('status').innerText();
      if (lostAck) {
        if (outcome === 'retryDenied') {
          const denied = page.waitForResponse(response => response.status() === 403 && response.url().endsWith('/execute'));
          await retry.click();
          expect(await (await denied).json()).toMatchObject({ code: 'PROJECT_FORBIDDEN' });
          const notice = page.getByRole('alert').filter({ hasText: '没有此项目的访问授权' });
          await expect(notice).toContainText('上一项目附件保存结果待确认');
          await expect(retry).toBeEnabled();
          expect(attempts[2]).toEqual(attempts[1]);
        }
        await retry.click();
        await expect(page.getByText('上一项目附件已保存', { exact: true })).toBeVisible();
        expect(attempts).toHaveLength(outcome === 'retryDenied' ? 4 : 3);
        expect(attempts.slice(2).every(entry => entry.commandId === attempts[1]!.commandId)).toBe(true);
      } else {
        releaseSource();
        const settled = await Promise.race([
          page.getByText('上一项目附件已保存', { exact: true }).waitFor().then(() => 'source saved'),
          retry.waitFor().then(() => 'source retry shown'),
          page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/execute') &&
            request.postDataJSON()?.type === 'body.edit').then(() => 'destination draft sent'),
        ]);
        expect(settled).toBe('source saved');
        expect(attempts).toHaveLength(2);
      }
      await expect(editor).toBeFocused();
      await expect(editor).toHaveText('保留目标项目独立草稿');
      await expect(page.getByRole('status')).toHaveText(draftStatus);
      expect(destinationBodyWrites).toBe(0);
      if (outcome === 'lostBefore') await expect(board.getByRole('button', { name: '添加附件' })).toBeEnabled();
      await board.getByRole('button', { name: '关闭正文' }).click();
      await expect.poll(() => destinationBodyWrites).toBe(1);
      await page.clock.resume();
      await exportButton.click();
    } else {
      await expect(exportSummary).toBeDisabled();
      const addResponse = page.waitForResponse(response => response.url().endsWith('/execute') &&
        response.request().postDataJSON()?.type === 'card.attachment.add');
      releaseAdd();
      expect((await addResponse).status()).toBe(outcome === 'rejected' ? 409 : 200);
      if (rejectedAdd) {
        await expect(page.getByRole('alert').filter({ hasText: '上一项目附件未添加' })).toBeVisible();
      } else {
        await expect(page.getByText('上一项目附件已保存', { exact: true })).toBeVisible();
      }
      expect(attempts).toHaveLength(2);
    }
    await expect(retry).toHaveCount(0);
    await expect(exportSummary).toBeEnabled();
    await expect(destinationTab).toHaveAttribute('aria-selected', 'true', { timeout: 3500 });
    await expect(page).toHaveURL(new RegExp(`[?&]project=${destinationId}$`));
    await expect(page.getByRole('button', { name: '打开 在途附件.pdf' })).toHaveCount(0);
    const previous = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}`)).json();
    expect(previous.cards[0].attachments.items).toEqual([{ id: expect.any(String),
      name: rejectedAdd ? '同时关联.pdf' : '在途附件.pdf', assetId: attempts[0]!.id }]);
    const destination = await readDestination();
    if (startingPose) expect(destination.cards[0].item.pose).toMatchObject({ x: startingPose.x, y: startingPose.y });
    expect(destination.cards.flatMap((value: { attachments?: { items: { assetId: string }[] } }) =>
      value.attachments?.items.map(item => item.assetId) ?? [])).toEqual(outcome === 'lostBefore' ? [targetOriginal] : []);
    const original = await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}/assets/${attempts[0]!.id}/content`);
    expect(await original.body()).toEqual(Buffer.from(pdf));
    expect((await page.request.get(`${workspace.origin}/api/mapping/projects/${destinationId}/assets/${attempts[0]!.id}/content`)).status()).toBe(404);
  } finally {
    releaseAsset();
    releaseDestination();
    releaseAdd();
    releaseSource();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('项目切换等待原卡正文保存时，旧写字板附件仍可读并拦住解除', async ({ page, workspace }) => {
  await dropFiles(page, [{ name: '保护.pdf', type: 'application/pdf', text: pdf }]);
  await expect(page.getByRole('button', { name: '打开 保护.pdf' })).toBeVisible();
  const { project: source, cards: [card] } = await workspace.state();
  const targetId = 'preflush-destination';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: targetId, type: 'project.create', expected: null,
    payload: { name: '切到目标' } });
  await page.reload();
  await page.getByRole('button', { name: '保护', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const editor = board.getByRole('textbox', { name: '卡片正文' });
  let release!: () => void;
  const holdBody = new Promise<void>(resolve => { release = resolve; });
  let bodySent = false, detachSent = false;
  await page.route('**/api/mapping/execute', async route => {
    const { type, projectId } = route.request().postDataJSON();
    if (projectId === source.id && type === 'body.edit') {
      bodySent = true;
      await holdBody;
    }
    if (projectId === source.id && type === 'card.attachment.remove') detachSent = true;
    await route.continue();
  });
  try {
    const now = Date.now();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now + 200);
    await editor.fill('切换前先保存原正文');
    expect(bodySent).toBe(false);
    const nextTab = page.getByRole('tab', { name: '切到目标', exact: true });
    await nextTab.click();
    await expect.poll(() => bodySent).toBe(true);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', source.id);
    await expect(board.getByRole('button', { name: '打开 保护.pdf' })).toBeEnabled();
    const detach = board.getByRole('button', { name: '解除 保护.pdf' });
    await expect.soft(detach).toBeDisabled({ timeout: 3000 });
    await detach.evaluate(button => button.click());
    release();
    await expect(nextTab).toHaveAttribute('aria-selected', 'true');
    await page.clock.resume();
    const previous = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}`)).json();
    expect(detachSent).toBe(false);
    expect(previous.cards[0].attachments).toEqual(card!.attachments);
    expect(previous.cards[0].body.blocks[0].text).toBe('切换前先保存原正文');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('上传晚到遇到新项目待确认动作，原卡提示重做且重做成功后不再提示失败', async ({ page, workspace }) => {
  await place(page, '恢复原卡');
  const { project: source, cards: [card] } = await workspace.state();
  const targetId = 'pending-destination';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: targetId,
    type: 'project.create', expected: null, payload: { name: '独立项目' } });
  await page.reload();
  const sourceTab = page.locator(`[role="tab"][title="${source.id}"]`);
  const targetTab = page.getByRole('tab', { name: '独立项目', exact: true });
  const board = page.getByRole('complementary', { name: '写字板' });
  await page.getByRole('button', { name: '恢复原卡', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  let releaseUpload!: () => void, releaseThought!: () => void;
  const holdUpload = new Promise<void>(resolve => { releaseUpload = resolve; });
  const holdThought = new Promise<void>(resolve => { releaseThought = resolve; });
  let uploadedAsset: string | undefined, thoughtSubmitted = false;
  const associations: string[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const { type, projectId, payload } = route.request().postDataJSON();
    if (type === 'asset.save' && projectId === source.id && !uploadedAsset) {
      const upload = await route.fetch();
      expect(upload.ok()).toBe(true);
      uploadedAsset = payload.id;
      await holdUpload;
      return route.fulfill({ response: upload });
    }
    if (type === 'thought.create' && projectId === targetId) {
      const creation = await route.fetch();
      expect(creation.ok()).toBe(true);
      thoughtSubmitted = true;
      await holdThought;
      return route.fulfill({ response: creation });
    }
    if (type === 'card.attachment.add') associations.push(projectId);
    await route.continue();
  });
  const pick = async () => {
    const chooser = page.waitForEvent('filechooser');
    await board.getByRole('button', { name: '添加附件' }).click();
    await (await chooser).setFiles({ name: '重做资料.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  };
  try {
    await pick();
    await expect.poll(() => uploadedAsset).toBeTruthy();
    await targetTab.click();
    await expect(targetTab).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '卡片', exact: true }).click();
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 120 } });
    await expect.poll(() => thoughtSubmitted).toBe(true);
    releaseUpload();
    const failure = page.getByRole('alert').filter({ hasText: '上一项目附件未添加' });
    await expect(failure).toContainText('再回原卡重新添加附件');
    expect(associations).toEqual([]);
    await expect(targetTab).toHaveAttribute('aria-selected', 'true');
    releaseThought();
    const title = page.getByLabel('卡片标题', { exact: true });
    await title.fill('独立项目待确认卡');
    await title.press('Enter');
    await expect(page.getByRole('button', { name: '独立项目待确认卡', exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await sourceTab.click();
    await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '恢复原卡', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    await pick();
    await expect(board.getByRole('button', { name: '打开 重做资料.pdf' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await targetTab.click();
    await expect(targetTab).toHaveAttribute('aria-selected', 'true');
    await expect(failure).toHaveCount(0);
    expect(associations).toEqual([source.id]);
    const sourceRead = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}`)).json();
    expect(sourceRead.cards[0].id).toBe(card!.id);
    expect(sourceRead.cards[0].attachments.items.map((item: { name: string }) => item.name)).toEqual(['重做资料.pdf']);
    const original = await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}/assets/${uploadedAsset}/content`);
    expect(await original.body()).toEqual(Buffer.from(pdf));
    const destination = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}`)).json();
    expect(destination.cards).toHaveLength(1);
    expect(destination.cards[0]).toMatchObject({ title: '独立项目待确认卡' });
    expect(destination.cards[0].attachments).toBeUndefined();
  } finally {
    releaseUpload();
    releaseThought();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const [read, next] of [['map', 'reread'], ['history', 'reread'], ['map', 'write'], ['map', 'switch']] as const) test(
  `附件已保存但当前项目 ${read} 读取失败，${next === 'write' ? '先继续写正文后仍可重读' : next === 'switch' ? '阻止切换时不新增保存错误' : '可只重读列表'}`,
  async ({ page, workspace }) => {
  await place(page, '当前卡片');
  const { project } = await workspace.state();
  if (next === 'switch') {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: 'reread-destination',
      type: 'project.create', expected: null, payload: { name: '等待读取的目标项目' } });
    await page.reload();
    await page.getByRole('button', { name: '当前卡片', exact: true }).click();
  }
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  let sends = 0, failedReads = 0, failRead = true;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'card.attachment.add') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    sends++;
    await route.fulfill({ response });
  });
  await page.route(url => url.pathname === `/api/mapping/projects/${project.id}/${read}` &&
    (read === 'history' || url.searchParams.get('view') === 'index'), async route => {
    if (sends && failRead) {
      failedReads++;
      return route.abort('failed');
    }
    await route.continue();
  });
  try {
    const chooser = page.waitForEvent('filechooser');
    await board.getByRole('button', { name: '添加附件' }).click();
    await (await chooser).setFiles({ name: '重读.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    await expect(page.getByRole('status')).toHaveText('附件已保存，列表读取失败', { timeout: 5000 });
    const reopen = board.getByRole('button', { name: '打开 重读.pdf' });
    await expect(reopen).toHaveCount(0);
    const reread = page.getByRole('button', { name: '重新读取附件' });
    await expect(reread).toBeEnabled();
    expect((await workspace.state()).cards[0]!.attachments?.items).toHaveLength(1);
    failRead = false;
    if (next === 'write') {
      const bodySaved = page.waitForResponse(response => response.url().endsWith('/execute') &&
        response.request().postDataJSON()?.type === 'body.edit' && response.ok());
      await board.getByRole('textbox', { name: '卡片正文' }).fill('继续保存新的正文');
      await bodySaved;
      await expect(page.getByRole('status')).toHaveText('已保存到本机');
      expect((await workspace.state()).cards[0]!.body.blocks[0]!.text).toBe('继续保存新的正文');
      await expect(reread).toBeEnabled({ timeout: 5000 });
    }
    if (next === 'switch') {
      const target = page.getByRole('tab', { name: '等待读取的目标项目', exact: true });
      await target.click();
      await expect(target).toHaveAttribute('aria-selected', 'false');
      await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', project.id);
      await expect(page.getByRole('status')).toHaveText('附件已保存，列表读取失败', { timeout: 4000 });
    }
    await reread.click();
    await expect(reopen).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(reread).toHaveCount(0);
    if (next === 'switch') {
      await page.getByRole('button', { name: '导出', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: '下载可读摘要（Markdown）' })).toBeEnabled();
    }
    expect(sends).toBe(1);
  } finally {
    failRead = false;
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('新项目复制等待前置正文保存时，迟到上传不抢占保存且原件可恢复', async ({ page, workspace }) => {
  await place(page, '待上传原卡');
  const { project: source, cards: [sourceCard] } = await workspace.state();
  const targetId = 'preparing-destination';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: targetId,
    type: 'project.create', expected: null, payload: { name: '等正文的项目' } });
  for (const [id, title, x] of [['b1', '项目内来源卡', 90], ['b2', '项目内目标卡', 450]] as const) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: targetId,
      type: 'thought.create', expected: null, payload: { id, title, text: '', x, y: 110 } });
  }
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: targetId, type: 'asset.save', expected: null,
    payload: { id: 'b-file', name: '乙原件.pdf', mime: 'application/pdf', kind: 'file', base64: Buffer.from(pdf).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: targetId, type: 'card.attachment.add', expected: { attachments: null },
    payload: { id: 'b1', name: '乙原件.pdf', assetId: 'b-file' } });
  await page.reload();

  let releaseUpload!: () => void, releaseDraft!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  const draftGate = new Promise<void>(resolve => { releaseDraft = resolve; });
  let originalAssetId: string | undefined, draftSends = 0, oldAdds = 0, copies = 0;
  await page.route('**/api/mapping/execute', async route => {
    const { type, projectId, payload } = route.request().postDataJSON();
    if (type === 'asset.save' && projectId === source.id) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      originalAssetId = payload.id;
      await uploadGate;
      return route.fulfill({ response });
    }
    if (type === 'body.edit' && projectId === targetId) {
      draftSends++;
      await draftGate;
    }
    if (type === 'card.attachment.add') {
      if (projectId === source.id) oldAdds++;
      if (projectId === targetId) copies++;
    }
    await route.continue();
  });
  const board = page.getByRole('complementary', { name: '写字板' });
  try {
    await page.getByRole('button', { name: '待上传原卡', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await board.getByRole('button', { name: '添加附件' }).click();
    await (await chooser).setFiles({ name: '原项目文件.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
    await expect.poll(() => originalAssetId).toBeTruthy();
    const nextTab = page.getByRole('tab', { name: '等正文的项目', exact: true });
    await nextTab.click();
    await expect(nextTab).toHaveAttribute('aria-selected', 'true');
    const sourceNode = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '项目内来源卡', exact: true }) });
    await sourceNode.locator('.title-button').click();
    await sourceNode.getByRole('button', { name: '编辑正文' }).click();
    const now = Date.now();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now + 200);
    await board.getByRole('textbox', { name: '卡片正文' }).fill('保留乙卡正文');
    expect(draftSends).toBe(0);
    const copy = board.getByRole('button', { name: '复制 乙原件.pdf 到其他卡片' });
    await copy.click();
    const dialog = page.getByRole('dialog', { name: '复制附件到卡片' });
    await dialog.getByRole('combobox').selectOption({ label: '项目内目标卡' });
    await dialog.getByRole('button', { name: '复制', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => draftSends).toBe(1);
    expect(copies).toBe(0);
    const oldAdd = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/execute') &&
      request.postDataJSON()?.type === 'card.attachment.add' && request.postDataJSON()?.projectId === source.id);
    releaseUpload();
    const notice = page.getByRole('alert').filter({ hasText: '再回原卡重新添加附件' });
    const result = await Promise.race([notice.waitFor().then(() => '有明确提示'), oldAdd.then(() => '抢发了旧项目关联')]);
    expect(result).toBe('有明确提示');
    releaseDraft();
    await expect.poll(() => copies).toBe(1);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(copy).toBeFocused();
    await page.clock.resume();
    const destination = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${targetId}`)).json();
    expect(destination.cards.find((card: { id: string }) => card.id === 'b1').body.blocks[0].text).toBe('保留乙卡正文');
    expect(destination.cards.find((card: { id: string }) => card.id === 'b2').attachments.items[0].assetId).toBe('b-file');
    expect(draftSends).toBe(1);
    expect(oldAdds).toBe(0);
    expect(copies).toBe(1);
    const previous = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}`)).json();
    expect(previous.cards[0]).toMatchObject({ id: sourceCard!.id });
    expect(previous.cards[0].attachments).toBeUndefined();
    const savedFile = await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}/assets/${originalAssetId}/content`);
    expect(await savedFile.body()).toEqual(Buffer.from(pdf));
  } finally {
    releaseUpload();
    releaseDraft();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
