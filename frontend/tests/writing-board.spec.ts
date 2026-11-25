import { test, expect, place } from './writing-board-fixture';

test('项目首次宽度为 440，旧值独立保留，临时限制和恢复默认可重开验证', async ({ page, workspace }) => {
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  const open = () => page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const expectWidth = (width: number) => expect.poll(async () => (await board.boundingBox())?.width).toBe(width);
  const firstProject = page.getByRole('tab', { selected: true });
  const firstId = (await firstProject.getAttribute('title'))!;
  await place(page, '原项目卡', 80, 120);
  await open();
  await expectWidth(440);
  await page.getByRole('button', { name: '关闭正文' }).click();
  // 模拟升级前已保存在此浏览器里的项目偏好，随后从正常入口重开。
  await page.evaluate(id => localStorage.setItem('forkwise:writing-board-width:' + id, '544'), firstId);
  await open();
  await expectWidth(544);
  const separator = page.getByRole('separator', { name: '调整写字板宽度' });
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.setViewportSize({ width: 960, height: 900 });
  await expectWidth(480);
  await page.mouse.up();
  await page.setViewportSize({ width: 1360, height: 900 });
  await expectWidth(544);
  await page.setViewportSize({ width: 960, height: 900 });
  await expectWidth(480);
  await separator.click();
  await page.getByRole('button', { name: '关闭正文' }).click();
  await page.setViewportSize({ width: 1360, height: 900 });
  await open();
  await expectWidth(544);

  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  const secondProject = page.getByRole('tab').and(page.locator(`[title]:not([title="${firstId}"])`));
  await expect(secondProject).toHaveAttribute('aria-selected', 'true');
  await place(page, '另一项目卡', 80, 120);
  await open();
  await expectWidth(440);
  await page.getByRole('separator', { name: '调整写字板宽度' }).press('ArrowLeft');
  await expectWidth(460);
  await page.locator('.project-tabs').getByTitle(firstId).click();
  await page.getByRole('button', { name: '原项目卡', exact: true }).click();
  await open();
  await expectWidth(544);
  await board.getByText('详情', { exact: true }).click();
  await board.getByRole('button', { name: '恢复默认宽度' }).click();
  await expectWidth(440);
  await secondProject.click();
  await page.getByRole('button', { name: '另一项目卡', exact: true }).click();
  await open();
  await expectWidth(460);
  await page.locator('.project-tabs').getByTitle(firstId).click();
  await page.getByRole('button', { name: '原项目卡', exact: true }).click();
  await open();
  await expectWidth(440);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '原项目卡', exact: true }).click();
  await open();
  await expectWidth(440);
});

test('空正文和轻量标签入口可见，图片限制按需查阅，原空段点击输入后保留正文身份', async ({ page, workspace }) => {
  await place(page, '空正文占位', 80, 120);
  const original = (await workspace.state()).cards[0]!;
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const placeholder = page.getByText('输入文字，或用 / 插入', { exact: true });
  const help = page.locator('.media-limits');
  const details = page.getByText('详情', { exact: true });
  await expect(editor).not.toBeFocused();
  const textRects = (locator: typeof placeholder) => locator.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0)
          rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }
    return rects;
  });
  for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 660 }]) {
    await page.setViewportSize(viewport);
    await expect(placeholder).toBeInViewport();
    await expect(help).toBeHidden();
    await details.click();
    await expect(help).toBeInViewport();
    await expect(help).toContainText('512 KiB');
    await expect(help).toContainText('单张图片最多 4000 万像素');
    await expect(help).toContainText('GIF 的所有帧累计也最多 4000 万像素');
    await details.press('Escape');
    await expect(help).toBeHidden();
  }
  const hint = (await textRects(placeholder))[0]!;
  await page.mouse.click(hint.x + hint.width / 2, hint.y + hint.height / 2);
  await expect(editor).toBeFocused();
  await expect.poll(() => editor.evaluate(() => {
    const node = getSelection()?.anchorNode;
    return (node instanceof Element ? node : node?.parentElement)
      ?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
  })).toBe(original.body.blocks[0]!.id);
  await page.keyboard.insertText('空正文点击后输入');
  await expect(placeholder).toHaveCount(0);
  await expect(help).toBeHidden();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks
    .map(({ id, type, text }) => ({ id, type, text })))
    .toEqual([{ id: original.body.blocks[0]!.id, type: 'text', text: '空正文点击后输入' }]);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const saved = (await workspace.state()).cards[0]!.body;
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '空正文占位', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor).toHaveText('空正文点击后输入');
  await expect(placeholder).toHaveCount(0);
  expect((await workspace.state()).cards[0]!.body).toEqual(saved);
});

