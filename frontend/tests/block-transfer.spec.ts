import { test, expect, place } from './writing-board-fixture';
import { preserveClipboard } from './clipboard-fixture';

test.use({ actionTimeout: 6000 });

test('创建列表副本保留格式和内部层级，生成新身份，一次撤销并持久重开', async ({
  page,
  workspace,
}) => {
  await place(page, '块副本');
  const state = await workspace.state(),
    card = state.cards[0]!;
  const originals = [
    {
      id: 'parent',
      inlineId: 'ip',
      type: 'listItem',
      listType: 'bullet',
      text: '父项',
      marks: [{ type: 'bold', start: 0, end: 2 }],
    },
    {
      id: 'child',
      inlineId: 'ic',
      type: 'listItem',
      listType: 'todo',
      checked: true,
      text: '子项',
      parentId: 'parent',
    },
    { id: 'tail', type: 'text', text: '尾段' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: originals },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '块副本', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.locator('[data-block-id="parent"]').click();
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '创建副本', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(5);
  const copied = (await workspace.state()).cards[0]!.body.blocks;
  expect(copied.slice(0, 2)).toEqual(originals.slice(0, 2));
  expect(copied[2]!.id).not.toBe('parent');
  expect(copied[2]!.inlineId).not.toBe('ip');
  expect(copied[2]!.marks).toEqual(originals[0]!.marks);
  expect(copied[3]!.id).not.toBe('child');
  expect(copied[3]!.parentId).toBe(copied[2]!.id);
  expect(copied[3]!.checked).toBe(true);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(originals);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(copied);
  await editor.locator(`[data-block-id="${copied[2]!.id}"]`).fill('仅修改副本');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[2]!.text)
    .toBe('仅修改副本');
  expect((await workspace.state()).cards[0]!.body.blocks[0]!.text).toBe('父项');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(copied);
  await workspace.restart();
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(copied);
});

