import { test, expect, place } from './writing-board-fixture';

test('未知块与已有媒体显示只读原件，标题/Pose及删卡撤销不损失完整Body', async ({ page, workspace }) => {
  await place(page, '原件卡', 80, 120);
  const initial = await workspace.state(), card = initial.cards[0]!;
  const blocks = [{ ...card.body.blocks[0]!, text: '完整旧段落\n软换行' }, { id: 'legacy-opaque', type: 'opaque', original: { source: 'legacy', text: '完整未知原件🚀', script: '<script>throw new Error("must stay data")</script>' } }, { id: 'legacy-media', type: 'image', assetId: 'existing-media', caption: '保留媒体原始引用', metadata: { keep: [1, 2, null] } }];
  await workspace.installOriginalBody(card.id, blocks);
  await workspace.open(page);
  await page.getByRole('button', { name: '原件卡', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const original = page.getByLabel('只读正文原件');
  await expect(original).toContainText('完整旧段落');
  await expect(original).toContainText('完整未知原件🚀');
  await expect(original).toContainText('existing-media');
  await expect(page.getByRole('textbox', { name: '卡片正文', exact: true })).toHaveCount(0);
  await page.keyboard.press('Backspace');
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(initial.project.id, card.id, snapshot!);
  expect(agent.body.blocks).toEqual(blocks);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '删除卡片', exact: true }).click();
  await expect(page.getByLabel('已删除卡片')).toBeVisible();
  await expect(original).toContainText('完整未知原件🚀');
  await page.getByRole('button', { name: '撤销删除', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  await workspace.restart(); await workspace.open(page);
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
});

test('自动窄窗与主动展开分别恢复，项目宽度记忆、最大/最小值与390px控件可达', async ({ page, workspace }, info) => {
  await place(page, '宽窄可达', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.locator('.body-editor'), handle = page.getByRole('separator', { name: '调整写字板宽度' });
  await handle.focus();
  for (let i = 0; i < 20; i++) await handle.press('ArrowLeft');
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(800);
  await page.setViewportSize({ width: 960, height: 700 });
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(480);
  await page.setViewportSize({ width: 390, height: 700 });
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(390);
  await expect(page.getByRole('button', { name: '返回画布' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '关闭正文' })).toBeInViewport();
  await expect(page.locator('.card-actions')).toBeHidden();
  await page.screenshot({ path: info.outputPath('board-390.png') });
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(800);
  for (let i = 0; i < 25; i++) await handle.press('ArrowRight');
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(360);
  await page.getByRole('button', { name: '关闭正文' }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(360);
  await page.screenshot({ path: info.outputPath('board-wide.png') });
  expect((await workspace.state()).cards).toHaveLength(1);
});


test('长标题在窄且短的窗口仍保留完整身份，正文与返回按钮可达', async ({ page, workspace }, info) => {
  await place(page, '长标题原卡', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const state = await workspace.state(), card = state.cards[0]!;
  const title = '保留完整标题且不挤走正文'.repeat(300);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'thought.title', expected: card.versionId, payload: { id: card.id, title } });
  await expect(page.locator('.body-editor h2')).toHaveText('正在编辑：' + title);
  await page.setViewportSize({ width: 390, height: 500 });
  await expect(page.getByRole('textbox', { name: '卡片正文', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '返回画布', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '关闭正文', exact: true })).toBeInViewport();
  await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('窄且短窗口仍可实际编辑');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).cards[0]!.title).toBe(title);
  expect((await workspace.state()).cards[0]!.body.blocks[0]!.text).toBe('窄且短窗口仍可实际编辑');
  await page.screenshot({ path: info.outputPath('board-long-title-390x500.png') });
});