test('标题、标签和正文同线阅读，保存等待、失败重试与确认可在写字板完成', async ({ page, workspace }, info) => {
  await place(page, '先把问题拆开', 80, 120);
  const initial = (await workspace.state()).cards[0]!;
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  const title = board.getByRole('heading', { name: '先把问题拆开', exact: true });
  const tags = board.getByRole('button', { name: '管理标签', exact: true });
  const editor = board.getByRole('textbox', { name: '卡片正文', exact: true });
  const id = board.getByText(`卡片 ID：${initial.id}`, { exact: true });
  await expect(tags).toHaveText('＋ 标签');
  await expect(id).toBeHidden();
  await board.getByText('详情', { exact: true }).click();
  await expect(id).toBeVisible();
  await board.getByText('详情', { exact: true }).click();
  await tags.click();
  await board.getByRole('textbox', { name: '新标签名称' }).fill('研究问题');
  await board.getByRole('button', { name: '创建标签', exact: true }).click();
  await board.getByRole('button', { name: '完成标签管理' }).click();
  const chip = board.getByText('研究问题', { exact: true });
  await expect(chip).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');

  let reject!: () => void;
  const hold = new Promise<void>(resolve => { reject = resolve; });
  let rejectWrites = true;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'body.edit' || !rejectWrites) return route.continue();
    await hold;
    await route.abort();
  });
  try {
    await editor.fill('业务改善、制造进展与估值，是三个不同的问题。');
    await expect(board.getByText('正在保存…', { exact: true })).toBeVisible();
    const separator = board.getByRole('separator', { name: '调整写字板宽度' });
    await separator.press('ArrowLeft');
    await expect.poll(async () => (await board.boundingBox())?.width).toBe(460);
    await expect(editor).toHaveText('业务改善、制造进展与估值，是三个不同的问题。');
    await separator.press('ArrowRight');
    await board.getByRole('button', { name: '展开写字板' }).click();
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(board.getByRole('button', { name: '返回画布' })).toBeVisible();
    await expect(editor).toHaveText('业务改善、制造进展与估值，是三个不同的问题。');
    await page.setViewportSize({ width: 1360, height: 900 });
    await board.getByRole('button', { name: '还原写字板' }).click();
    await expect(title).toBeInViewport();
    await expect(editor).toHaveText('业务改善、制造进展与估值，是三个不同的问题。');
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(board.getByRole('button', { name: '返回画布' })).toBeVisible();
    reject();
    await expect(board.getByText('保存未完成', { exact: true })).toBeVisible();
    const retry = page.getByRole('button', { name: '重试保存', exact: true });
    await expect(retry).toBeInViewport();
    await expect(editor).toContainText('业务改善、制造进展与估值');
    await page.screenshot({ path: info.outputPath('save-failed.png') });
    rejectWrites = false;
    await retry.click();
    await expect(board.getByText('正文已保存', { exact: true })).toBeVisible();
  } finally {
    reject();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await editor.press('End');
  await editor.press('Enter');
  await page.keyboard.insertText('把已知、未知，以及需要继续阅读的内容，分别放在画布上。');
  await expect(board.getByText('正文已保存', { exact: true })).toBeVisible();
  await board.getByRole('button', { name: '关闭正文' }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor).not.toBeFocused();
  for (const width of [1360, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await board.boundingBox())?.width).toBe(width === 1360 ? 440 : 760);
    for (const item of [title, chip, editor]) await expect(item).toBeInViewport();
    const [head, tag, body] = await Promise.all([title.boundingBox(), chip.boundingBox(), editor.boundingBox()]);
    expect(head!.y).toBeLessThan(tag!.y);
    expect(tag!.y).toBeLessThan(body!.y);
    expect(head!.x).toBeCloseTo(body!.x, 0);
    await page.screenshot({ path: info.outputPath(`reading-${width}.png`) });
  }
});

