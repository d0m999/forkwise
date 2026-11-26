import { expect, place, test } from './writing-board-fixture';

test('创作工具从指针或 Tab 显示名称，Escape 取消放置后恢复选择', async ({ page, workspace: _workspace }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const select = page.getByRole('button', { name: '选择', exact: true });
  const move = page.getByRole('button', { name: '移动', exact: true });
  const card = page.getByRole('button', { name: '卡片', exact: true });
  await select.hover();
  await expect(page.getByRole('tooltip', { name: '选择', exact: true })).toBeVisible({ timeout: 3000 });
  await page.mouse.move(5, 150);
  await select.focus();
  await page.keyboard.press('Tab');
  await expect(move).toBeFocused();
  await expect(page.getByRole('tooltip', { name: '移动', exact: true })).toBeVisible();
  await card.press('Enter');
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('点击画布放置卡片', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('点击画布放置卡片', { exact: true })).toBeHidden();
});

test('侧栏打开且画布收窄时，历史、缩放和创作入口均可实际操作', async ({ page, workspace }) => {
  await place(page, '与工具栏并排阅读');
  await page.getByRole('button', { name: '写字板', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const viewport = page.locator('.react-flow__viewport');
  const dock = page.getByRole('group', { name: '创作工具', exact: true });
  const history = page.getByRole('group', { name: '项目历史', exact: true });
  const zoomTools = page.getByLabel('画布视图', { exact: true });
  for (const width of [1360, 960]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(board.getByText('与工具栏并排阅读', { exact: true })).toBeVisible();
    if (width === 960) {
      const resizer = board.getByRole('separator', { name: '调整写字板宽度' });
      await resizer.press('ArrowLeft');
      await resizer.press('ArrowLeft');
      await expect(resizer).toHaveAttribute('aria-valuenow', '480');
    }
    const [dockBox, historyBox, zoomBox] = await Promise.all([dock.boundingBox(), history.boundingBox(), zoomTools.boundingBox()]);
    expect(dockBox).not.toBeNull();
    expect(historyBox).not.toBeNull();
    expect(zoomBox).not.toBeNull();
    for (const [first, second] of [[dockBox!, historyBox!], [dockBox!, zoomBox!], [historyBox!, zoomBox!]]) {
      const overlaps = first.x < second.x + second.width && second.x < first.x + first.width &&
        first.y < second.y + second.height && second.y < first.y + first.height;
      expect(overlaps).toBe(false);
    }
    const zoom = () => viewport.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a);
    const before = await zoom();
    await page.getByRole('button', { name: '缩小', exact: true }).click({ timeout: 3000 });
    await expect.poll(zoom).toBeLessThan(before);
    await page.getByRole('button', { name: '放大', exact: true }).click({ timeout: 3000 });
    await expect.poll(zoom).toBeCloseTo(before);
    await page.getByRole('button', { name: '缩小', exact: true }).click({ timeout: 3000 });
    await expect.poll(zoom).toBeLessThan(before);
    const unfitted = await zoom();
    await page.getByRole('button', { name: '适应画布', exact: true }).click({ timeout: 3000 });
    await expect.poll(zoom).not.toBeCloseTo(unfitted);
    await page.getByRole('button', { name: '图片', exact: true }).hover({ timeout: 3000 });
    await page.getByRole('button', { name: '移动', exact: true }).click({ timeout: 3000 });
    await expect(page.getByRole('button', { name: '移动', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '选择', exact: true }).click({ timeout: 3000 });
    await expect(board.getByText('与工具栏并排阅读', { exact: true })).toBeVisible();
  }
  await board.getByRole('button', { name: '展开写字板', exact: true }).click();
  await expect(dock).toBeHidden();
  await expect(zoomTools).toBeHidden();
  await expect(history).toBeVisible();
  await board.getByRole('button', { name: '还原写字板', exact: true }).click();
  await expect(board.getByRole('separator', { name: '调整写字板宽度' })).toHaveAttribute('aria-valuenow', '480');
  await expect(dock).toBeVisible();
  await expect(zoomTools).toBeVisible();
  await page.getByRole('button', { name: '撤销', exact: true }).click({ timeout: 3000 });
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
});

test('建卡等待落点时，Escape 先关闭形状或画笔菜单，下一次才取消放置', async ({ page, workspace }) => {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  for (const [label, menuName] of [['形状', '形状预设'], ['画笔', '画笔类型']]) {
    await button('卡片').click();
    await button(label).click();
    const menu = page.getByRole('menu', { name: menuName, exact: true });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button(label)).toBeFocused();
    await expect(button('卡片')).toHaveAttribute('aria-pressed', 'true', { timeout: 2000 });
    await expect(page.getByText('点击画布放置卡片', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(button('选择')).toHaveAttribute('aria-pressed', 'true');
  }
  expect((await workspace.state()).cards).toHaveLength(0);
});

test('切换分区到移动后，画布拖动只平移视口', async ({ page, workspace }) => {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const before = await workspace.state();
  const transform = () => page.locator('.react-flow__viewport').evaluate(node => getComputedStyle(node).transform);
  const oldTransform = await transform();
  await button('分区').click();
  await button('移动').click();
  await page.mouse.move(510, 235);
  await page.mouse.down();
  await page.mouse.move(660, 375, { steps: 6 });
  await page.mouse.up();
  await expect.poll(transform, { timeout: 2000 }).not.toBe(oldTransform);
  await expect(button('分区')).toHaveAttribute('aria-pressed', 'false');
  expect(await workspace.state()).toEqual(before);
});

test('长项目导航或同步提示展开时，项目历史仍可点按和键盘操作', async ({ page, workspace }) => {
  await place(page, '历史操作目标');
  const project = (await workspace.state()).project;
  for (let index = 0; index < 30; ++index) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      type: 'project.create', expected: null, payload: { name: '查看研究列表和历史操作 ' + index } });
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto(new URL('/?project=' + encodeURIComponent(project.id), workspace.origin).href);
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const undo = button('撤销'), redo = button('重做');
  const navigation = page.getByRole('complementary', { name: '项目导航' });
  await button('项目导航').click();
  await expect(navigation.getByRole('button', { name: /查看研究列表和历史操作/ })).toHaveCount(30);
  const undoTip = page.getByRole('tooltip', { name: '撤销', exact: true });
  await undo.hover();
  await expect(undoTip).toBeInViewport({ ratio: 1 });
  await page.mouse.move(400, 160);
  await redo.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(undo).toBeFocused();
  await expect(undoTip).toBeInViewport({ ratio: 1 });
  await undo.click({ timeout: 3000 });
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  await expect(redo).toBeEnabled();
  await redo.focus();
  await expect(redo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  await button('项目导航').click();
  await expect(navigation).toBeHidden();
  await page.setViewportSize({ width: 1360, height: 900 });
  const changes = '**/api/mapping/projects/' + project.id + '/changes?**';
  await page.route(changes, route => route.abort('connectionreset'));
  try {
    await expect(page.getByText('地图同步暂时中断，正在重试；未确认草稿已保留')).toBeVisible();
    await undo.click({ timeout: 3000 });
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('画笔保存未确认时，选择和移动保持可聚焦并标明不可操作', async ({ page, workspace }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let committed = false;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'stroke.create') return route.continue();
    const response = await route.fetch();
    committed = response.ok();
    await gate;
    await route.fulfill({ response });
  });
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  try {
    await button('画笔').click();
    await page.getByRole('menuitem', { name: '普通笔', exact: true }).click();
    await page.mouse.move(420, 230);
    await page.mouse.down();
    await page.mouse.move(570, 340, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => committed).toBe(true);
    await expect(button('选择')).toBeDisabled({ timeout: 2000 });
    await expect(button('移动')).toBeDisabled({ timeout: 2000 });
    await button('选择').focus();
    await expect(button('选择')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(button('画笔')).toHaveAttribute('aria-pressed', 'true');
    release();
    await expect(button('选择')).toBeEnabled();
    await expect(button('移动')).toBeEnabled();
    await button('选择').click();
    await expect(button('选择')).toHaveAttribute('aria-pressed', 'true');
    expect((await workspace.state()).strokes).toHaveLength(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('空闲创作模式按 Escape 返回选择，不新增对象或历史', async ({ page, workspace }) => {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const before = await workspace.state();
  for (const name of ['移动', '分区', '文字', '连线', '画笔', '形状']) {
    await button(name).click();
    if (name === '画笔') await page.getByRole('menuitem', { name: '普通笔', exact: true }).click();
    if (name === '形状') await page.getByRole('menuitem', { name: '矩形', exact: true }).click();
    await expect(button(name)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(button('选择')).toHaveAttribute('aria-pressed', 'true', { timeout: 2000 });
    await expect(button(name)).toHaveAttribute('aria-pressed', 'false');
  }
  expect(await workspace.state()).toEqual(before);
});

test('Tab 从形状菜单进入画笔时关闭前一菜单，Escape 只关闭当前菜单', async ({ page, workspace: _workspace }) => {
  const shape = page.getByRole('button', { name: '形状', exact: true });
  const pen = page.getByRole('button', { name: '画笔', exact: true });
  const shapes = page.getByRole('menu', { name: '形状预设', exact: true });
  const pens = page.getByRole('menu', { name: '画笔类型', exact: true });
  await shape.press('Enter');
  await expect(shapes).toBeVisible();
  for (const item of await shapes.getByRole('menuitem').all()) {
    await page.keyboard.press('Tab');
    await expect(item).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(pen).toBeFocused();
  await expect(shapes).toBeHidden({ timeout: 2000 });
  await page.keyboard.press('Enter');
  await expect(pens).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(pens.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pens).toBeHidden();
  await expect(pen).toBeFocused();
});

test('从画笔菜单离开后，Escape 由标题栏的原生改名对话框处理', async ({ page, workspace: _workspace }) => {
  const pen = page.getByRole('button', { name: '画笔', exact: true });
  const rename = page.getByRole('button', { name: '重命名当前项目', exact: true });
  await pen.press('Enter');
  await expect(page.getByRole('menu', { name: '画笔类型', exact: true })).toBeVisible();
  await rename.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '重命名项目', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden({ timeout: 2000 });
  await expect(rename).toBeFocused();
});

test('760px 重新打开有真实未确认草稿的研究，项目历史和草稿恢复都可操作', async ({ page, workspace }) => {
  await place(page, '保留草稿的卡片', 100, 160);
  await place(page, '可以撤销的卡片', 425, 160);
  await page.setViewportSize({ width: 760, height: 900 });
  await page.getByRole('button', { name: '保留草稿的卡片', exact: true }).click();
  await page.getByRole('button', { name: '写字板', exact: true }).click();
  const execute = '**/api/mapping/execute';
  await page.route(execute, route => route.request().postDataJSON()?.type === 'body.edit'
    ? route.abort('connectionreset') : route.continue());
  await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('这段真实输入尚待恢复');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.reload();
  await page.unroute(execute);

  const recovery = page.getByRole('region', { name: '草稿恢复', exact: true });
  await expect(recovery).toContainText('这段真实输入尚待恢复');
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  const redo = page.getByRole('button', { name: '重做', exact: true });
  const topbar = page.getByRole('banner');
  const recoveryTop = (await recovery.boundingBox())!.y;
  const historyBottom = (await redo.boundingBox())!;
  expect(historyBottom.y + historyBottom.height).toBeLessThan(recoveryTop);
  expect(historyBottom.y).toBeLessThan((await topbar.boundingBox())!.height);
  await undo.click({ timeout: 3000 });
  await expect.poll(async () => (await workspace.state()).cards.map(card => card.title)).toEqual(['保留草稿的卡片']);
  let releaseRedo!: () => void;
  const redoAck = new Promise<void>(resolve => { releaseRedo = resolve; });
  await page.route(execute, async route => {
    if (route.request().postDataJSON()?.type !== 'history.redo') return route.continue();
    const response = await route.fetch();
    await redoAck;
    await route.fulfill({ response });
  });
  const restore = recovery.getByRole('button', { name: '恢复草稿', exact: true });
  try {
    await redo.click({ timeout: 3000 });
    await expect.poll(async () => (await workspace.state()).cards.map(card => card.title)).toEqual(['保留草稿的卡片', '可以撤销的卡片']);
    await expect(recovery).toContainText('这段真实输入尚待恢复');
    await expect(restore).toBeVisible();
    await expect(restore).toBeDisabled({ timeout: 2500 });
    releaseRedo();
    await expect(restore).toBeEnabled();
    await restore.click();
    await expect.poll(async () => {
      const block = (await workspace.state()).cards[0]?.body.blocks[0];
      return block?.type === 'text' ? block.text : null;
    }).toBe('这段真实输入尚待恢复');
  } finally {
    releaseRedo();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
