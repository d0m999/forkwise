import { test, expect, place } from './writing-board-fixture';
import { preserveClipboard } from './clipboard-fixture';
test.use({ actionTimeout: 6000 });

test('跨表指针切换后操作范围、列宽和一次undo始终属于当前表', async ({ page, workspace }) => {
  await place(page, '两表操作范围');
  const initial = await workspace.state(), card = initial.cards[0]!;
  const rows = (height: number, width: number, name: string) =>
    Array.from({ length: height }, (_, r) =>
      Array.from({ length: width }, (_, c) => ({ text: `${name}${r + 1},${c + 1}` })),
    );
  const original = [
    { id: 'large-table', type: 'table', header: false, rows: rows(5, 4, '大'), columnWidths: [100, 110, 120, 130] },
    { id: 'small-table', type: 'table', header: false, rows: rows(2, 2, '小'), columnWidths: [140, 150] },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: initial.project.id,
    type: 'body.edit', expected: card.body.versionId,
    payload: { id: card.id, blocks: original },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '两表操作范围', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="large-table"] [data-cell="4,3"]').click();
  const tools = page.getByRole('group', { name: '表格操作', exact: true });
  await expect(tools).toContainText('5 行 × 4 列 · 第 5 行第 4 列');
  await editor.locator('[data-block-id="small-table"] [data-cell="0,0"]').hover();
  await expect(tools).toContainText('2 行 × 2 列 · 第 1 行第 1 列');
  await expect(tools.getByRole('button', { name: '删除第 1 行（2 个单元格）', exact: true })).toBeVisible();
  await tools.getByRole('button', { name: '删除第 1 行（2 个单元格）', exact: true }).click();
  // Missing optional inline identities are assigned on the first DOM edit.
  // Compare every content field; undo must also restore the imported shape.
  const body = async () => (await workspace.state()).cards[0]!.body.blocks.map(({ inlineId, ...block }) => block);
  await expect.poll(body).toEqual([original[0], { ...original[1], rows: original[1]!.rows.slice(1) }]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect.poll(body).toEqual(original);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.locator('[data-block-id="small-table"] [data-cell="0,0"]').hover();
  await tools.getByRole('spinbutton', { name: '第 1 列宽度', exact: true }).fill('333');
  await tools.getByRole('button', { name: '应用列宽', exact: true }).click();
  await expect.poll(body).toEqual([original[0], { ...original[1], columnWidths: [333, 150] }]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect.poll(body).toEqual(original);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.locator('[data-block-id="small-table"] [data-cell="0,0"]').hover();
  await tools.getByRole('button', { name: '删除第 1 列（2 个单元格）', exact: true }).click();
  await expect.poll(body).toEqual([original[0], { ...original[1], rows: original[1]!.rows.map(r => r.slice(1)), columnWidths: [150] }]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect.poll(body).toEqual(original);
});


test('导入的代码未带可选行内身份仍能编辑语言和wrap且保留全部字面文字', async ({ page, workspace }) => {
  await place(page, '导入代码编辑');
  const initial = await workspace.state(), card = initial.cards[0]!;
  const original = { id: 'imported-code', type: 'code', text: '<b>literal</b>\n  **raw**', language: 'vendor-language', wrap: false };
  await workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: initial.project.id, type: 'body.edit', expected: card.body.versionId,
    payload: { id: card.id, blocks: [original] },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '导入代码编辑', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('pre').click();
  await expect(page.getByLabel('代码语言', { exact: true })).toHaveValue('vendor-language');
  await page.getByRole('button', { name: '自动换行', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]).toEqual({ ...original, inlineId: expect.any(String), wrap: true });
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await page.getByLabel('代码语言', { exact: true }).selectOption('html');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]).toEqual({ ...original, inlineId: expect.any(String), wrap: true, language: 'html' });
  await expect(editor.locator('b,strong,script')).toHaveCount(0);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]).toEqual({ ...original, inlineId: expect.any(String), wrap: true });
});

