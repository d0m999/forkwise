import { test, expect, place } from './writing-board-fixture';
import { croppedCanvasImage } from './canvas-image-reading-fixture';

test('独立图八个手柄四角等比四边自由，布局保留并一次撤销重做', async ({ page, workspace }) => {
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '几何.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="green"/></svg>') });
  const image = page.getByRole('img', { name: '几何.svg', exact: true }); await image.click();
  const handles = page.getByRole('button', { name: /^调整图片尺寸：/ });
  expect(await handles.count(), '选中单图应提供四角与四边八个手柄').toBe(8);
  const original = (await workspace.state()).images![0]!;
  await page.getByRole('button', { name: '调整图片尺寸：右下', exact: true }).press('ArrowRight');
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.width).toBe(201);
  let saved = (await workspace.state()).images![0]!;
  expect(saved.item.pose).toMatchObject({ ...original.item.pose, width: 201, height: 100.5 });
  await expect(page.getByRole('button', { name: '调整图片尺寸：左', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '调整图片尺寸：左', exact: true }).press('ArrowLeft');
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.width).toBe(202);
  saved = (await workspace.state()).images![0]!;
  expect(saved.item.pose).toMatchObject({ x: original.item.pose.x - 1, y: original.item.pose.y, width: 202, height: 100.5 });
  expect(saved.content).toEqual(original.content);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.width).toBe(201);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual(saved.item.pose);
  await workspace.restart(); await page.reload();
  await expect(image).toBeVisible(); expect((await workspace.state()).images![0]!.item.pose).toEqual(saved.item.pose);
});

test('图片角点零位移与缩放下取消不写，完成手势只保存一次比例布局', async ({ page, workspace }) => {
  const fixture = await croppedCanvasImage(page, workspace), image = fixture.image;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: fixture.projectId, type: 'image.transform',
    expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, pose: { x: 350, y: 280, width: 333.3, height: 100.1 } } });
  await page.reload(); const visual = page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }); await visual.click();
  const original = await workspace.state(), pose = original.images![0]!.item.pose;
  const history = async () => (await page.request.get(workspace.origin + '/api/mapping/projects/' + fixture.projectId + '/history')).json();
  const beforeHistory = await history(), handle = page.getByRole('button', { name: '调整图片尺寸：右下', exact: true });
  await handle.click(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state(), '零位移点击不得因浮点重算产生新版本或历史').toEqual(original);
  expect(await history()).toEqual(beforeHistory);
  await page.locator('button.react-flow__controls-zoomout').click();
  const zoom = await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  const node = page.locator(`.react-flow__node[data-id="${image.item.id}"]`);
  const width = () => node.evaluate(element => element.getBoundingClientRect().width / new DOMMatrix(getComputedStyle(element.closest('.react-flow__viewport')!).transform).a);
  const begin = async () => {
    const box = (await handle.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 5, { steps: 4 });
  };
  await begin(); await expect.poll(width).toBeCloseTo(pose.width + 40 / zoom, 2);
  expect(await workspace.state()).toEqual(original);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(width).toBeCloseTo(pose.width, 2); expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(beforeHistory);
  await begin(); await page.mouse.up(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const saved = (await workspace.state()).images![0]!;
  expect(saved.item.pose.width).toBeCloseTo(pose.width + 40 / zoom, 2);
  expect(saved.item.pose.width / saved.item.pose.height).toBeCloseTo(pose.width / pose.height, 8);
  expect((await history()).undo).toHaveLength(beforeHistory.undo.length + 1);
});

test('图片移动等待确认时可访问地阻止后续几何输入，ACK后保一次移动与历史', async ({ page, workspace }) => {
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '等待移动.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>') });
  const visual = page.getByRole('img', { name: '等待移动.svg', exact: true }); await visual.click();
  const original = (await workspace.state()).images![0]!;
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'canvas.move' || reached) return route.continue();
    const response = await route.fetch(); reached = true; await gate; await route.fulfill({ response });
  });
  try {
    await visual.press('ArrowRight'); await expect.poll(() => reached).toBe(true);
    await expect(visual, '等待整组移动确认的图片应公开其禁用状态').toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('status')).toContainText('画布');
    await visual.press('ArrowDown'); release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const saved = await workspace.state();
    expect(saved.images![0]!.item.pose).toEqual({ ...original.item.pose, x: original.item.pose.x + 10 });
    const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + saved.project.id + '/history')).json();
    expect(history.undo.map((action: any) => action.label)).toEqual(['image.create', 'canvas.move']);
    await expect(page.getByRole('region', { name: '混合移动保存冲突', exact: true })).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('图片可单独键盘移动并参加卡片混合移动，一次撤销整组且比例内容不变', async ({ page, workspace }) => {
  await place(page, '同行卡片');
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '可移动.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>') });
  const visual = page.getByRole('img', { name: '可移动.svg', exact: true }); await visual.click();
  const original = await workspace.state(), image = original.images![0]!;
  await visual.press('ArrowRight');
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.x, { message: '图片方向键应按画布单位移动' }).toBe(image.item.pose.x + 10);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '同行卡片', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  const before = await workspace.state();
  await visual.focus(); await visual.press('ArrowDown');
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.y).toBe(image.item.pose.y + 10);
  const moved = await workspace.state();
  expect(moved.cards[0]!.item.pose).toEqual({ ...before.cards[0]!.item.pose, y: before.cards[0]!.item.pose.y + 10 });
  expect(moved.images![0]!.content).toEqual(image.content);
  expect(moved.images![0]!.item.pose).toEqual({ ...image.item.pose, x: image.item.pose.x + 10, y: image.item.pose.y + 10 });
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual(before.images![0]!.item.pose);
  expect((await workspace.state()).cards[0]!.item.pose).toEqual(before.cards[0]!.item.pose);
});