test('原卡保存失败后的切卡和后续输入只显示当前卡的保存状态', async ({ page, workspace }) => {
  await place(page, '正文甲', 80, 120);
  await place(page, '正文乙', 420, 150);
  const [cardA, cardB] = (await workspace.state()).cards;
  const titleA = page.getByRole('button', { name: '正文甲', exact: true });
  await titleA.click();
  await page.locator('.react-flow__node').filter({ has: titleA }).getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  const editor = board.getByRole('textbox', { name: '卡片正文', exact: true });
  const boardRetry = board.getByRole('button', { name: '重试保存', exact: true });
  const workspaceRetry = page.getByRole('button', { name: '重试保存', exact: true });
  const aRequests: string[] = [];
  let rejectA = true;
  let releaseB!: () => void;
  const holdB = new Promise<void>(resolve => { releaseB = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'body.edit') return route.continue();
    if (command.payload.id === cardA!.id) {
      aRequests.push(command.commandId);
      if (rejectA) return route.abort();
    }
    if (command.payload.id === cardB!.id) await holdB;
    await route.continue();
  });
  try {
    await editor.fill('属于甲的未确认正文');
    await expect(board.getByText('保存未完成', { exact: true })).toBeVisible();
    await expect(boardRetry).toBeVisible();
    await page.getByRole('button', { name: '正文乙', exact: true }).click();
    await expect(board.getByRole('heading', { name: '正文乙', exact: true })).toBeVisible();
    await expect(board.getByText('已保存到本机', { exact: true })).toBeVisible();
    await expect(boardRetry).toBeHidden();
    await expect(workspaceRetry).toBeVisible();
    const before = aRequests.length;

    await editor.fill('属于乙的等待正文');
    await expect.poll(() => aRequests.length).toBeGreaterThan(before);
    await expect(page.getByRole('status')).toHaveText('保存未完成');
    await expect(board.getByText('等待保存…', { exact: true })).toBeVisible();
    await expect(boardRetry).toBeHidden();
    await expect(workspaceRetry).toBeVisible();
    await expect(editor).toHaveText('属于乙的等待正文');

    rejectA = false;
    await workspaceRetry.click();
    await expect(board.getByText('正在保存…', { exact: true })).toBeVisible();
    releaseB();
    await expect(board.getByText('正文已保存', { exact: true })).toBeVisible();
    await expect(workspaceRetry).toBeHidden();
    expect(new Set(aRequests).size).toBe(1);
    const saved = (await workspace.state()).cards;
    expect(saved.map(card => card.body.blocks.map(block => block.text))).toEqual([
      ['属于甲的未确认正文'], ['属于乙的等待正文'],
    ]);
  } finally {
    releaseB();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('重试原正文期间继续输入，仍显示原请求保存中并最后确认新输入', async ({ page, workspace }) => {
  await place(page, '重试原卡', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  const editor = board.getByRole('textbox', { name: '卡片正文', exact: true });
  const retry = page.getByRole('button', { name: '重试保存', exact: true });
  const requests: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'body.edit') return route.continue();
    requests.push(command.commandId);
    if (requests.length === 1) return route.abort();
    if (requests.length === 2) await held;
    await route.continue();
  });
  try {
    await editor.fill('原草稿');
    await expect(board.getByText('保存未完成', { exact: true })).toBeInViewport();
    await retry.click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toBe(requests[0]);
    await editor.fill('重试期间继续写的新草稿');
    await expect(page.getByRole('status')).toHaveText('等待保存…');
    await expect(board.getByText('正在保存…', { exact: true })).toBeInViewport();
    await expect(board.getByText('保存未完成', { exact: true })).toBeHidden();
    await expect(retry).toBeHidden();
    release();
    await expect(board.getByText('正文已保存', { exact: true })).toBeInViewport();
    expect(requests).toHaveLength(3);
    expect(requests[2]).not.toBe(requests[0]);
    expect((await workspace.state()).cards[0]!.body.blocks.map(block => block.text)).toEqual(['重试期间继续写的新草稿']);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('正文双击普通打开不抢光标，单卡跟随从开头，空白和多选保当前卡', async ({ page, workspace }) => {
  const initial = await workspace.state();
  for (const [id, title, x] of [['a', '卡片甲', 60], ['b', '卡片乙', 380]] as const) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: initial.project.id, type: 'thought.create', expected: null, payload: { id, title, text: `完整${title}正文\n` + '连续阅读的长段落。'.repeat(300), x, y: 100 } });
  }
  const a = page.locator('.react-flow__node').filter({ has: page.getByText('卡片甲', { exact: true }) });
  const b = page.locator('.react-flow__node').filter({ has: page.getByText('卡片乙', { exact: true }) });
  await expect(a.locator('.preview')).toBeVisible();
  await a.locator('.preview').dblclick();
  const board = page.locator('.body-editor');
  await expect(board).toContainText('卡片甲');
  await expect(page.getByLabel('卡片正文', { exact: true })).not.toBeFocused();
  await b.locator('.title-button').click();
  const heading = board.getByRole('heading', { name: '卡片乙', exact: true });
  await expect(heading).toBeInViewport();
  const scroller = board.locator('.board-scroll');
  const viewport = (await scroller.boundingBox())!;
  await page.mouse.move(viewport.x + 100, viewport.y + 200);
  await page.mouse.wheel(0, 900);
  await expect(heading).not.toBeInViewport();
  const scrollTop = await scroller.evaluate(el => el.scrollTop);
  const currentTitle = board.getByText('正在编辑：卡片乙', { exact: true });
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 400 } });
  await expect(currentTitle).toBeInViewport();
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(scrollTop);
  await b.locator('.title-button').click();
  await a.locator('.title-button').click({ modifiers: ['Shift'] });
  await b.locator('.title-button').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(heading).not.toBeInViewport();
  await expect(currentTitle).toBeInViewport();
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(scrollTop);
  for (const width of [320, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(currentTitle).toBeInViewport();
    await expect.poll(() => currentTitle.evaluate(el => {
      const text = el.firstChild!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length - 1);
      range.setEnd(text, text.textContent!.length);
      const lastCharacter = range.getBoundingClientRect(), label = el.getBoundingClientRect();
      return lastCharacter.left >= label.left && lastCharacter.right <= label.right + 1;
    })).toBe(true);
    await expect(board.getByRole('button', { name: '返回画布' })).toBeInViewport();
  }
});

