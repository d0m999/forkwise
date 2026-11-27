import { test, expect, place } from './writing-board-fixture';
import { connectorSvgEnds, connectorWorldPoint } from './connector-ui-fixture';
import { createFrameCommand } from '../src/canvas-frame-commands';

for (const width of [1360, 760]) test(`${width}px 四卡样例的浮栏衔接标题、移动和本卡后续控件`, async ({ page, workspace }) => {
  await page.setViewportSize({ width, height: 900 });
  const { project } = await workspace.state();
  const run = (type: string, payload: object, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: project.id, type, payload, expected,
  });
  const cards = [
    { id: 'title', title: '待补材料', text: '', x: 78, y: 137, width: 245, height: 146 },
    { id: 'short', title: '订单线索', text: '本周只有订单口径更新，尚未见到交付凭证。', x: 400, y: 124, width: 248, height: 146 },
    { id: 'long', title: '交付节奏与现金回收', text: '先核对本季已确认的交付，再把口头计划另列为待观察。订单、交付与现金到账是三个不同的时点，比较前先统一口径。不要把缺少披露当作数值为零。\n\n下一次阅读从现金流量表开始，分别记下交易期间、发布日期和证据缺口。若后续出现匹配的收款原件，再补上可以复核的位置。\n\n最后一段：保留原判断，等下一份材料再修订。', x: 80, y: 337, width: 286, height: 174 },
    { id: 'overlap', title: '现金回收待核', text: '另一条线索；保留疑问和未对齐的口径。', x: 254, y: 410, width: 245, height: 122 },
  ];
  for (const { width: _width, height: _height, ...content } of cards) await run('thought.create', content);
  let state = await workspace.state();
  await run('pose.batch', { poses: cards.map(({ title: _title, text: _text, ...pose }) => pose) },
    Object.fromEntries(state.cards.map(card => [card.id, card.item.versionId])));
  const itemId = (id: string) => state.cards.find(card => card.id === id)!.item.id;
  const frame = createFrameCommand(await workspace.state(), cards.map(card => itemId(card.id)), { x: 38, y: 78, width: 670, height: 490 });
  await workspace.execute(page, frame);
  state = await workspace.state();
  await run('frame.edit', { id: frame.payload.id, name: '研究样例 · 交付判断', background: null }, state.frames![0]!.versionId);
  for (const [id, from, a, to, b, path, text] of [
    ['sample-line-1', 'title', 'right', 'short', 'left', 'straight', '等交付凭证'],
    ['sample-line-2', 'short', 'bottom', 'overlap', 'top', 'curve', '核对到账'],
  ]) {
    await run('connector.create', { id, path, start: { kind: 'bound', itemId: itemId(from), side: a },
      end: { kind: 'bound', itemId: itemId(to), side: b } });
    const connector = (await workspace.state()).connectors!.find(line => line.id === id)!;
    await run('connector.label', { id, label: { text, position: 0.5, fontSize: 16, color: '#626e81', bold: false } }, connector.versionId);
  }
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(page.locator('.thought-card')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(2);
  const frameName = page.getByRole('button', { name: '研究样例 · 交付判断', exact: true });
  await expect(frameName).toBeVisible();
  const title = page.getByRole('button', { name: cards[2]!.title, exact: true });
  const card = page.locator('.thought-card').filter({ has: title });
  const toolbar = page.getByRole('toolbar', { name: '卡片操作' });
  const first = toolbar.getByRole('button', { name: '编辑标题', exact: true });
  const move = card.getByRole('button', { name: '移动卡片：方向键调整位置' });
  const body = card.getByRole('button', { name: '编辑正文', exact: true });
  const resize = card.getByRole('button', { name: '调整卡片尺寸：左上', exact: true });

  await title.click();
  await expect(title).toBeFocused();
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(move).toBeFocused();
  let presses = 1;
  while (presses <= 60 && !await first.evaluate(button => button === document.activeElement)) {
    await page.keyboard.press('Tab');
    presses++;
  }
  console.log(JSON.stringify({ width, titleToEditTitleTabs: presses }));
  expect(presses).toBe(2);
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(move).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(title).toBeFocused();

  await move.focus();
  const composingTabNotCanceled = await move.evaluate(button => button.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab', isComposing: true, bubbles: true, cancelable: true,
  })));
  expect(composingTabNotCanceled).toBe(true);
  await expect(move).toBeFocused();

  for (const name of ['编辑标题', '层级', '写字板', '外观', 'AI', '更多']) {
    await page.keyboard.press('Tab');
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(body).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(toolbar.getByRole('button', { name: '更多', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(body).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(resize).toBeFocused();

  // Follow the rest of the document through the old portal location once.
  const laterStops: string[] = [];
  for (let index = 0; index < 80; index++) {
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => {
      const active = document.activeElement!;
      if (active === document.body) return 'end';
      if (active.closest('.card-actions')) return 'toolbar';
      return active.closest('.thought-card')?.querySelector('.title-button')?.textContent ?? '';
    });
    if (next === 'end') break;
    laterStops.push(next);
  }
  expect(laterStops).not.toContain('toolbar');
  expect(laterStops).toContain(cards[3]!.title);

  // Add a real attachment after measuring the original four-card case.
  await run('asset.save', { id: 'focus-pdf', name: '样例原件.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\n').toString('base64'), kind: 'file' });
  await run('card.attachment.add', { id: 'long', assetId: 'focus-pdf', name: '样例原件.pdf' }, { attachments: null });
  await page.reload();
  await title.click();
  await body.focus();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: '打开 样例原件.pdf', exact: true })).toBeFocused();

  await frameName.press('Shift+Enter');
  await expect(toolbar).toHaveCount(0);
  await move.focus();
  await page.keyboard.press('Tab');
  await expect(body).toBeFocused();
});

