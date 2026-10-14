import { test, expect, place } from './writing-board-fixture';

test('父列表后插入分隔线及后续段落不拆散子树', async ({ page, workspace }) => {
  await place(page, '分隔线边界', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
        { id: 'c', type: 'listItem', listType: 'bullet', text: '子项', parentId: 'p' },
        { id: 'g', type: 'listItem', listType: 'bullet', text: '孙项', parentId: 'c' },
      ],
    },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '分隔线边界', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await page.getByRole('menuitem', { name: '分隔线', exact: true }).click();
  await page.keyboard.insertText('后续段落');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [
        b.type,
        b.text ?? '',
        b.parentId ?? null,
      ]),
    )
    .toEqual([
      ['listItem', '父项', null],
      ['listItem', '子项', 'p'],
      ['listItem', '孙项', 'c'],
      ['divider', '', null],
      ['text', '后续段落', null],
    ]);
});

test('空父项Enter保留后代，待办父项勾选独立且IME阻止折叠与缩进', async ({ page, workspace }) => {
  await place(page, '边界正文', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'todo', checked: false, text: '' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'todo',
      checked: false,
      text: '子项',
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
  await page.getByRole('button', { name: '边界正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '标为完成', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.checked))
    .toEqual([true, false]);
  await editor.locator('[data-block-id="p"]').click();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(3);
  const saved = (await workspace.state()).cards[0]!.body.blocks;
  expect(saved[0]!.id).toBe('p');
  expect(saved[1]!.parentId).toBe('p');
  expect(saved[2]!.type).toBe('listItem');
  expect(saved[2]!.checked).toBe(false);
  await editor.dispatchEvent('compositionstart');
  await page.getByRole('button', { name: '收起：空条目', exact: true }).click();
  await editor.dispatchEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    isComposing: true,
  });
  await expect(editor.locator('[data-block-id="c"]')).toBeVisible();
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(saved);
  await editor.dispatchEvent('compositionend');
});

test('嵌套列表加号插入同级项保父项，非列表子块入口禁用', async ({ page, workspace }) => {
  await place(page, '嵌套插入', 80, 120);
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
      id: 's',
      type: 'listItem',
      listType: 'bullet',
      text: '同级子项',
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
  await page.getByRole('button', { name: '嵌套插入', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="c"]').click();
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '段落', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '有序列表', exact: true }).click();
  await page.keyboard.insertText('新同级');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.text, b.parentId ?? null]),
    )
    .toEqual([
      ['父项', null],
      ['子项', 'p'],
      ['新同级', 'p'],
      ['同级子项', 'p'],
    ]);
});

test('含旧未知原件的章节仍可折叠阅读，隐藏不丢完整JSON或改变版本', async ({ page, workspace }) => {
  await place(page, '原件章节', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'h', type: 'heading', level: 1, text: '旧章节' },
    {
      id: 'opaque',
      type: 'vendor-block',
      data: { nested: ['完整原件'] },
      parentId: 'vendor-owner',
    },
    { id: 'next', type: 'heading', level: 1, text: '下一章' },
  ];
  await workspace.installOriginalBody(card.id, blocks);
  await workspace.open(page);
  await page.getByRole('button', { name: '原件章节', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const before = await workspace.state();
  await expect(page.getByRole('button', { name: '收起：旧章节', exact: true })).toBeVisible({
    timeout: 1500,
  });
  await page.getByRole('button', { name: '收起：旧章节', exact: true }).click();
  await expect(page.locator('.original-body [data-block-id="opaque"]')).toBeHidden();
  await expect(page.locator('.original-body [data-block-id="next"]')).toBeVisible();
  expect(await workspace.state()).toEqual(before);
  await page.getByRole('button', { name: '展开：旧章节', exact: true }).click();
  await expect(page.locator('.original-body [data-block-id="opaque"]')).toContainText('完整原件');
});

test('单独移动标题不搬正文并重新计算H3范围，列表移入折叠章节临时显示', async ({
  page,
  workspace,
}) => {
  await place(page, '范围边界', 80, 120);
  const state = await workspace.state(),
    card = state.cards[0]!;
  const blocks = [
    { id: 'p', type: 'listItem', listType: 'bullet', text: '移入项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
    { id: 'h', type: 'heading', level: 3, text: '三级标题' },
    { id: 't', type: 'text', text: '原正文' },
    { id: 'end', type: 'heading', level: 2, text: '边界' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '范围边界', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await page.getByRole('button', { name: '收起：三级标题', exact: true }).click();
  await expect(editor.locator('[data-block-id="t"]')).toBeHidden();
  await expect(editor.locator('[data-block-id="end"]')).toBeVisible();
  await editor.locator('[data-block-id="p"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['h', 'p', 'c', 't', 'end']);
  await expect(editor.locator('[data-block-id="p"]')).toBeVisible();
  await expect(editor.locator('[data-block-id="c"]')).toBeVisible();
  await editor.locator('[data-block-id="h"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['p', 'c', 'h', 't', 'end']);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('[data-block-id="p"]')).toBeVisible();
  await expect(editor.locator('[data-block-id="t"]')).toBeHidden();
  expect(await page.locator('.board-scroll').evaluate((el) => el.scrollTop)).toBe(0);
});
