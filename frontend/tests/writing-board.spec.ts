import { test, expect, place } from './writing-board-fixture';

test('空正文占位避开图片说明，点击原空段可输入并在保存重开后保持正文身份', async ({ page, workspace }) => {
  await place(page, '空正文占位', 80, 120);
  const original = (await workspace.state()).cards[0]!;
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const placeholder = page.getByText('输入文字，或用 / 插入', { exact: true });
  const help = page.locator('.media-limits');
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
    const hintRects = await textRects(placeholder), helpRects = await textRects(help);
    expect(hintRects.length).toBeGreaterThan(0);
    expect(helpRects.length).toBeGreaterThan(0);
    const overlaps = hintRects.flatMap(hint => helpRects.filter(note =>
      hint.x < note.x + note.width && hint.x + hint.width > note.x &&
      hint.y < note.y + note.height && hint.y + hint.height > note.y,
    ).map(note => ({ hint, note })));
    expect(overlaps, `${viewport.width}px 窗口的占位与图片说明文字不得重叠`).toEqual([]);
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
  await expect(help).toBeVisible();
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
  await expect(board).toContainText('卡片乙');
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 400 } });
  await expect(board).toContainText('卡片乙');
  await b.locator('.title-button').click();
  await a.locator('.title-button').click({ modifiers: ['Shift'] });
  await b.locator('.title-button').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(board).toContainText('正在编辑：卡片乙');
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
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(544);
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="paragraph-15"]').scrollIntoViewIfNeeded();
  const readingPoint = () => editor.locator('[data-block-id="paragraph-15"]').evaluate(p => {
    const range = document.createRange(); range.setStart(p.firstChild!, 280); range.setEnd(p.firstChild!, 281);
    return range.getBoundingClientRect().y;
  });
  const bounds = (await page.locator('.board-scroll').boundingBox())!;
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await page.mouse.wheel(0, await readingPoint() - bounds.y - 56);
  await expect.poll(readingPoint).toBeLessThan(bounds.y + 90);
  const mark = await readingPoint();
  const historyBefore = await page.request.get(workspace.origin + `/api/mapping/projects/${state.project.id}/history`).then(r => r.json());
  const separator = page.getByRole('separator', { name: '调整写字板宽度' });
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 220);
  await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y + 220, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await board.boundingBox())!.width).toBeGreaterThan(620);
  await page.getByRole('button', { name: '展开写字板' }).click();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(1360);
  await expect(editor.locator('[data-block-id="paragraph-15"]')).toBeVisible();
  await page.setViewportSize({ width: 700, height: 700 });
  await expect(page.getByRole('button', { name: '返回画布' })).toBeVisible();
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(700);
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect.poll(async () => (await board.boundingBox())!.width).toBe(1360);
  await page.getByRole('button', { name: '还原写字板' }).click();
  await expect.poll(async () => (await board.boundingBox())!.width).toBeGreaterThan(620);
  const restored = await readingPoint();
  expect(Math.abs(restored - mark)).toBeLessThan(35);
  await expect(editor).toHaveCount(1);
  expect(await page.request.get(workspace.origin + `/api/mapping/projects/${state.project.id}/history`).then(r => r.json())).toEqual(historyBefore);
  await page.getByRole('button', { name: '关闭正文' }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
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
