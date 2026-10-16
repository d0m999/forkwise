import { test, expect, place } from './writing-board-fixture';

test('合成composition和229键不重排标签，指针拖序的Esc取消也不产生写入', async ({ page, workspace }) => {
  await place(page, '输入边界'); const initial = await workspace.state(), projectId = initial.project.id, id = initial.cards[0]!.id;
  for (const tag of ['Alpha', 'Beta']) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'tag.create', expected: null, payload: { id: tag, name: tag } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'card.tags', expected: null, payload: { id, tagIds: ['Alpha', 'Beta'] } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.heightPolicy!.necessaryHeight).toBeGreaterThan(initial.cards[0]!.item.heightPolicy?.necessaryHeight ?? 0);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板', exact: true }), first = board.getByRole('button', { name: '拖动标签：Alpha', exact: true }), second = board.getByRole('button', { name: '拖动标签：Beta', exact: true });
  const writes: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'card.tags') writes.push(request.postDataJSON().commandId); });
  const before = await workspace.state();
  for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
    await first.dispatchEvent('keydown', { key: 'ArrowRight', ...properties });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(writes).toEqual([]); expect(await workspace.state()).toEqual(before);
  }
  await board.getByRole('textbox', { name: '卡片正文', exact: true }).focus();
  const a = (await first.boundingBox())!, b = (await second.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 }); await page.keyboard.press('Escape'); await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(writes).toEqual([]); expect(await workspace.state()).toEqual(before);
  await board.getByRole('button', { name: '管理标签', exact: true }).click();
  const remove = board.getByRole('button', { name: '删除项目标签：Alpha', exact: true }); await remove.click();
  const confirmation = board.getByRole('alertdialog', { name: '删除项目标签', exact: true }); await expect(confirmation).toBeVisible();
  const cancel = confirmation.getByRole('button', { name: '取消删除标签', exact: true });
  for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
    await cancel.dispatchEvent('keydown', { key: 'Escape', ...properties });
    await expect(confirmation).toBeVisible(); expect(await workspace.state()).toEqual(before);
  }
  await cancel.press('Escape'); await expect(confirmation).not.toBeVisible(); await expect(remove).toBeFocused();
});