test('卡片标题与移动按画面顺序进入 Tab，键盘编辑与移动绑定当前卡片', async ({ page, workspace }) => {
  await place(page, '卡片甲', 100, 160);
  await place(page, '卡片乙', 445, 390);
  const title = page.getByRole('button', { name: '卡片甲', exact: true });
  const card = page.locator('.thought-card').filter({ has: title });
  const move = card.getByRole('button', { name: '移动卡片：方向键调整位置' });
  await title.focus();
  await page.keyboard.press('Tab');
  await expect(move).toBeFocused();
  expect(await move.evaluate(e => [getComputedStyle(e).opacity, getComputedStyle(e).outlineStyle])).toEqual(['1', 'solid']);
  const before = (await workspace.state()).cards;
  let unhold!: () => void;
  const hold = new Promise<void>(resolve => { unhold = resolve; });
  const moves: string[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const { type } = route.request().postDataJSON();
    if (type !== 'pose.move' && type !== 'pose.batch' && type !== 'canvas.move') return route.continue();
    moves.push(type);
    if (moves.length !== 1) return route.continue();
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  try {
    await page.keyboard.press('ArrowRight');
    await expect(move).toHaveAttribute('aria-disabled', 'true');
    await expect(move).toBeFocused();
    await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBe(before[0]!.item.pose.x + 10);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    expect(moves).toHaveLength(1);
    unhold();
    await expect(move).toHaveAttribute('aria-disabled', 'false');
    await expect(move).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBe(before[0]!.item.pose.x + 20);
    await expect(move).toHaveAttribute('aria-disabled', 'false');
    expect(moves).toHaveLength(2);
    expect((await workspace.state()).cards[1]!.item.pose).toEqual(before[1]!.item.pose);
  } finally {
    unhold();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.keyboard.press('Shift+Tab');
  await expect(title).toBeFocused();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: '卡片标题', exact: true });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('卡片甲');
  await page.keyboard.press('Escape');
  await expect(title).toBeFocused();
});