test('图片调整待确认只阻原项目历史，另一项目独立撤销且ACK后按旋转顺序撤销重做', async ({ page, workspace }) => {
  const original = await croppedCanvasImage(page, workspace), projectId = original.projectId;
  const read = async (id: string, suffix = '') => (await page.request.get(workspace.origin + '/api/mapping/projects/' + id + suffix)).json();
  const before = await read(projectId), beforeHistory = await read(projectId, '/history');
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(projectId);
  const otherId = new URL(page.url()).searchParams.get('project')!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: otherId, type: 'thought.create', expected: null,
    payload: { id: 'independent-history-card', title: 'B独立卡', text: '', x: 100, y: 100 } });
  await page.reload(); await expect(page.getByRole('button', { name: 'B独立卡', exact: true })).toBeVisible();
  await page.locator(`[role="tab"][title="${projectId}"]`).click();
  const visual = page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }); await visual.click();
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), responses: number[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'image.rotate' || command.projectId !== projectId) return route.continue();
    reached = true; await gate;
    const response = await route.fetch(); responses.push(response.status()); await route.fulfill({ response });
  });
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  const redo = page.getByRole('button', { name: '重做', exact: true });
  try {
    await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
    await expect.poll(() => reached).toBe(true);
    expect(await read(projectId)).toEqual(before); expect(await read(projectId, '/history')).toEqual(beforeHistory);
    await expect(undo, '图片请求送达Mapping前，原项目撤销必须等待确认').toBeDisabled();
    await expect(redo).toBeDisabled();
    await page.keyboard.press('ControlOrMeta+z');
    await page.locator(`[role="tab"][title="${otherId}"]`).click();
    await expect(undo, 'A未确认图片不能锁住B的独立历史').toBeEnabled(); await undo.click();
    await expect(page.getByRole('button', { name: 'B独立卡', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await read(otherId)).cards.length).toBe(0);
    const otherState = await read(otherId), otherHistory = await read(otherId, '/history');
    expect(await read(projectId)).toEqual(before); expect(await read(projectId, '/history')).toEqual(beforeHistory);
    const navigation = page.getByRole('button', { name: '项目导航', exact: true }); await navigation.focus();
    const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
    release(); await expect.poll(() => responses).toEqual([200]);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.locator(`[role="tab"][title="${otherId}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(navigation).toBeFocused(); expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport);
    expect(await read(otherId)).toEqual(otherState); expect(await read(otherId, '/history')).toEqual(otherHistory);
    const rotated = (await read(projectId)).images[0]; expect(rotated.item.pose.rotation).toBe(90);
    expect(rotated.id).toBe(original.image.id); expect(rotated.content).toEqual(original.image.content);
    await page.locator(`[role="tab"][title="${projectId}"]`).click(); await expect(visual).toBeVisible();
    await expect(undo).toBeEnabled(); await undo.click();
    await expect.poll(async () => (await read(projectId)).images[0]?.item.pose).toEqual(original.image.item.pose);
    const restored = (await read(projectId)).images[0]; expect(restored.id).toBe(original.image.id); expect(restored.content).toEqual(original.image.content);
    expect((await read(projectId, '/history')).undo.map((item: any) => item.label)).toEqual(['image.create']);
    expect((await read(projectId, '/history')).redo.map((item: any) => item.label)).toEqual(['image.rotate']);
    await redo.click(); await expect.poll(async () => (await read(projectId)).images[0]?.item.pose).toEqual(rotated.item.pose);
    expect((await read(projectId, '/history')).undo.map((item: any) => item.label)).toEqual(['image.create', 'image.rotate']);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