test('表格和代码组合输入优先于Enter、Tab、Esc和快捷键，代码转换保留字面文字', async ({
  page,
  workspace,
}) => {
  await place(page, '组合输入边界');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  for (const kind of ['简单表格', '代码块']) {
    await editor.click();
    await page.getByRole('button', { name: '插入块', exact: true }).click();
    await page.getByRole('menuitem', { name: kind, exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const before = await workspace.state();
    const target = kind === '简单表格' ? editor.locator('[data-cell]').first() : editor;
    await target.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
      for (const key of ['Enter', 'Tab', 'Escape'])
        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key,
            isComposing: true,
            keyCode: 229,
          }),
        );
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          metaKey: true,
          isComposing: true,
          keyCode: 229,
        }),
      );
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    });
    expect(await workspace.state()).toEqual(before);
    await expect(page.getByRole('complementary', { name: '写字板' })).toBeVisible();
  }
  await page.keyboard.insertText('  <b>literal</b>\n**raw**');
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '转为段落', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.at(-1)!.text)
    .toBe('  <b>literal</b>\n**raw**');
  await expect(editor.locator('b,strong,script')).toHaveCount(0);
});

test('单元格支持现有八类行内格式和链接编辑，格式一次undo保持单元格边界', async ({
  page,
  workspace,
}) => {
  await place(page, '八类单元格格式');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '简单表格', exact: true }).click();
  const cell = editor.locator('[data-cell]').first();
  await cell.fill('中文格式');
  async function select() {
    await cell.evaluate((el) => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.keyboard.press('Shift');
    await expect(page.getByRole('toolbar', { name: '文字格式' })).toBeVisible();
  }
  for (const name of ['加粗', '斜体', '下划线', '删除线', '行内代码']) {
    await select();
    if (['下划线', '删除线', '行内代码'].includes(name))
      await page.getByRole('button', { name: '格式更多', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
  }
  await select();
  await page.getByRole('button', { name: '文字颜色', exact: true }).click();
  await page.getByRole('button', { name: '红色文字', exact: true }).click();
  await select();
  await page.getByRole('button', { name: '格式更多', exact: true }).click();
  await page.getByRole('button', { name: '黄色高亮', exact: true }).click();
  await select();
  await page.getByRole('button', { name: '链接', exact: true }).click();
  await page.getByLabel('链接地址', { exact: true }).fill('https://example.com/cell');
  await page.getByRole('button', { name: '应用链接', exact: true }).click();
  await expect
    .poll(async () =>
      ((await workspace.state()).cards[0]!.body.blocks[0]!.rows as any)[0][0].marks
        .map((m: any) => m.type)
        .sort(),
    )
    .toEqual([
      'bold',
      'code',
      'highlight',
      'italic',
      'link',
      'strikethrough',
      'textColor',
      'underline',
    ]);
  const before = (await workspace.state()).cards[0]!.body.blocks;
  await cell.press('Meta+z');
  await expect
    .poll(async () =>
      ((await workspace.state()).cards[0]!.body.blocks[0]!.rows as any)[0][0].marks.some(
        (m: any) => m.type === 'link',
      ),
    )
    .toBe(false);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await cell.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(before);
  await cell.locator('a').click();
  await expect(page.getByRole('link', { name: '打开链接', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '移除链接', exact: true }).click();
  await expect(cell).toHaveText('中文格式');
  await expect(cell.locator('a')).toHaveCount(0);
});

test('单元格内结构化粘贴仍是行内内容，图片字节不能静默降级丢弃', async ({ page, workspace }) => {
  await place(page, '单元格粘贴边界');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '简单表格', exact: true }).click();
  const cell = editor.locator('[data-cell]').first();
  await cell.click();
  await cell.evaluate((el) => {
    const data = encodeURIComponent(
      JSON.stringify({
        format: 'forkwise-body-blocks-v1',
        readonlyIds: [],
        blocks: [
          {
            id: 'copied',
            type: 'text',
            text: '单元格文字',
            marks: [{ type: 'italic', start: 0, end: 5 }],
          },
        ],
      }),
    );
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '单元格文字');
    clipboardData.setData('text/html', `<div data-forkwise-blocks="${data}">单元格文字</div>`);
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect(cell.locator('em')).toHaveText('单元格文字');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(1);
  const before = await workspace.state();
  await cell.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File([new Uint8Array([0, 1, 2])], 'fixture.png', {
        type: 'image/png',
      }),
    );
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect(page.getByRole('alert')).toContainText('原文已保留');
  expect(await workspace.state()).toEqual(before);
});