test('跨层连续范围副本只重建选区内父子，外部父项不带入副本', async ({ page, workspace }) => {
  await place(page, '跨层范围');
  const state = await workspace.state(),
    card = state.cards[0]!;
  const originals = [
    { id: 'p', type: 'listItem', listType: 'bullet', text: '外部父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '子项',
      parentId: 'p',
    },
    { id: 'z', type: 'text', text: '尾段' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: originals },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '跨层范围', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '选择块：子项', exact: true }).click();
  await page
    .getByRole('button', { name: '选择块：尾段', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('menuitem', { name: '创建副本', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(5);
  expect(
    (await workspace.state()).cards[0]!.body.blocks.slice(3).map((b) => [
      b.text,
      b.parentId ?? null,
    ]),
  ).toEqual([
    ['子项', null],
    ['尾段', null],
  ]);
});

test('未知原件和已有媒体可明确复制副本，保原文资源引用且撤销重开完整', async ({
  page,
  workspace,
}) => {
  await place(page, '未知块复制');
  const state = await workspace.state(),
    card = state.cards[0]!;
  const originals = [
    { id: 'p', type: 'text', text: '已知段落' },
    {
      id: 'raw',
      type: 'vendor',
      parentId: 'vendor-parent',
      original: { text: '未知原文🚀', nested: [null, { keep: true }] },
    },
    { id: 'image', type: 'image', assetId: 'saved-asset', caption: '保留图注' },
  ];
  await workspace.installOriginalBody(card.id, originals);
  await workspace.open(page);
  await page.getByRole('button', { name: '未知块复制', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '选择块：vendor', exact: true }).click();
  await page
    .getByRole('button', { name: '选择块：image', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('menuitem', { name: '创建副本', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(5);
  const copied = (await workspace.state()).cards[0]!.body.blocks;
  expect(copied.slice(0, 3)).toEqual(originals);
  expect({ ...copied[3], id: 'raw' }).toEqual(originals[1]);
  expect({ ...copied[4], id: 'image' }).toEqual(originals[2]);
  expect(copied[3]!.id).not.toBe('raw');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(originals);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(copied);
  await workspace.restart();
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(copied);
});

test('剪贴板拒绝保留原文与历史；显式块选区Delete全删留空段并一次撤销', async ({
  page,
  workspace,
}) => {
  await place(page, '失败与全删');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('必须保留的原文');
  await expect(page.getByRole('status').last()).toHaveText('已保存到本机');
  const before = await workspace.state();
  // Inject only the OS/browser permission boundary, never our internal editor.
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    }),
  );
  const handle = page.getByRole('button', {
    name: '选择块：必须保留的原文',
    exact: true,
  });
  await handle.click();
  await page.getByRole('menuitem', { name: '剪切所选块', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('剪贴板写入失败，原文已保留');
  expect(await workspace.state()).toEqual(before);
  await handle.focus();
  await page.keyboard.press('Delete');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]),
    )
    .toEqual([['text', '']]);
  expect((await workspace.state()).cards[0]!.id).toBe(before.cards[0]!.id);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(before.cards[0]!.body.blocks);
});

test('连续列表整组缩进和键盘排序，后代去重且每动作一次撤销', async ({ page, workspace }) => {
  await place(page, '批量缩进');
  const state = await workspace.state(),
    card = state.cards[0]!;
  const originals = [
    { id: 'a', type: 'listItem', listType: 'bullet', text: '上一父项' },
    { id: 'b', type: 'listItem', listType: 'bullet', text: '乙' },
    {
      id: 'bc',
      type: 'listItem',
      listType: 'bullet',
      text: '乙子',
      parentId: 'b',
    },
    { id: 'c', type: 'listItem', listType: 'bullet', text: '丙' },
    {
      id: 'cc',
      type: 'listItem',
      listType: 'bullet',
      text: '丙子',
      parentId: 'c',
    },
    { id: 'z', type: 'text', text: '尾段' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: originals },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '批量缩进', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '选择块：乙', exact: true }).click();
  await page
    .getByRole('button', { name: '选择块：丙', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('menuitem', { name: '增加缩进', exact: true }).click();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.parentId ?? null]),
    )
    .toEqual([
      ['a', null],
      ['b', 'a'],
      ['bc', 'b'],
      ['c', 'a'],
      ['cc', 'c'],
      ['z', null],
    ]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(originals);
  const handle = page.getByRole('button', { name: '选择块：乙', exact: true });
  await handle.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['a', 'c', 'cc', 'b', 'bc', 'z']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(originals);
});

test('真实浏览器剪贴板复制粘贴保结构且剪切成功才删除', async ({ page, workspace }, info) => {
  await place(page, '真实剪贴板');
  const state = await workspace.state(),
    card = state.cards[0]!;
  const originals = [
    {
      id: 'p',
      inlineId: 'ip',
      type: 'listItem',
      listType: 'bullet',
      text: '父项',
      marks: [{ type: 'bold', start: 0, end: 2 }],
    },
    {
      id: 'c',
      inlineId: 'ic',
      type: 'listItem',
      listType: 'todo',
      checked: true,
      text: '子项',
      parentId: 'p',
    },
    { id: 'z', type: 'text', text: '尾段' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: originals },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '真实剪贴板', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const guard = await preserveClipboard(page, info);
  try {
    await page.getByRole('button', { name: '选择块：父项', exact: true }).click();
    await page.getByRole('menuitem', { name: '复制所选块', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('父项\n子项');
    await info.attach('actual-clipboard-api', {
      body: JSON.stringify(await guard.wrote('父项\n子项')),
      contentType: 'application/json',
    });
    expect((await workspace.state()).cards[0]!.body.blocks).toEqual(originals);
    await editor.locator('[data-block-id="z"]').click();
    await page.keyboard.press('Meta+End');
    await page.keyboard.press('Meta+v');
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks.length)
      .toBe(5);
    const pasted = (await workspace.state()).cards[0]!.body.blocks;
    expect(pasted.slice(3).map((b) => b.text)).toEqual(['父项', '子项']);
    expect(pasted[3]!.id).not.toBe('p');
    expect(pasted[3]!.inlineId).not.toBe('ip');
    expect(pasted[4]!.parentId).toBe(pasted[3]!.id);
    expect(pasted[3]!.marks).toEqual(originals[0]!.marks);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
      .toEqual(originals);
    await page.getByRole('button', { name: '选择块：父项', exact: true }).click();
    await page.getByRole('menuitem', { name: '剪切所选块', exact: true }).click();
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
      .toEqual(['z']);
    await guard.wrote('父项\n子项');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
      .toEqual(originals);
  } finally {
    await guard.restore();
  }
});

test('柄拖动6px才启动，整组落点和取消均遵守统一历史', async ({ page, workspace }) => {
  await place(page, '安全拖动');
  const state = await workspace.state(),
    card = state.cards[0]!;
  const originals = [
    { id: 'a', type: 'text', text: '前段' },
    { id: 'p', type: 'listItem', listType: 'bullet', text: '拖动父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'ordered',
      text: '拖动子项',
      parentId: 'p',
    },
    { id: 'z', type: 'text', text: '尾段' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: originals },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '安全拖动', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const handle = page.getByRole('button', {
    name: '选择块：拖动父项',
    exact: true,
  });
  const h = await handle.boundingBox(),
    z = await editor.locator('[data-block-id="z"]').boundingBox();
  const x = h!.x + h!.width / 2,
    y = h!.y + h!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y);
  await expect(editor.locator('[data-block-dragging="true"]')).toHaveCount(0);
  await page.mouse.move(x + 6, y);
  await expect(editor.locator('[data-block-dragging="true"]')).toHaveCount(2);
  await page.mouse.move(z!.x + 3, z!.y + z!.height - 2);
  await expect(page.getByLabel('块落点', { exact: true })).toContainText('第 1 层');
  await page.mouse.up();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => b.id))
    .toEqual(['a', 'z', 'p', 'c']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(originals);
  const before = await workspace.state();
  const h2 = await handle.boundingBox();
  await page.mouse.move(h2!.x + 10, h2!.y + 10);
  await page.mouse.down();
  await page.mouse.move(z!.x + 4, z!.y + z!.height - 2);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await workspace.state()).project.revision).toBe(before.project.revision);
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(originals);
  await expect(editor.locator('[data-block-dragging="true"]')).toHaveCount(0);
});

test('Shift柄连续选择含折叠后代且去重，文字拖选不触发块选择', async ({ page, workspace }) => {
  await place(page, '连续范围');
  const state = await workspace.state(),
    card = state.cards[0]!;
  const originals = [
    { id: 'a', type: 'text', text: '开头文字可拖选' },
    { id: 'p', type: 'listItem', listType: 'bullet', text: '父项' },
    {
      id: 'c',
      type: 'listItem',
      listType: 'bullet',
      text: '隐藏子项',
      parentId: 'p',
    },
    { id: 'z', type: 'text', text: '结束' },
  ];
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: 'body.edit',
    expected: card.body.versionId,
    payload: { id: card.id, blocks: originals },
  });
  await workspace.open(page);
  await page.getByRole('button', { name: '连续范围', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const a = await editor.locator('[data-block-id="a"]').boundingBox();
  await page.mouse.move(a!.x + 2, a!.y + 8);
  await page.mouse.down();
  await page.mouse.move(a!.x + 75, a!.y + 8, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString())).not.toBe('');
  await expect(editor.locator('[data-block-selected="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: '收起：父项', exact: true }).click();
  await page.getByRole('button', { name: '选择块：开头文字可拖选', exact: true }).click();
  await page
    .getByRole('button', { name: '选择块：结束', exact: true })
    .click({ modifiers: ['Shift'] });
  await expect(page.getByText('已选择 4 个块', { exact: true })).toBeVisible();
  await expect(page.getByText(/包含 1 个隐藏块/)).toBeVisible();
  await page.getByRole('menuitem', { name: '创建副本', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.length).toBe(8);
  const saved = (await workspace.state()).cards[0]!.body.blocks;
  expect(saved.slice(4).map((b) => b.text)).toEqual([
    '开头文字可拖选',
    '父项',
    '隐藏子项',
    '结束',
  ]);
  expect(saved[6]!.parentId).toBe(saved[5]!.id);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(originals);
});