test('单卡与普通连线混选仍明确标明正在编辑的原卡', async ({ page, workspace }) => {
  await place(page, '原卡', 80, 120);
  const state = await workspace.state();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'connector.create',
    expected: null, payload: { id: 'mixed-line', start: { kind: 'free', point: { x: 140, y: 390 } }, end: { kind: 'free', point: { x: 500, y: 390 } } } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '原卡', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const line = page.getByRole('button', { name: '普通连线', exact: true });
  await line.click({ modifiers: ['Shift'] });
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  await expect(board.getByText('正在编辑：原卡', { exact: true })).toBeInViewport();
});

test('菜单真实删卡保留内容、退出编辑，绑定此次删除直接撤销并恢复原卡', async ({ page, workspace }) => {
  await place(page, '原卡删除', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('完整正文：删除后继续只读保留');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).cards[0]!;
  await page.getByRole('button', { name: '原卡删除', exact: true }).click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '删除卡片', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(page.getByLabel('已删除卡片')).toContainText('这张卡片已删除');
  await expect(page.locator('.body-editor')).toContainText('完整正文：删除后继续只读保留');
  await expect(editor).not.toBeFocused();
  await expect(editor).not.toBeEditable();
  await page.getByRole('button', { name: '撤销删除', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  await expect(editor).toBeEditable();
  const restored = (await workspace.state()).cards[0]!;
  expect(restored.id).toBe(original.id);
  expect(restored.body.blocks).toEqual(original.body.blocks);
  expect(restored.body.versionId).not.toBe(original.body.versionId);
});

test('真实段落输入在光标处分块，软换行仍同块，末尾空段与块首退格通过保存重开保留身份', async ({ page, workspace }) => {
  await place(page, '段落卡', 80, 120);
  const initial = (await workspace.state()).cards[0]!;
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.insertText('ABCD');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.insertText('尾');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.map(b => b.text)).toEqual(['AB', 'CD\n尾', '']);
  const saved = (await workspace.state()).cards[0]!.body.blocks;
  expect(saved[0]!.id).toBe(initial.body.blocks[0]!.id);
  expect(new Set(saved.map(b => b.id)).size).toBe(3);
  expect(new Set(saved.map(b => b.inlineId)).size).toBe(3);
  await editor.press('Meta+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(saved.slice(0, 2));
  // SQLite visibility precedes the history ACK and UI unlock.
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(saved);
  // SQLite commits before the history response restores the editable UI.
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await expect(editor).toBeFocused();
  await editor.locator('[data-block-id]').last().click();
  await editor.press('Home');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.map(b => b.text)).toEqual(['AB', 'CD\n尾']);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.map(b => b.text)).toEqual(['ABCD\n尾']);
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeFocused();
  await expect(page.locator('.body-editor')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:recovery:v1:')))).toEqual([]);
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '段落卡', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor).toHaveText('ABCD尾');
  const reopened = (await workspace.state()).cards[0]!;
  expect(reopened.body.blocks[0]!.id).toBe(initial.body.blocks[0]!.id);
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(reopened.id === initial.id ? (await workspace.state()).project.id : '', reopened.id, snapshot!);
  expect(agent.body).toEqual(reopened.body);
  expect(agent.body.blocks.map((b: { id: string }) => b.id)).toEqual(await editor.locator('[data-block-id]').evaluateAll(elements => elements.map(e => (e as HTMLElement).dataset.blockId)));
  expect(agent.revision).toBe(Number(await page.locator('.workspace').getAttribute('data-revision')));
});