test('表头、增加行列、列宽和列删除一次undo，宽表只在块内横滚并可继续正文', async ({
  page,
  workspace,
}) => {
  await place(page, '宽表格');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '简单表格', exact: true }).click();
  await page.getByRole('button', { name: '首行表头', exact: true }).click();
  await expect(editor.locator('th')).toHaveCount(2);
  await page.getByRole('button', { name: '在下方增加行', exact: true }).click();
  await page.getByRole('button', { name: '在右侧增加列', exact: true }).click();
  await expect(editor.locator('[data-cell]')).toHaveCount(9);
  await page.getByLabel('第 2 列宽度', { exact: true }).fill('640');
  await page.getByRole('button', { name: '应用列宽', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.columnWidths)
    .toEqual([160, 640, 160]);
  const dimensions = await editor.evaluate((el) => {
    const table = el.querySelector<HTMLElement>('.imported-table')!,
      scroll = el.closest('.board-scroll')!;
    return {
      table: [table.clientWidth, table.scrollWidth],
      body: [el.clientWidth, el.scrollWidth],
      panel: [scroll.clientWidth, scroll.scrollWidth],
    };
  });
  expect(dimensions.table[1]!).toBeGreaterThan(dimensions.table[0]!);
  expect(dimensions.body[1]!).toBeLessThanOrEqual(dimensions.body[0]! + 1);
  expect(dimensions.panel[1]!).toBeLessThanOrEqual(dimensions.panel[0]! + 1);
  const before = (await workspace.state()).cards[0]!.body.blocks;
  await page.getByRole('button', { name: '删除第 2 列（3 个单元格）', exact: true }).click();
  await expect(editor.locator('[data-cell]')).toHaveCount(6);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(before);
  await expect(editor.locator('[data-cell]')).toHaveCount(9);
  await editor.locator('[data-cell]').first().click();
  await page.getByRole('button', { name: '在表格下方插入段落', exact: true }).click();
  await page.keyboard.insertText('表格之后正文');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.at(-1)!.text)
    .toBe('表格之后正文');
  await page.screenshot({ path: test.info().outputPath('wide-table.png') });
});

test('表格历史请求进行中所有单元格只读，完成后恢复输入', async ({ page, workspace }) => {
  await place(page, '表格锁');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '简单表格', exact: true }).click();
  const cell = editor.locator('[data-cell]').first();
  await cell.fill('保留');
  await cell.press('Tab');
  await expect
    .poll(async () => ((await workspace.state()).cards[0]!.body.blocks[0]!.rows as any)[0][0].text)
    .toBe('保留');
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  await page.route('**/api/mapping/execute', async (route) => {
    if (route.request().postDataJSON().type === 'history.undo') {
      observed();
      await gate;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await started;
    await expect(cell).toHaveAttribute('contenteditable', 'false');
  } finally {
    release();
  }
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await expect(cell).toHaveAttribute('contenteditable', 'true');
});

test('表格默认2x2、末格Tab新增一行、行列删除一次undo并同revision持久化', async ({
  page,
  workspace,
}) => {
  await place(page, '简单表格');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '简单表格', exact: true }).click();
  const cells = editor.locator('[data-cell]');
  await expect(cells).toHaveCount(4);
  await cells.nth(0).fill('甲');
  await cells.nth(0).press('Enter');
  await page.keyboard.insertText('乙');
  await cells.nth(0).press('Tab');
  await expect(cells.nth(1)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cells.nth(0)).toBeFocused();
  await cells.nth(3).fill('末格');
  await cells.nth(3).press('Tab');
  await expect(cells).toHaveCount(6);
  await expect(cells.nth(4)).toBeFocused();
  await page.getByRole('button', { name: '删除第 3 行（2 个单元格）', exact: true }).click();
  await expect(cells).toHaveCount(4);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(cells).toHaveCount(6);
  const saved = await workspace.state();
  expect((saved.cards[0]!.body.blocks[0]!.rows as any)[0][0].text).toBe('甲\n乙');
  expect((saved.cards[0]!.body.blocks[0]!.rows as any)[1][1].text).toBe('末格');
  await workspace.restart();
  await page.reload();
  await workspace.open(page);
  await page.getByRole('button', { name: '简单表格', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(cells).toHaveCount(6);
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(saved.cards[0]!.body.blocks);
});

