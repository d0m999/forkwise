import { expect, place, test } from './writing-board-fixture';

test('AI 整理从卡片菜单选择范围，审阅后添加并在重开保留归属', async ({ page, workspace }, info) => {
  await place(page, '供应链观察');
  const source = (await workspace.state()).cards[0]!;
  const trigger = page.getByRole('button', { name: 'AI', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '用本机模型整理' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '试用模拟整理' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('checkbox', { name: /卡片标题/ })).toBeFocused();
  await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: '试用模拟整理' }).click();
  await expect(dialog.getByRole('heading', { name: '模拟整理：供应链观察' })).toBeVisible();
  expect((await workspace.state()).cards).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('organize-review.png') });
  await dialog.getByRole('button', { name: '添加为新卡' }).click();
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
  const saved = await workspace.state();
  expect(saved.cards).toHaveLength(2);
  expect(saved.cards[0]!.body).toEqual(source.body);
  expect(saved.cards[1]).toMatchObject({ aiOrigin: { mode: 'simulate', taskId: expect.any(String) } });
  await expect(page.locator('.card-ai-origin')).toHaveText('模拟整理');
  await page.goto('about:blank');
  await workspace.restart();
  await workspace.open(page);
  await expect(page.locator('.card-ai-origin')).toHaveText('模拟整理');
  await expect(page.getByRole('button', { name: '模拟整理：供应链观察', exact: true })).toBeVisible();
  expect((await workspace.state()).cards[1]!.aiOrigin).toEqual(saved.cards[1]!.aiOrigin);
  await page.getByRole('button', { name: '模拟整理：供应链观察', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(3);
  const copy = (await workspace.state()).cards.find(card => !saved.cards.some(item => item.id === card.id));
  expect(copy?.aiOrigin).toEqual({ mode: 'simulate' });
  workspace.removeCard(source.id);
  await expect(page.getByRole('button', { name: '供应链观察', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '项目导航' }).click();
  await page.getByRole('button', { name: 'AI 整理记录', exact: true }).click();
  const records = page.getByRole('dialog', { name: 'AI 整理记录' });
  await expect(records.getByText('原卡已删除，仍可查看旧结果。')).toBeVisible();
  await expect(records.getByRole('heading', { name: '模拟整理：供应链观察' })).toBeVisible();
  await expect(records.getByRole('button', { name: '添加为新卡' })).toHaveCount(0);
});

test('无标题卡可整理所选列表和引用，保留未选正文', async ({ page, workspace }) => {
  await place(page, '');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '交期延长\n等待公司确认\n内部备注');
    clipboardData.setData('text/html', '<ul><li><strong>交期延长</strong></li></ul><blockquote>等待公司确认</blockquote><h2>内部备注</h2>');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks
    .map(({ type, text }) => [type, text])).toEqual([
    ['listItem', '交期延长'], ['quote', '等待公司确认'], ['heading', '内部备注'],
  ]);
  const { project, cards: [source] } = await workspace.state();
  expect(source!.title).toBe('');
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await page.getByRole('button', { name: '未命名卡片', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await expect(dialog.getByRole('checkbox', { name: /卡片标题/ })).toHaveCount(0);
  const simulate = dialog.getByRole('button', { name: '试用模拟整理' });
  await expect(simulate).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '列表项 1' }).check();
  await dialog.getByRole('checkbox', { name: '引用 2' }).check();
  await expect(dialog.getByRole('checkbox', { name: '正文标题 3' })).not.toBeChecked();
  const started = page.waitForResponse(response =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/mapping/projects/${project.id}/organize/tasks`);
  await simulate.click();
  const response = await started;
  expect(response.status()).toBe(201);
  expect((await response.json()).input).toEqual({
    cardId: source!.id, thoughtVersionId: source!.versionId, bodyVersionId: source!.body.versionId,
    title: null, omittedBlockCount: 1,
    blocks: [
      { id: source!.body.blocks[0]!.id, text: '交期延长' },
      { id: source!.body.blocks[1]!.id, text: '等待公司确认' },
    ],
  });
  await expect(dialog.getByRole('status')).toHaveText('模拟整理 可以审阅');
  await expect(dialog.getByRole('article')).toContainText('交期延长');
  await expect(dialog.getByRole('article')).toContainText('等待公司确认');
  await expect(dialog.getByRole('article')).not.toContainText('内部备注');
  expect((await workspace.state()).cards.map(card => card.body)).toEqual([source!.body]);

  const add = dialog.getByRole('button', { name: '添加为新卡' });
  await add.click();
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  const firstCandidate = (await workspace.state()).cards.find(card => card.id !== source!.id)!;
  await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  const historyUrl = `${workspace.origin}/api/mapping/projects/${project.id}/history`;
  const beforeMove = await page.request.get(historyUrl);
  expect(await beforeMove.json()).toMatchObject({ redo: [expect.objectContaining({ label: 'organize.add' })] });
  await workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: project.id, type: 'pose.move', expected: source!.item.versionId,
    payload: { id: source!.id, x: source!.item.pose.x + 32, y: source!.item.pose.y },
  });
  const afterMove = await page.request.get(historyUrl);
  expect(await afterMove.json()).toMatchObject({ redo: [] });
  await page.getByRole('button', { name: '未命名卡片', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await add.click();
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  const nextCandidate = (await workspace.state()).cards.find(card => card.id !== source!.id)!;
  expect(nextCandidate.id).not.toBe(firstCandidate.id);
  expect(nextCandidate.aiOrigin).toEqual(firstCandidate.aiOrigin);
});