test('宽度基线、拖动调宽、展开还原和窄窗使用同一正文视图并保持块内阅读锚点', async ({ page, workspace }) => {
  await place(page, '长文卡', 80, 120);
  const state = await workspace.state(), card = state.cards[0]!;
  const blocks = Array.from({ length: 40 }, (_, i) => ({ id: 'paragraph-' + i, type: 'text', text: `段落${i}：` + '稳定的中文原文与块内阅读位置。'.repeat(40), inlineId: 'inline-' + i }));
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'body.edit', expected: card.body.versionId, payload: { id: card.id, blocks } });
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.locator('.body-editor');
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(440);
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="paragraph-15"]').scrollIntoViewIfNeeded();
  const readingPoint = () => editor.locator('[data-block-id="paragraph-15"]').evaluate(p => {
    const range = document.createRange(); range.setStart(p.firstChild!, 280); range.setEnd(p.firstChild!, 281);
    return range.getBoundingClientRect().y;
  });
  const scroller = board.locator('.board-scroll');
  const expectReadingPointInView = () => expect.poll(async () => {
    const y = await readingPoint(), viewport = (await scroller.boundingBox())!;
    return y >= viewport.y && y < viewport.y + viewport.height;
  }).toBe(true);
  const bounds = (await scroller.boundingBox())!;
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await page.mouse.wheel(0, await readingPoint() - bounds.y - 56);
  await expect.poll(readingPoint).toBeLessThan(bounds.y + 90);
  const mark = await readingPoint();
  const historyBefore = await page.request.get(workspace.origin + `/api/mapping/projects/${state.project.id}/history`).then(r => r.json());
  const separator = page.getByRole('separator', { name: '调整写字板宽度' });
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 220);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 80, handle.y + 220, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(520);
  await expectReadingPointInView();
  await page.getByRole('button', { name: '展开写字板' }).click();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(1360);
  await expectReadingPointInView();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.getByRole('button', { name: '返回画布' })).toBeVisible();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(760);
  await expectReadingPointInView();
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(1360);
  await expectReadingPointInView();
  await page.getByRole('button', { name: '还原写字板' }).click();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(520);
  await expectReadingPointInView();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(760);
  await expectReadingPointInView();
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(520);
  await expectReadingPointInView();
  const restored = await readingPoint();
  expect(Math.abs(restored - mark)).toBeLessThan(35);
  await expect(editor).toHaveCount(1);
  expect(await page.request.get(workspace.origin + `/api/mapping/projects/${state.project.id}/history`).then(r => r.json())).toEqual(historyBefore);
  await page.setViewportSize({ width: 760, height: 900 });
  await page.getByRole('button', { name: '返回画布' }).click();
  await expect(board).toBeHidden();
  await expect(page.locator('.react-flow__pane')).toBeInViewport();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(520);
  await expect(editor.locator('[data-block-id="paragraph-0"]')).toBeInViewport();
});


test('段落内空首行的Backspace先删除软换行，只有真正块首才合并前块', async ({ page, workspace }) => {
  await place(page, '空首行退格', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click(); await page.keyboard.insertText('甲');
  await editor.press('Enter'); await editor.press('Shift+Enter'); await page.keyboard.insertText('乙');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.map(b => b.text)).toEqual(['甲', '\n乙']);
  const before = (await workspace.state()).cards[0]!.body.blocks;
  await editor.press('Home'); await editor.press('Backspace');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual([{ ...before[0]! }, { ...before[1]!, text: '乙' }]);
  await editor.press('Home'); await editor.press('Backspace');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual([{ ...before[0]!, text: '甲乙' }]);
});