for (const width of [1360, 760]) test(`${width}px 卡面占满上下空间时，就近栏与外观面板避开卡片和附近连线端点`, async ({ page, workspace }) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await workspace.state();
  const run = (type: string, payload: object, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: state.project.id, type, payload, expected,
  });
  await run('thought.create', { id: 'test-card', title: '靠边的卡片', text: '不可遮盖的正文', x: 32, y: 0 });
  const card = (await workspace.state()).cards[0]!;
  await run('pose.batch', { poses: [{ id: card.id, x: 32, y: 0, width: 236, height: 800 }] }, { [card.id]: card.item.versionId });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const article = page.locator('.thought-card');
  const cardBox = (await article.boundingBox())!;
  const first = await connectorWorldPoint(page, { x: cardBox.x + cardBox.width + 55, y: cardBox.y + 20 });
  const second = await connectorWorldPoint(page, { x: cardBox.x + cardBox.width + 95, y: cardBox.y + 140 });
  await run('connector.create', { id: 'edge-line', path: 'straight', start: { kind: 'free', point: first }, end: { kind: 'free', point: second } });
  await page.reload();
  await page.getByRole('button', { name: '靠边的卡片' }).click();
  const toolbar = page.getByRole('toolbar', { name: '卡片操作' });
  await expect(toolbar).toBeVisible();
  const canvas = (await page.locator('.canvas').boundingBox())!;
  async function assertClear(overlay: typeof toolbar) {
    const box = (await overlay.boundingBox())!;
    const cardRect = (await article.boundingBox())!;
    expect(box.x >= canvas.x && box.x + box.width <= canvas.x + canvas.width).toBe(true);
    expect(box.y >= canvas.y && box.y + box.height <= canvas.y + canvas.height).toBe(true);
    expect(box.x + box.width <= cardRect.x || box.x >= cardRect.x + cardRect.width ||
      box.y + box.height <= cardRect.y || box.y >= cardRect.y + cardRect.height).toBe(true);
    const endpoints = await connectorSvgEnds(page.getByRole('button', { name: '普通连线' }).locator('path'));
    for (const { x, y } of [endpoints.start, endpoints.end]) {
      expect(x < box.x - 7 || x > box.x + box.width + 7 || y < box.y - 7 || y > box.y + box.height + 7).toBe(true);
    }
  }
  await assertClear(toolbar);
  const appearance = toolbar.getByRole('button', { name: '外观' });
  await appearance.click();
  const popup = page.getByRole('dialog', { name: '卡片外观' });
  await assertClear(popup);
  await expect(popup.getByRole('button', { name: '关闭卡片菜单' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(appearance).toBeFocused();
  await toolbar.getByRole('button', { name: '层级' }).click();
  await assertClear(page.getByRole('menu', { name: '层级操作' }));
});

test('键盘编辑意图等正文回执期间离开标题，不夺回焦点', async ({ page, workspace }) => {
  await place(page, '等待编辑甲', 105, 160);
  await place(page, '正文来源乙', 405, 395);
  const title = page.getByRole('button', { name: '等待编辑甲', exact: true });
  const move = page.locator('.thought-card').filter({ has: title }).getByRole('button', { name: '移动卡片：方向键调整位置' });
  await page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '写字板' }).click();
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  let written = false;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'body.edit') return route.continue();
    const response = await route.fetch();
    written = true;
    await pending;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('textbox', { name: '卡片正文' }).fill('等待真实回执');
    await expect.poll(() => written).toBe(true);
    await title.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(move).toBeFocused();
    release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.getByRole('heading', { name: '等待编辑甲', exact: true })).toBeVisible();
    const editor = page.getByRole('textbox', { name: '卡片标题' });
    await expect(editor).toHaveCount(0);
    await expect(move).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(title).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('等待编辑甲');
    expect((await workspace.state()).cards[1]!.body.blocks[0]?.text).toBe('等待真实回执');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('选区工具保留组合、取消及 Delete 键的画布归属，层级弹层隔离快捷键', async ({ page, workspace }) => {
  await place(page, '组合甲', 90, 165);
  await place(page, '组合乙', 490, 300);
  await place(page, '未选对照', 900, 440);
  const a = page.getByRole('button', { name: '组合甲', exact: true });
  const b = page.getByRole('button', { name: '组合乙', exact: true });
  const group = page.getByRole('toolbar', { name: '组合操作' });
  const groupTrigger = group.getByRole('button', { name: '组合所选对象', exact: true });
  const edits: string[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute')) edits.push(request.postDataJSON().type);
  });
  await a.click();
  await b.press('Shift+Enter');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: '卡片标题' })).toHaveCount(0);
  const layer = group.getByRole('button', { name: '层级', exact: true });
  await layer.click();
  const popup = page.getByRole('menu', { name: '层级操作' });
  await expect(popup.getByRole('menuitem', { name: '置顶', exact: true })).toBeFocused();
  await page.keyboard.press('Meta+g');
  await page.keyboard.press('Delete');
  expect(edits).toEqual([]);
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(layer).toBeFocused();
  await groupTrigger.focus();
  await page.keyboard.press('Meta+g');
  await expect.poll(async () => (await workspace.state()).groups?.length).toBe(1);
  const enter = group.getByRole('button', { name: '进入组合', exact: true });
  await expect(enter).toBeEnabled();
  await enter.focus();
  await page.keyboard.press('Control+Shift+g');
  await expect.poll(async () => (await workspace.state()).groups?.length).toBe(0);
  await expect(groupTrigger).toBeEnabled();
  await groupTrigger.focus();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).cards.map(card => card.title)).toEqual(['未选对照']);
  expect(edits).toEqual(['group.create', 'group.ungroup', 'canvas.delete-selection']);
});