test('复制代码写入真实浏览器剪贴板的是完整字面纯文本且不修改正文或历史', async ({
  page,
  workspace,
}, info) => {
  await place(page, '复制代码');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.type('```html');
  await page.keyboard.press('Enter');
  const literal = '<div>中文</div>\n  **literal**\n';
  await page.keyboard.insertText(literal);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state();
  const guard = await preserveClipboard(page, info, literal, false);
  try {
    await page
      .getByRole('group', { name: '代码操作', exact: true })
      .getByRole('button', { name: '复制代码', exact: true })
      .click();
    await guard.wrote(literal);
    await expect(page.getByRole('alert')).toHaveText('已复制代码');
    expect(await workspace.state()).toEqual(before);
  } finally {
    await guard.restore();
  }
});

test('代码语言wrap与Tab、保留缩进的Enter、Esc和快捷下方段落均保持字面并重开', async ({
  page,
  workspace,
}) => {
  await place(page, '代码编辑');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '代码块', exact: true }).click();
  await page.keyboard.insertText('  <script>window.__literal15=1</script>');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.insertText('**literal**');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('  <script>window.__literal15=1</script>\n    **literal**');
  await page.getByLabel('代码语言', { exact: true }).selectOption('html');
  await page.getByRole('button', { name: '自动换行', exact: true }).click();
  await expect(editor.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
  await editor.locator('pre').click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeFocused();
  await editor.locator('pre').click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.press('Meta+Enter');
  await page.keyboard.insertText('代码之后正文');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['code', '  <script>window.__literal15=1</script>\n    **literal**'],
      ['text', '代码之后正文'],
    ]);
  await expect(editor.locator('script,strong,svg,iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__literal15)).toBeUndefined();
  const saved = (await workspace.state()).cards[0]!.body.blocks;
  expect(saved[0]).toMatchObject({ language: 'html', wrap: true });
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '代码编辑', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('pre')).toContainText('**literal**');
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(saved);
});

test('单元格行内格式和富文粘贴只保行内内容并经HTTP与MCP同snapshot读回', async ({
  page,
  workspace,
}) => {
  await place(page, '单元格格式');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '简单表格', exact: true }).click();
  const cell = editor.locator('[data-cell]').first();
  await cell.fill('中文格式');
  await cell.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.keyboard.press('Shift');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(cell.locator('strong')).toHaveText('中文格式');
  await cell.press('End');
  await cell.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '后续\n文字');
    clipboardData.setData(
      'text/html',
      '<p><em>后续</em></p><p>文字</p><script>window.__executed15=1</script>',
    );
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect(cell).toHaveText('中文格式后续\n文字', { useInnerText: true });
  await expect(cell.locator('em')).toHaveText('后续');
  await expect(cell.locator('p,table,script')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const state = await workspace.state();
  expect((state.cards[0]!.body.blocks[0]!.rows as any)[0][0].text).toBe('中文格式后续\n文字');
  const index = await (
    await page.request.get(
      workspace.origin + `/api/mapping/projects/${state.project.id}/map?view=index`,
    )
  ).json();
  const agent = await workspace.agentBody(state.project.id, state.cards[0]!.id, index.snapshot);
  expect(agent.revision).toBe(index.revision);
  expect(agent.body.blocks).toEqual(state.cards[0]!.body.blocks);
  expect(await page.evaluate(() => (window as any).__executed15)).toBeUndefined();
});

