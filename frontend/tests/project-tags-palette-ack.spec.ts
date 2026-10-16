import { test, expect, place } from './writing-board-fixture';

test('选色ACK在途时Esc仍关闭色板并还焦点，不冒泡改变画布选择', async ({ page, workspace }) => {
  await place(page, '焦点卡片'); const initial = await workspace.state();
  const projectId = initial.project.id, id = initial.cards[0]!.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'tag.create', expected: null, payload: { id: 'ai', name: 'AI' } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'card.tags', expected: null, payload: { id, tagIds: ['ai'] } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  await board.getByRole('button', { name: '管理标签', exact: true }).click();
  const trigger = board.getByRole('button', { name: 'AI颜色：默认', exact: true }); await trigger.click();
  const palette = board.getByRole('group', { name: 'AI标签颜色', exact: true });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), arrived = new Promise<void>(resolve => entered = resolve);
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'tag.update') return route.continue();
    const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
  });
  try {
    await palette.getByRole('button', { name: '蓝色', exact: true }).click(); await arrived;
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible(); await expect(trigger).toBeFocused();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  } finally { release(); }
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(board.getByRole('button', { name: 'AI颜色：蓝色', exact: true })).toBeFocused();
  expect((await workspace.state()).tags![0]!.color).toBe('#d9e7f1');
});
