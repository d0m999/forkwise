import { test, expect, place } from './writing-board-fixture';

test('Tab和Shift+Tab整体调整父项和后代，保持身份及内部层级，一次撤销恢复', async ({
  page,
  workspace,
}) => {
  await place(page, '层级正文', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'a', type: 'listItem', listType: 'bullet', text: '上一同级' },
    { id: 'b', type: 'listItem', listType: 'ordered', text: '父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'todo',
      checked: false,
      text: '子项',
      parentId: 'b',
    },
    {
      id: 'd',
      type: 'listItem',
      listType: 'bullet',
      text: '孙项',
      parentId: 'c',
    },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '层级正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="b"]').click();
  await page.keyboard.press('Tab');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.parentId ?? null]),
    )
    .toEqual([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'c'],
    ]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.parentId ?? null]),
    )
    .toEqual([
      ['a', null],
      ['b', null],
      ['c', 'b'],
      ['d', 'c'],
    ]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.locator('[data-block-id="c"]').click();
  await page.keyboard.press('Shift+Tab');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.parentId ?? null]),
    )
    .toEqual([
      ['a', null],
      ['b', null],
      ['c', null],
      ['d', 'c'],
    ]);
});

test('折叠前结束子项草稿并焦点回父项，前方折叠组Backspace不吞正文，新插入暂展开', async ({
  page,
  workspace,
}) => {
  await place(page, '折叠输入', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'h', type: 'heading', level: 1, text: '章节' },
    { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
    { id: 'tail', type: 'text', text: '尾部' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '折叠输入', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="c"]').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('新草稿');
  await page.getByRole('button', { name: '收起：父项', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[2]!.text)
    .toBe('子项新草稿');
  expect(
    await page.evaluate(() =>
      getSelection()
        ?.anchorNode?.parentElement?.closest('[data-block-id]')
        ?.getAttribute('data-block-id'),
    ),
  ).toBe('p');
  await editor.locator('[data-block-id="tail"]').click();
  await page.keyboard.press('Home');
  const before = await workspace.state();
  await page.keyboard.press('Backspace');
  await expect(editor.locator('[data-block-id="tail"]')).toHaveText('尾部');
  expect(await workspace.state()).toEqual(before);
  await page.getByRole('button', { name: '收起：章节', exact: true }).click();
  await editor.locator('[data-block-id="h"]').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('新插入');
  await expect(editor.locator('p').filter({ hasText: '新插入' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('p').filter({ hasText: '新插入' })).toBeHidden();
});

test('折叠标题操作先显示范围，只有选择本节才整节移动删除且数量包含隐藏块', async ({
  page,
  workspace,
}) => {
  await place(page, '章节范围', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'h', type: 'heading', level: 1, text: '第一章' },
    { id: 't', type: 'text', text: '正文' },
    { id: 'h2', type: 'heading', level: 2, text: '子节' },
    { id: 't2', type: 'text', text: '子节正文' },
    { id: 'end', type: 'heading', level: 1, text: '第二章' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '章节范围', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await page.getByRole('button', { name: '收起：第一章', exact: true }).click();
  await editor.locator('[data-block-id="h"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await expect(editor.locator('[data-block-id="t2"]')).toBeVisible();
  await expect(editor.locator('[data-block-selected="true"]')).toHaveCount(1);
  await page.getByRole('menuitem', { name: '仅删除标题（保留正文）', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['t', 'h2', 't2', 'end']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect(editor.locator('[data-block-id="h"]')).toBeVisible();
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await page.getByRole('button', { name: '收起：第一章', exact: true }).click();
  await editor.locator('[data-block-id="h"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '选择本节', exact: true }).click();
  await expect(page.getByText('已选择 4 个块', { exact: true })).toBeVisible();
  await expect(page.getByText('包含 3 个隐藏块，已临时展开', { exact: true })).toBeVisible();
  await expect(editor.locator('[data-block-selected="true"]')).toHaveCount(4);
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['end', 'h', 't', 'h2', 't2']);
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '选择本节', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除所选 4 个块', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['end']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['end', 'h', 't', 'h2', 't2']);
});

test('章节和子列表折叠按稳定身份跨重开保留，外层展开恢复内层偏好且正文版本不变', async ({
  page,
  workspace,
}) => {
  await place(page, '折叠正文', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'h', type: 'heading', level: 1, text: '第一章' },
    { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
    { id: 'h2', type: 'heading', level: 2, text: '小节' },
    { id: 'text', type: 'text', text: '小节正文' },
    { id: 'end', type: 'heading', level: 1, text: '第二章' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '折叠正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const before = await workspace.state();
  await page.getByRole('button', { name: '收起：父项', exact: true }).click();
  await expect(editor.locator('[data-block-id="c"]')).toBeHidden();
  await page.getByRole('button', { name: '收起：第一章', exact: true }).click();
  await expect(editor.locator('[data-block-id="p"]')).toBeHidden();
  await expect(editor.locator('[data-block-id="end"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '收起：第二章', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '展开：第一章', exact: true }).click();
  await expect(editor.locator('[data-block-id="p"]')).toBeVisible();
  await expect(editor.locator('[data-block-id="c"]')).toBeHidden();
  expect(await workspace.state()).toEqual(before);
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  expect((await workspace.agentBody(state.project.id, card.id, snapshot!)).body).toEqual(
    before.cards[0]!.body,
  );
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('[data-block-id="c"]')).toBeHidden();
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '折叠正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('[data-block-id="c"]')).toBeHidden();
  expect(await workspace.state()).toEqual(before);
});

test('块菜单父组移动和删除明确全部后代数量，一次undo和redo作用于整组', async ({
  page,
  workspace,
}) => {
  await place(page, '整组操作', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
    {
      id: 'g',
      type: 'listItem',
      listType: 'bullet',
      text: '孙项',
      parentId: 'c',
    },
    { id: 's', type: 'listItem', listType: 'bullet', text: '下一组' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '整组操作', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '增加缩进', exact: true })).toBeDisabled();
  await expect(page.getByText('已选择 3 个块', { exact: true })).toBeVisible();
  await expect(editor.locator('[data-block-selected="true"]')).toHaveCount(3);
  await page.screenshot({
    path: test.info().outputPath('list-group-menu.png'),
  });
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['s', 'p', 'c', 'g']);
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除此项及 2 个子项', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['s']);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.parentId ?? null]),
    )
    .toEqual([
      ['s', null],
      ['p', null],
      ['c', 'p'],
      ['g', 'c'],
    ]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+Shift+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['s']);
});

test('嵌套转非列表明确禁用，顶层父项转换保留并提升全部子列表且一次撤销', async ({
  page,
  workspace,
}) => {
  await place(page, '列表转换', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'ordered',
      text: '第一子项',
      parentId: 'p',
    },
    {
      id: 'g',
      type: 'listItem',
      listType: 'todo',
      checked: false,
      text: '孙项',
      parentId: 'c',
    },
    {
      id: 's',
      type: 'listItem',
      listType: 'ordered',
      text: '第二子项',
      parentId: 'p',
    },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '列表转换', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="c"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '转为段落', exact: true })).toBeDisabled();
  await expect(page.getByText('先减少缩进到顶层', { exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '转为待办列表', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[1]!.listType)
    .toBe('todo');
  expect((await workspace.state()).cards[0]!.body.blocks[1]!.parentId).toBe('p');
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await expect(page.getByText('子列表将保留在下方', { exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '转为段落', exact: true }).click();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [
        b.id,
        b.type,
        b.parentId ?? null,
      ]),
    )
    .toEqual([
      ['p', 'text', null],
      ['c', 'listItem', null],
      ['g', 'listItem', 'c'],
      ['s', 'listItem', null],
    ]);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await editor.press('Meta+z');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.parentId ?? null]),
    )
    .toEqual([
      ['p', null],
      ['c', 'p'],
      ['g', 'c'],
      ['s', 'p'],
    ]);
});

test('父列表Enter在整组后新建同级，空子项Enter减层且Backspace先退列表', async ({
  page,
  workspace,
}) => {
  await place(page, '列表按键', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'ordered', text: 'ABCD' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'ordered',
      text: '子项',
      parentId: 'p',
    },
    {
      id: 'g',
      type: 'listItem',
      listType: 'todo',
      checked: false,
      text: '孙项',
      parentId: 'c',
    },
    { id: 's', type: 'listItem', listType: 'ordered', text: '下一同级' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '列表按键', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="p"]').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.text, b.parentId ?? null]),
    )
    .toEqual([
      ['AB', null],
      ['子项', 'p'],
      ['孙项', 'c'],
      ['CD', null],
      ['下一同级', null],
    ]);
  await expect(editor.locator('[data-block-id="s"]')).toHaveAttribute('data-ordinal', '3');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [
        b.type,
        b.text,
        b.parentId ?? null,
      ]),
    )
    .toEqual([
      ['listItem', 'AB', null],
      ['listItem', '子项', 'p'],
      ['listItem', '孙项', 'c'],
      ['listItem', 'CD', null],
      ['listItem', '', null],
      ['listItem', '下一同级', null],
    ]);
  await page.keyboard.press('Backspace');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[4]!.type)
    .toBe('text');
});