test('卡和连线双向追加、卡和分区追加时不显示单对象工具，重新单选即恢复', async ({ page, workspace }) => {
  await place(page, '混选卡片', 80, 145);
  const before = await workspace.state();
  const run = (type: string, payload: object, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: before.project.id, type, payload, expected,
  });
  await run('connector.create', { id: 'loose-line', path: 'straight',
    start: { kind: 'free', point: { x: 430, y: 250 } }, end: { kind: 'free', point: { x: 600, y: 250 } } });
  await run('frame.create', { id: 'loose-frame', itemIds: [], pose: { x: 400, y: 390, width: 250, height: 150 } },
    { frame: null, groups: {}, containment: {}, poses: {} });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const card = page.getByRole('button', { name: '混选卡片', exact: true });
  const line = page.getByRole('button', { name: '普通连线', exact: true });
  const { start, end } = await connectorSvgEnds(line.locator('path'));
  const lineCenter = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const frame = page.locator('[data-frame-id="loose-frame"] .canvas-frame-name');
  const cardMenu = page.getByRole('toolbar', { name: '卡片操作' });
  const cardHandles = page.getByRole('button', { name: /^调整卡片尺寸：/ });
  const linePanel = page.getByRole('group', { name: '连线路径' });
  const lineHandles = page.getByRole('button', { name: /^连线(?:起点|终点)$/ });
  const framePanel = page.getByRole('toolbar', { name: '分区操作' });
  const frameHandles = page.getByRole('button', { name: /^调整分区范围：/ });
  async function assertMixedLine() {
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(line).toHaveAttribute('aria-pressed', 'true');
    await expect(cardMenu).toHaveCount(0);
    await expect(cardHandles).toHaveCount(0);
    await expect(linePanel).toHaveCount(0);
    await expect(lineHandles).toHaveCount(0);
  }
  await card.click();
  await expect(cardMenu).toBeVisible();
  await expect(cardHandles).toHaveCount(8);
  await page.keyboard.down('Shift');
  await page.mouse.click(lineCenter.x, lineCenter.y);
  await page.keyboard.up('Shift');
  await assertMixedLine();
  await page.mouse.click(lineCenter.x, lineCenter.y);
  await expect(linePanel).toBeVisible();
  await expect(lineHandles).toHaveCount(2);
  await card.press('Shift+Space');
  await expect(page.getByRole('textbox', { name: '卡片标题' })).toHaveCount(0);
  await assertMixedLine();
  await card.click();
  await expect(cardMenu).toBeVisible();
  await frame.press('Shift+Enter');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(frame).toHaveAttribute('aria-pressed', 'true');
  await expect(cardMenu).toHaveCount(0);
  await expect(cardHandles).toHaveCount(0);
  await expect(framePanel).toHaveCount(0);
  await expect(frameHandles).toHaveCount(0);
  await frame.click();
  await expect(framePanel).toBeVisible();
  await expect(frameHandles).toHaveCount(8);
  await card.click();
  await expect(cardMenu).toBeVisible();
  await expect(cardHandles).toHaveCount(8);
  const after = await workspace.state();
  expect(after.cards).toEqual(before.cards);
  expect(after.connectors?.map(value => value.id)).toEqual(['loose-line']);
  expect(after.frames?.map(value => value.id)).toEqual(['loose-frame']);
});

