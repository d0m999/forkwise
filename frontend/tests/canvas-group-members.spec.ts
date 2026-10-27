import { test, expect } from './writing-board-fixture';

test('未成组单Text拖动Esc取消完整预览并消费尾随输入，下一手势仍可保存', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'text-cancel', content: { runs: [{ text: '取消独立文字' }], fontSize: 18, lineHeight: 1.5,
      align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 300, y: 180, width: 180, height: 27 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const visual = page.getByText('取消独立文字', { exact: true }); await visual.click();
  const before = await workspace.state();
  expect(before.texts).toHaveLength(1); expect(before.groups).toEqual([]);
  expect(before.texts![0]!.item.pose).toEqual({ x: 300, y: 180, width: 180, height: 27 });
  const writes: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
  const box = (await visual.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  const node = page.locator('.react-flow__node[data-id="' + before.texts![0]!.item.id + '"]');
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 80, y + 50, { steps: 5 });
  await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBe(380);
  expect(await workspace.state()).toEqual(before);
  await page.keyboard.press('Escape');
  await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBe(300);
  await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).f)).toBe(180);
  await expect(node).toHaveClass(/selected/);
  await page.mouse.move(x + 100, y + 65); await page.mouse.up();
  expect(await workspace.state()).toEqual(before); expect(writes).toEqual([]);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 20, { steps: 2 }); await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).texts![0]!.item.pose).toEqual({ x: 340, y: 200, width: 180, height: 27 });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ type: 'text.move' });
});
