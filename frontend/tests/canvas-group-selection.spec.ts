import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

for (const kind of ['card', 'text', 'shape', 'image', 'stroke'] as const) {
  test(`${kind}成员尚未完成第二click时直接起拖仍整组原子移动`, async ({ page, workspace }) => {
    const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
    await visuals[kind].click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    const commands: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
    const box = (await visuals[kind].boundingBox())!, start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + 30, { steps: 4 });
    for (const value of Object.values(items)) {
      const node = page.locator('.react-flow__node[data-id="' + value.item.id + '"]');
      await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBeCloseTo(value.item.pose.x + 40, 4);
      await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).f)).toBeCloseTo(value.item.pose.y + 30, 4);
    }
    expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    await page.mouse.up();
    await expect.poll(async () => (await workspace.state()).strokes![0]!.item.pose.x).toBe(480);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state();
    for (const [domain, origin] of [['cards', before.cards[0]!], ['texts', before.texts![0]!], ['shapes', before.shapes![0]!], ['images', before.images![0]!], ['strokes', before.strokes![0]!]] as const) {
      const value = after[domain]![0]!;
      expect(value).toEqual({ ...origin, item: { ...origin.item, versionId: value.item.versionId,
        pose: { ...origin.item.pose, x: origin.item.pose.x + 40, y: origin.item.pose.y + 30 } } });
    }
    expect(after.containment).toEqual(before.containment); expect(after.project.revision).toBe(before.project.revision + 1);
    expect(after.groups!.map(({ bounds, ...group }) => group)).toEqual(before.groups!.map(({ bounds, ...group }) => group));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'canvas.move-selection', payload: { groupIds: ['selection-group'], directItemIds: [], dx: 40, dy: 30 } });
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json()).undo).toHaveLength(timeline.undo.length + 1);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  });
}

test('正文保存响应等待中的旧Stroke选择不得覆盖随后Shape选择和焦点', async ({ page, workspace }) => {
  const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await expect(editor).toHaveText('组合正文保持');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let committed = false, responseDelivered = false;
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'body.edit') responseDelivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'body.edit') { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200); committed = true;
    await gate; await route.fulfill({ response });
  });
  try {
    await editor.click(); await editor.press('End'); await page.keyboard.insertText('短');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
    expect(responseDelivered).toBe(false);
    await visuals.stroke.click();
    await expect.poll(() => committed).toBe(true);
    expect(responseDelivered).toBe(false);
    const pending = await workspace.state();
    expect(pending.cards[0]!.body.blocks.map(block => block.text)).toEqual(['组合正文保持短']);
    // The Stroke choice has reached its original flush but cannot finish before this ACK.
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
    expect(responseDelivered).toBe(false);
    await visuals.shape.click();
    const shape = page.locator('.react-flow__node[data-id="' + items.shape.item.id + '"]');
    await expect(shape).toHaveClass(/selected/); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(visuals.shape).toBeFocused();
    release(); await expect.poll(() => responseDelivered).toBe(true);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(shape).toHaveClass(/selected/); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(visuals.shape).toBeFocused();
    const after = await workspace.state();
    expect(after).toEqual(pending); expect(after.project.revision).toBe(before.project.revision + 1);
    expect(after.groups).toEqual(before.groups); expect(after.containment).toEqual(before.containment);
    expect(after.strokes).toEqual(before.strokes); expect(after.shapes).toEqual(before.shapes);
    expect(commands.map(command => command.type)).toEqual(['body.edit']);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json()).undo).toHaveLength(timeline.undo.length + 1);
  } finally {
    release(); await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const kind of ['card', 'text', 'shape', 'image', 'stroke'] as const) {
  test(`${kind}首击整组与第二完成click直选，Shift追加和成员切换不写`, async ({ page, workspace }) => {
    const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
    const commands: unknown[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
    const outline = page.getByRole('group', { name: '组合', exact: true });
    await visuals[kind].click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    await expect(outline).toHaveAttribute('data-selected', 'true');
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
    await visuals[kind].click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + items[kind].item.id + '"]')).toHaveClass(/selected/);
    await expect(visuals[kind]).toBeFocused(); await expect(outline).toHaveAttribute('data-selected', 'false');
    const other = kind === 'shape' ? 'text' : 'shape';
    await visuals[other].click({ modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    for (const id of [items[kind].item.id, items[other].item.id]) await expect(page.locator('.react-flow__node[data-id="' + id + '"]')).toHaveClass(/selected/);
    await visuals[other].click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + items[other].item.id + '"]')).toHaveClass(/selected/);
    expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json()).toEqual(timeline);
  });
}