for (const width of [1360, 760]) test(`${width}px 卡边浮层和层级面板保留底部历史及创作入口`, async ({ page, workspace }) => {
  await page.setViewportSize({ width, height: 900 });
  const { project } = await workspace.state();
  const run = (type: string, payload: object, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: project.id, type, payload, expected,
  });
  const dock = page.getByRole('group', { name: '创作工具' });
  const history = page.getByRole('group', { name: '项目历史' });
  const card = page.getByRole('button', { name: '上下贴边', exact: true });
  const historyBox = (await history.boundingBox())!, dockBox = (await dock.boundingBox())!;
  const canvas = (await page.locator('.canvas').boundingBox())!;
  await run('thought.create', { id: 'dock-card', title: '上下贴边', text: '保留卡片正文入口', x: 1, y: 0 });
  for (const target of [historyBox, dockBox]) {
    const { item } = (await workspace.state()).cards[0]!;
    await run('pose.batch', { poses: [{ id: 'dock-card', x: target.x - canvas.x, y: 0, width: 280, height: target.y - canvas.y - 12 }] },
      { 'dock-card': item.versionId });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await card.click();
    const toolbar = page.getByRole('toolbar', { name: '卡片操作' });
    await toolbar.getByRole('button', { name: '层级' }).click();
    const popup = page.getByRole('menu', { name: '层级操作' });
    for (const overlay of [toolbar, popup]) {
      const box = (await overlay.boundingBox())!;
      for (const obstacle of [history, dock, page.locator('.thought-card .preview-region')]) {
        const occupied = (await obstacle.boundingBox())!;
        expect(box.x + box.width <= occupied.x || box.x >= occupied.x + occupied.width ||
          box.y + box.height <= occupied.y || box.y >= occupied.y + occupied.height).toBe(true);
      }
    }
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await dock.getByRole('button', { name: '形状', exact: true }).click();
    await expect(page.getByRole('menu', { name: '形状预设' })).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

for (const leave of ['改选乙', 'Tab 离开', '追加分区'] as const) test(`更多菜单标题等待回执时${leave}，晚回执不打开旧标题`, async ({ page, workspace }) => {
  await place(page, '更多菜单甲', 80, 150);
  await place(page, '较晚选择乙', 470, 320);
  const frame = page.locator('[data-frame-id="later-frame"] .canvas-frame-name');
  if (leave === '追加分区') {
    const { project } = await workspace.state();
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: project.id, type: 'frame.create',
      expected: { frame: null, groups: {}, containment: {}, poses: {} },
      payload: { id: 'later-frame', itemIds: [], pose: { x: 410, y: 500, width: 250, height: 150 } } });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
  }
  const a = page.getByRole('button', { name: '更多菜单甲', exact: true });
  const b = page.getByRole('button', { name: '较晚选择乙', exact: true });
  const toolbar = page.getByRole('toolbar', { name: '卡片操作', exact: true });
  await a.click();
  await toolbar.getByRole('button', { name: '写字板', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  let saved = false;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'body.edit') return route.continue();
    const response = await route.fetch();
    saved = true;
    await pending;
    await route.fulfill({ response });
  });
  try {
    await board.getByRole('textbox', { name: '卡片正文' }).fill('甲正文保存回执暂扣');
    await expect.poll(() => saved).toBe(true);
    const moreTrigger = toolbar.getByRole('button', { name: '更多', exact: true });
    await moreTrigger.click();
    const more = page.getByRole('dialog', { name: '更多', exact: true });
    await more.getByRole('button', { name: '编辑标题', exact: true }).press('Enter');
    await expect(more).toHaveCount(0);
    await expect(moreTrigger).toBeFocused();
    if (leave === '改选乙') await b.click();
    else if (leave === '追加分区') {
      await frame.press('Shift+Enter');
      await expect(frame).toHaveAttribute('aria-pressed', 'true');
    } else await page.keyboard.press('Shift+Tab');
    const current = leave === '改选乙' ? '较晚选择乙' : '更多菜单甲';
    await expect(page.locator('.react-flow__node.selected .title-button')).toHaveText(current);
    const focused = leave === '改选乙' ? b : leave === '追加分区' ? frame
      : toolbar.getByRole('button', { name: 'AI', exact: true });
    await expect(focused).toBeFocused();
    release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(board.getByRole('heading')).toHaveText(current);
    const editor = page.getByRole('textbox', { name: '卡片标题' });
    await expect(editor).toHaveCount(0);
    await expect(focused).toBeFocused();
    await a.click();
    await moreTrigger.click();
    await more.getByRole('button', { name: '编辑标题', exact: true }).press('Enter');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('更多菜单甲');
    expect((await workspace.state()).cards[0]!.body.blocks[0]?.text).toBe('甲正文保存回执暂扣');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('超大卡片标题滚出视口时就近栏避开可见标签，+N 仍能进入写字板', async ({ page, workspace }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const { project } = await workspace.state();
  const run = (type: string, payload: object, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: project.id, type, payload, expected,
  });
  await run('thought.create', { id: 'oversized', title: '超大标签卡', text: '用于从可见正文选择超大卡片', x: 15, y: 125 });
  const tagIds = Array.from({ length: 9 }, (_, i) => 'oversized-tag-' + i);
  for (const [i, id] of tagIds.entries()) {
    await run('tag.create', { id, name: '必须完整保留的超大卡片标签名称'.repeat(3) + i });
  }
  await run('card.tags', { id: 'oversized', tagIds });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const article = page.locator('.thought-card');
  const title = article.locator('.title-button'), row = article.locator('.card-visible-tags');
  const header = (await title.boundingBox())!;
  const card = (await workspace.state()).cards[0]!;
  await run('pose.batch', { poses: [{ id: card.id, x: -32, y: 7 - header.height, width: 802, height: 960 }] },
    { [card.id]: card.item.versionId });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await article.locator('.preview').click({ position: { x: 50, y: 10 } });
  const toolbar = page.getByRole('toolbar', { name: '卡片操作' });
  await expect(toolbar).toBeVisible();
  const labels = (await row.boundingBox())!, bar = (await toolbar.boundingBox())!;
  const textLines = await article.locator('.preview').evaluate(element => {
    const text = document.createRange();
    text.selectNodeContents(element);
    return [...text.getClientRects()].map(box => box.toJSON());
  });
  for (const box of [labels, ...textLines]) {
    expect(bar.x >= box.x + box.width || bar.x + bar.width <= box.x ||
      bar.y >= box.y + box.height || bar.y + bar.height <= box.y).toBe(true);
  }
  const overflow = row.getByRole('button', { name: /^查看另外/ });
  await overflow.click();
  const board = page.getByRole('complementary', { name: '写字板' });
  await expect(board.getByRole('heading')).toHaveText('超大标签卡');
  await expect(board.locator('.board-tags .project-tag')).toHaveCount(tagIds.length);
});

for (const [name, popupRole, popupName, precedingName, followingName] of [
  ['更多', 'dialog', '更多', 'AI', '编辑正文'],
  ['外观', 'dialog', '卡片外观', '写字板', 'AI'],
  ['层级', 'menu', '层级操作', '编辑标题', '写字板'],
] as const) test(`卡片「${name}」弹层首末项衔接本卡 Tab 顺序`, async ({ page, workspace: _workspace }) => {
  await place(page, '下层对照卡', 95, 150);
  await place(page, '浮栏弹层卡', 130, 180);
  const toolbar = page.getByRole('toolbar', { name: '卡片操作' });
  const trigger = toolbar.getByRole('button', { name, exact: true });
  const preceding = toolbar.getByRole('button', { name: precedingName, exact: true });
  const popup = page.getByRole(popupRole, { name: popupName, exact: true });
  await trigger.press('Enter');
  await expect(popup).toBeVisible();
  const items = popup.getByRole(popupRole === 'menu' ? 'menuitem' : 'button', { disabled: false });
  const first = items.first();
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused({ timeout: 3000 });
  await expect(popup).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(preceding).toBeFocused();
  await expect(popup).toHaveCount(0);

  await trigger.press('Enter');
  await expect(first).toBeFocused();
  const last = name === '外观' ? popup.getByRole('checkbox', { name: '显示正文预览' }) : items.last();
  await last.press('Tab');
  const card = page.locator('.thought-card').filter({ has: page.getByRole('button', { name: '浮栏弹层卡', exact: true }) });
  const following = (name === '更多' ? card : toolbar).getByRole('button', { name: followingName, exact: true });
  await expect(following).toBeFocused({ timeout: 3000 });
  await expect(popup).toHaveCount(0);
});

test('矮视口中外观弹层随 Tab 和 Shift+Tab 滚动到聚焦的控件', async ({ page, workspace: _workspace }) => {
  await place(page, '外观键盘导航', 120, 80);
  await page.setViewportSize({ width: 1000, height: 200 });
  await page.getByRole('button', { name: '外观', exact: true }).press('Enter');
  const popup = page.getByRole('dialog', { name: '卡片外观' });
  const close = popup.getByRole('button', { name: '关闭卡片菜单' });
  const preview = popup.getByRole('checkbox', { name: '显示正文预览' });
  await expect(close).toBeFocused();
  await expect(preview).not.toBeInViewport();

  const steps = await popup.getByRole('button').count();
  for (let i = 0; i < steps; i++) await page.keyboard.press('Tab');
  await expect(preview).toBeFocused();
  await expect(preview).toBeInViewport({ ratio: 1, timeout: 3000 });
  for (let i = 0; i < steps; i++) await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport({ ratio: 1 });
});

test('层级全部禁用仍能 Tab 离开，随后 Escape 只关闭新打开的外观', async ({ page, workspace: _workspace }) => {
  await place(page, '唯一卡片', 120, 140);
  const toolbar = page.getByRole('toolbar', { name: '卡片操作' });
  const layers = toolbar.getByRole('button', { name: '层级' });
  await layers.click();
  const menu = page.getByRole('menu', { name: '层级操作' });
  await expect(menu.getByRole('menuitem', { disabled: true })).toHaveCount(4);
  await expect(menu).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(layers).toBeFocused({ timeout: 3000 });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toolbar.getByRole('button', { name: '写字板' })).toBeFocused({ timeout: 3000 });
  await expect(menu).toHaveCount(0);
  const appearance = toolbar.getByRole('button', { name: '外观' });
  await appearance.press('Enter');
  const popup = page.getByRole('dialog', { name: '卡片外观' });
  await expect(popup.getByRole('button', { name: '关闭卡片菜单' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(appearance).toBeFocused();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
});

test('浏览器缺少 checkVisibility 时仍可从移动按 Tab 进入卡片浮栏', async ({ page, workspace: _workspace }) => {
  await place(page, '兼容性测试卡', 120, 140);
  await page.evaluate(() => Reflect.deleteProperty(Element.prototype, 'checkVisibility'));
  await page.getByRole('button', { name: '移动卡片：方向键调整位置' }).press('Tab');
  await expect(page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '编辑标题' })).toBeFocused({ timeout: 3000 });
});