for (const trigger of ['末格Tab', '增加末行', '增加末列']) {
  test(`表格undo生命周期：${trigger}后缩回维度，操作范围与真实单元格一致`, async ({ page, workspace }) => {
    await place(page, '撤销后的表格范围');
    const initial = await workspace.state(), card = initial.cards[0]!;
    const original = [
      { id: 'small-history-table', inlineId: 'small-inline', type: 'table', header: false, columnWidths: [140, 150], rows: [[{ text: '甲' }, { text: '乙' }], [{ text: '丙' }, { text: '丁' }]] },
      { id: 'neighbor-table', inlineId: 'neighbor-inline', type: 'table', header: true, columnWidths: [170], rows: [[{ text: '相邻表格原件' }]] },
      { id: 'neighbor-code', inlineId: 'code-inline', type: 'code', language: 'vendor-original', wrap: false, text: '<b>原件</b>\n  **literal**' },
    ];
    await workspace.execute(page, {
      commandId: crypto.randomUUID(), projectId: initial.project.id, type: 'body.edit', expected: card.body.versionId,
      payload: { id: card.id, blocks: original },
    });
    await workspace.open(page);
    await page.getByRole('button', { name: '撤销后的表格范围', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    const table = editor.locator('[data-block-id="small-history-table"]');
    await table.locator('[data-cell="1,1"]').click();
    if (trigger === '末格Tab') await table.locator('[data-cell="1,1"]').press('Tab');
    else await page.getByRole('button', { name: trigger === '增加末行' ? '在下方增加行' : '在右侧增加列', exact: true }).click();
    await expect.poll(async () => {
      const block = (await workspace.state()).cards[0]!.body.blocks[0]!;
      return [(block.rows as any[]).length, (block.rows as any[][])[0]!.length];
    }).toEqual(trigger === '增加末列' ? [2, 3] : [3, 2]);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    if (trigger === '末格Tab') await table.locator('[data-cell="2,0"]').press('Meta+z');
    else await page.getByRole('button', { name: '撤销', exact: true }).click();
    const body = async () => (await workspace.state()).cards[0]!.body.blocks;
    await expect.poll(body).toEqual(original);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const tools = page.getByRole('group', { name: '表格操作', exact: true });
    const declaration = await tools.locator('span').first().innerText();
    const selection = await editor.evaluate(() => {
      const node = getSelection()?.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      const cell = el?.closest<HTMLElement>('[data-cell]');
      return { blockId: cell?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId ?? null, cell: cell?.dataset.cell ?? null };
    });
    await test.info().attach(`undo-${trigger}-actual`, { body: JSON.stringify({ trigger, declaration, selection, state: await workspace.state() }, null, 2), contentType: 'application/json' });
    const match = declaration.match(/2 行 × 2 列 · 第 (\d+) 行第 (\d+) 列/);
    expect(match).not.toBeNull();
    const row = Number(match![1]) - 1, column = Number(match![2]) - 1;
    expect(row >= 0 && row < 2 && column >= 0 && column < 2).toBe(true);
    await expect(table.locator(`[data-cell="${row},${column}"]`)).toHaveCount(1);
    expect(selection).toEqual({ blockId: 'small-history-table', cell: `${row},${column}` });
    await tools.getByRole('button', { name: `删除第 ${row + 1} 行（2 个单元格）`, exact: true }).click();
    await expect.poll(body).toEqual([{ ...original[0], rows: original[0]!.rows!.filter((_, i) => i !== row) }, ...original.slice(1)]);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(body).toEqual(original);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    // Select an existing cell explicitly before testing each independent action.
    await table.locator('[data-cell="0,1"]').click();
    await tools.getByRole('spinbutton', { name: '第 2 列宽度', exact: true }).fill('277');
    await tools.getByRole('button', { name: '应用列宽', exact: true }).click();
    await expect.poll(body).toEqual([{ ...original[0], columnWidths: [140, 277] }, ...original.slice(1)]);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(body).toEqual(original);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await table.locator('[data-cell="1,1"]').click();
    await tools.getByRole('button', { name: '删除第 2 列（2 个单元格）', exact: true }).click();
    await expect.poll(body).toEqual([{ ...original[0], columnWidths: [140], rows: original[0]!.rows!.map(r => r.slice(0, 1)) }, ...original.slice(1)]);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(body).toEqual(original);
  });
}
