import { test, expect } from './writing-board-fixture';
import { twoFrameGif } from './image-reading-fixtures';

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

for (const activation of ['Space', 'Enter']) {
  test(`未成组GIF拖后以Tab定位并用${activation}激活内联控件，不产生额外写入`, async ({ page, workspace }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const projectId = (await workspace.state()).project.id;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
      payload: { id: 'keyboard-gif-asset', name: '键盘动图.gif', mime: 'image/gif', base64: twoFrameGif().toString('base64') } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
      payload: { id: 'keyboard-gif', content: { assetId: 'keyboard-gif-asset', crop: { x: 0, y: 0, width: 1, height: 1 } },
        pose: { x: 300, y: 180, width: 160, height: 120, rotation: 0 } } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const visual = page.getByRole('img', { name: '键盘动图.gif', exact: true }); await visual.click();
    const before = await workspace.state(); expect(before.groups).toEqual([]);
    expect(before.images![0]!.item.pose).toEqual({ x: 300, y: 180, width: 160, height: 120, rotation: 0 });
    const node = page.locator('.react-flow__node[data-id="' + before.images![0]!.item.id + '"]'); await expect(node).toHaveClass(/selected/);
    const play = node.getByRole('button', { name: '播放动图', exact: true }), pause = node.getByRole('button', { name: '暂停动图', exact: true });
    await expect(play).toBeEnabled();
    const writes: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
    const box = (await visual.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 80, y + 50, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual({ x: 380, y: 230, width: 160, height: 120, rotation: 0 });
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); const saved = await workspace.state();
    expect(writes).toHaveLength(1); expect(writes[0].type).toBe('canvas.move');
    for (let tab = 0; tab < 40 && !(await play.evaluate(el => el === document.activeElement)); tab++) await page.keyboard.press('Tab');
    await expect(play).toBeFocused(); await page.keyboard.press(activation);
    await expect(pause).toBeFocused(); await page.keyboard.press(activation); await expect(play).toBeFocused();
    expect(await workspace.state()).toEqual(saved); expect(writes).toHaveLength(1);
  });
}

for (const cancelled of [false, true]) {
  test(`Group${cancelled ? '取消' : '保存'}拖动的自然尾click保整组选中，后续独立click可选成员`, async ({ page, workspace }) => {
    const projectId = (await workspace.state()).project.id;
    for (const [id, shortText, x, y] of [['tail-a', '尾击甲', 100, 160], ['tail-b', '尾击乙', 420, 200]] as const) {
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
        payload: { id, content: { shapeType: 'rectangle', shortText }, pose: { x, y, width: 180, height: 100 } } });
    }
    const initial = await workspace.state(), itemIds = initial.shapes!.map(value => value.item.id);
    expect(initial.shapes!.map(value => [value.id, value.item.pose.x, value.item.pose.y])).toEqual([['tail-a', 100, 160], ['tail-b', 420, 200]]);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
      expected: { groups: { 'tail-group': null }, containment: Object.fromEntries(itemIds.map(id => [id, null])) }, payload: { id: 'tail-group', itemIds } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const a = page.getByRole('img', { name: '尾击甲', exact: true }), b = page.getByRole('img', { name: '尾击乙', exact: true });
    await b.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
    const before = await workspace.state(); expect(before.groups![0]!.memberItemIds).toEqual(itemIds);
    const writes: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
    const box = (await b.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    const nodeA = page.locator('.react-flow__node[data-id="' + itemIds[0] + '"]'), nodeB = page.locator('.react-flow__node[data-id="' + itemIds[1] + '"]');
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 80, y + 50, { steps: 5 });
    await expect.poll(() => nodeA.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBe(180);
    if (cancelled) {
      await page.keyboard.press('Escape');
      await expect.poll(() => nodeA.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBe(100);
      await expect.poll(() => nodeB.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBe(420);
      await page.mouse.move(x + 100, y + 65);
    }
    await page.mouse.up();
    if (cancelled) { expect(await workspace.state()).toEqual(before); expect(writes).toEqual([]); }
    else {
      await expect.poll(async () => (await workspace.state()).shapes!.map(value => [value.item.pose.x, value.item.pose.y])).toEqual([[180, 210], [500, 250]]);
      await expect(page.getByRole('status')).toHaveText('已保存到本机');
      expect(writes).toHaveLength(1); expect(writes[0].type).toBe('canvas.move-selection');
    }
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
    const saved = await workspace.state();
    await b.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1); await expect(nodeB).toHaveClass(/selected/);
    await a.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1); await expect(nodeA).toHaveClass(/selected/);
    expect(await workspace.state()).toEqual(saved); expect(writes).toHaveLength(cancelled ? 0 : 1);
  });
}
