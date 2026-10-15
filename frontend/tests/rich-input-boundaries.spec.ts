import { test, expect, place } from './writing-board-fixture';
test.use({ actionTimeout: 6000 });

test('C14-AC3 列表文字选区粘贴结构化父子保留两端文字、独立身份和有效归属', async ({
  page,
  workspace,
}) => {
  await place(page, '父子粘贴');
  const initial = await workspace.state(),
    card = initial.cards[0]!;
  const original = [
    {
      id: 'list-target',
      inlineId: 'target-inline',
      type: 'listItem',
      listType: 'bullet',
      text: 'ABCD',
    },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: initial.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: original },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '父子粘贴', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.evaluate((el) => {
    el.focus();
    const node = el.querySelector('[data-block-id="list-target"]')!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 1);
    range.setEnd(node, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const data = encodeURIComponent(
      JSON.stringify({
        format: 'forkwise-body-blocks-v1',
        readonlyIds: [],
        blocks: [
          {
            id: 'incoming-parent',
            type: 'listItem',
            listType: 'bullet',
            text: 'P',
          },
          {
            id: 'incoming-child',
            type: 'listItem',
            listType: 'bullet',
            parentId: 'incoming-parent',
            text: 'C',
          },
        ],
      }),
    );
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'P\nC');
    clipboardData.setData('text/html', `<div data-forkwise-blocks="${data}">P<br>C</div>`);
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['AP', 'C', 'D']);
  const saved = await workspace.state(),
    blocks = saved.cards[0]!.body.blocks;
  expect(blocks[0]).toMatchObject({
    id: 'list-target',
    inlineId: 'target-inline',
    type: 'listItem',
  });
  expect(blocks[1]).toMatchObject({
    type: 'listItem',
    parentId: blocks[0]!.id,
  });
  expect(new Set(blocks.map((b) => b.id)).size).toBe(3);
  expect(blocks.some((b) => ['incoming-parent', 'incoming-child'].includes(b.id))).toBe(false);
  await editor.press('Meta+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(original);
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  const beforeRestart = await page.locator('.workspace').getAttribute('data-snapshot');
  await workspace.restart();
  await workspace.open(page);
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', beforeRestart!);
  await page.getByRole('button', { name: '父子粘贴', exact: true }).click();
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(saved.project.id, card.id, snapshot!);
  expect(agent.body.blocks).toEqual(blocks);
  expect(agent.revision).toBe((await workspace.state()).project.revision);
});

test('C14-AC4 跨列表文字替换保留未选子项的文字身份与有效所属，撤销恢复完整原件', async ({
  page,
  workspace,
}) => {
  await place(page, '跨列表保留');
  const initial = await workspace.state(),
    card = initial.cards[0]!;
  const original = [
    {
      id: 'cross-a',
      inlineId: 'cross-ia',
      type: 'listItem',
      listType: 'bullet',
      text: 'AA',
    },
    {
      id: 'cross-b',
      inlineId: 'cross-ib',
      type: 'listItem',
      listType: 'bullet',
      text: 'BB',
    },
    {
      id: 'cross-child',
      inlineId: 'cross-ic',
      type: 'listItem',
      listType: 'bullet',
      parentId: 'cross-b',
      text: 'child',
    },
    { id: 'cross-tail', inlineId: 'cross-it', type: 'text', text: 'tail' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: initial.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: original },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '跨列表保留', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.evaluate((el) => {
    el.focus();
    const range = document.createRange();
    range.setStart(el.querySelector('[data-block-id="cross-a"]')!.firstChild!, 1);
    range.setEnd(el.querySelector('[data-block-id="cross-b"]')!.firstChild!, 1);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'X');
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text).join('\n'))
    .toBe('AXB\nchild\ntail');
  const saved = await workspace.state(),
    blocks = saved.cards[0]!.body.blocks;
  const merged = blocks.find((b) => b.text === 'AXB')!,
    child = blocks.find((b) => b.id === 'cross-child')!;
  expect(merged).toMatchObject({
    id: 'cross-a',
    inlineId: 'cross-ia',
    type: 'listItem',
  });
  expect(child).toEqual({ ...original[2], parentId: merged.id });
  expect(blocks.find((b) => b.id === 'cross-tail')).toEqual(original[3]);
  await editor.press('Meta+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(original);
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  const beforeRestart = await page.locator('.workspace').getAttribute('data-snapshot');
  await workspace.restart();
  await workspace.open(page);
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', beforeRestart!);
  await page.getByRole('button', { name: '跨列表保留', exact: true }).click();
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(saved.project.id, card.id, snapshot!);
  expect(agent.body.blocks).toEqual(blocks);
  expect(agent.revision).toBe((await workspace.state()).project.revision);
});

test('C14-AC3 嵌套目标粘贴父子保持目的层级，原后代留原父项且后半文字置于整组之后', async ({
  page,
  workspace,
}) => {
  await place(page, '嵌套结构粘贴');
  const initial = await workspace.state(),
    card = initial.cards[0]!;
  const original = [
    {
      id: 'nested-root',
      inlineId: 'ni-r',
      type: 'listItem',
      listType: 'bullet',
      text: 'R',
    },
    {
      id: 'nested-target',
      inlineId: 'ni-t',
      type: 'listItem',
      listType: 'bullet',
      parentId: 'nested-root',
      text: 'ABCD',
    },
    {
      id: 'nested-old-child',
      inlineId: 'ni-c',
      type: 'listItem',
      listType: 'bullet',
      parentId: 'nested-target',
      text: 'existing child',
    },
    {
      id: 'nested-sibling',
      inlineId: 'ni-s',
      type: 'listItem',
      listType: 'bullet',
      parentId: 'nested-root',
      text: 'sibling',
    },
    { id: 'nested-tail', inlineId: 'ni-end', type: 'text', text: 'tail' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: initial.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: original },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '嵌套结构粘贴', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.evaluate((el) => {
    el.focus();
    const node = el.querySelector('[data-block-id="nested-target"]')!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 1);
    range.setEnd(node, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const data = encodeURIComponent(
      JSON.stringify({
        format: 'forkwise-body-blocks-v1',
        readonlyIds: [],
        blocks: [
          {
            id: 'nested-incoming-parent',
            type: 'listItem',
            listType: 'bullet',
            text: 'P',
          },
          {
            id: 'nested-incoming-child',
            type: 'listItem',
            listType: 'bullet',
            parentId: 'nested-incoming-parent',
            text: 'C',
          },
        ],
      }),
    );
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'P\nC');
    clipboardData.setData('text/html', `<div data-forkwise-blocks="${data}">P<br>C</div>`);
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.text))
    .toEqual(['R', 'AP', 'C', 'existing child', 'D', 'sibling', 'tail']);
  const saved = await workspace.state(),
    blocks = saved.cards[0]!.body.blocks;
  const parent = blocks.find((b) => b.text === 'AP')!,
    child = blocks.find((b) => b.text === 'C')!;
  expect(parent).toMatchObject({
    id: 'nested-target',
    inlineId: 'ni-t',
    parentId: 'nested-root',
  });
  expect(child.parentId).toBe(parent.id);
  expect(['nested-incoming-parent', 'nested-incoming-child']).not.toContain(child.id);
  expect(blocks.find((b) => b.text === 'D')).toMatchObject({
    type: 'listItem',
    parentId: 'nested-root',
  });
  for (const i of [0, 2, 3, 4])
    expect(blocks.find((b) => b.id === original[i]!.id)).toEqual(original[i]);
  await editor.press('Meta+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(original);
  await editor.press('Meta+Shift+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  const beforeRestart = await page.locator('.workspace').getAttribute('data-snapshot');
  await workspace.restart();
  await workspace.open(page);
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-snapshot', beforeRestart!);
  await page.getByRole('button', { name: '嵌套结构粘贴', exact: true }).click();
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  const agent = await workspace.agentBody(saved.project.id, card.id, snapshot!);
  expect(agent.body.blocks).toEqual(blocks);
  expect(agent.revision).toBe((await workspace.state()).project.revision);
});

test('段首新输入触发仅消费新标记，保留后方历史文字，撤销恢复完整原输入', async ({
  page,
  workspace,
}) => {
  await place(page, '前缀');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await editor.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '旧文 **未解释**');
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('旧文 **未解释**');
  await editor.press('Home');
  await page.keyboard.type('## ');
  await expect(editor.locator('h2')).toHaveText('旧文 **未解释**');
  await expect(editor.locator('strong')).toHaveCount(0);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([['text', '## 旧文 **未解释**']]);
});

test('浏览器组合事件优先，组合完成和历史标记的后续单字符不重新解释旧正文', async ({
  page,
  workspace,
}) => {
  await place(page, '组合');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.dispatchEvent('compositionstart', { data: '' });
  await editor.fill('## ');
  await editor.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  await expect(editor.locator('h2')).toHaveCount(0);
  await editor.dispatchEvent('compositionend', { data: '## ' });
  await page.keyboard.type(' ');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([['text', '##  ']]);
  await editor.fill('');
  await editor.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '**旧文*');
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await page.keyboard.type('*');
  await expect(editor).toHaveText('**旧文**');
  await expect(editor.locator('strong')).toHaveCount(0);
});

test('代码内普通富文和明确Markdown粘贴均为块内纯文字与空行', async ({ page, workspace }) => {
  await place(page, '代码粘贴');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.type('```txt');
  await editor.press('Enter');
  await editor.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '**raw**\n\n# next');
    clipboardData.setData('text/html', '<h1>wrong</h1>');
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([['code', '**raw**\n\n# next']]);
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: async () => '\n**literal**\n\n> plain',
    }),
  );
  await page.getByRole('button', { name: /^选择块：/ }).click();
  await page.getByRole('menuitem', { name: '粘贴为 Markdown', exact: true }).click();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text, b.marks ?? null]),
    )
    .toEqual([['code', '**raw**\n\n# next\n**literal**\n\n> plain', null]]);
  await expect(editor.locator('strong,h1,blockquote')).toHaveCount(0);
});

test('明确粘贴等待期间关闭原卡后，晚到剪贴板内容不能落到新卡片', async ({ page, workspace }) => {
  await place(page, '原目标');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('原文');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('原文');
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          (window as any).finishOldPaste = resolve;
        }),
    }),
  );
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '粘贴为纯文本', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishOldPaste))
    .toBe('function');
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await place(page, '新目标');
  await page.getByRole('button', { name: '编辑正文', exact: true }).last().click();
  await editor.click();
  await page.evaluate(() => (window as any).finishOldPaste('迟到内容'));
  await expect(editor).toBeEmpty();
  expect((await workspace.state()).cards.map((c) => c.body.blocks.map((b) => b.text))).toEqual([
    ['原文'],
    [''],
  ]);
});
