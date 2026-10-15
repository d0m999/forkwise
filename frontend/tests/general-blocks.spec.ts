import { test, expect, place } from './writing-board-fixture';

test('块菜单转为H2保留文字和身份，Enter后半段为段落，保存重开一致', async ({ page, workspace }) => {
  await place(page, '通用正文', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('ABCD');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).cards[0]!.body.blocks[0]!;
  await expect(page.getByRole('button', { name: '块菜单', exact: true })).toBeVisible({
    timeout: 2000,
  });
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '转为二级标题', exact: true }).click();
  await expect(editor.locator('h2')).toHaveText('ABCD');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.text]))
    .toEqual([
      ['heading', 'AB'],
      ['text', 'CD'],
    ]);
  expect((await workspace.state()).cards[0]!.body.blocks[0]!.id).toBe(original.id);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith('forkwise:recovery:v1:')),
      ),
    )
    .toEqual([]);
  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '通用正文', exact: true }).click();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor.locator('h2')).toHaveText('AB');
  await expect(editor.locator('p')).toHaveText('CD');
});

test('八类行内格式作用于原文字选区，每次单独撤销并保存重开和MCP完整读回', async ({
  page,
  workspace,
}) => {
  await place(page, '格式正文', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('中文🚀格式');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).cards[0]!.body.blocks[0]!;
  await editor.press('Meta+a');
  await expect(page.getByRole('toolbar', { name: '文字格式' })).toBeVisible({ timeout: 2000 });
  async function verifyUndo(type: string) {
    await expect
      .poll(
        async () =>
          (
            (await workspace.state()).cards[0]!.body.blocks[0]!.marks as
              | { type: string }[]
              | undefined
          )?.some((m) => m.type === type) ?? false,
      )
      .toBe(true);
    await editor.press('Meta+z');
    await expect
      .poll(
        async () =>
          (
            (await workspace.state()).cards[0]!.body.blocks[0]!.marks as
              | { type: string }[]
              | undefined
          )?.some((m) => m.type === type) ?? false,
      )
      .toBe(false);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+Shift+z');
    await expect
      .poll(
        async () =>
          (
            (await workspace.state()).cards[0]!.body.blocks[0]!.marks as
              | { type: string }[]
              | undefined
          )?.some((m) => m.type === type) ?? false,
      )
      .toBe(true);
    await expect(editor).toHaveAttribute('aria-readonly', 'false');
    await editor.press('Meta+a');
    await expect(page.getByRole('toolbar', { name: '文字格式' })).toBeVisible({ timeout: 2000 });
  }
  for (const [name, type] of [
    ['加粗', 'bold'],
    ['斜体', 'italic'],
    ['下划线', 'underline'],
    ['删除线', 'strikethrough'],
    ['行内代码', 'code'],
  ] as const) {
    if (['下划线', '删除线', '行内代码'].includes(name))
      await page.getByRole('button', { name: '格式更多', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await verifyUndo(type);
  }
  await page.getByRole('button', { name: '文字颜色', exact: true }).click();
  await page.getByRole('button', { name: '红色文字', exact: true }).click();
  await verifyUndo('textColor');
  await page.getByRole('button', { name: '格式更多', exact: true }).click();
  await page.getByRole('button', { name: '黄色高亮', exact: true }).click();
  await verifyUndo('highlight');
  await page.getByRole('button', { name: '链接', exact: true }).click();
  await page.getByLabel('链接地址', { exact: true }).fill('https://example.com/research');
  await page.getByRole('button', { name: '应用链接', exact: true }).click();
  await verifyUndo('link');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const state = await workspace.state(),
    saved = state.cards[0]!.body;
  expect(saved.blocks[0]!.id).toBe(original.id);
  expect(saved.blocks[0]!.inlineId).toBe(original.inlineId);
  expect((saved.blocks[0]!.marks as { type: string }[]).map((m) => m.type).sort()).toEqual([
    'bold',
    'code',
    'highlight',
    'italic',
    'link',
    'strikethrough',
    'textColor',
    'underline',
  ]);
  await page.screenshot({ path: test.info().outputPath('inline-formats.png') });
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '转为引用', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.type)
    .toBe('quote');
  expect((await workspace.state()).cards[0]!.body.blocks[0]!.marks).toEqual(saved.blocks[0]!.marks);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await workspace.restart();
  await workspace.open(page);
  const reopened = (await workspace.state()).cards[0]!;
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
  expect((await workspace.agentBody(state.project.id, reopened.id, snapshot!)).body).toEqual(
    reopened.body,
  );
});

test('加号和slash共用有限清单，空段复用、取消保原输入及顶层列表键盘退出', async ({
  page,
  workspace,
}) => {
  await place(page, '插入正文', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await expect(page.getByRole('button', { name: '插入块', exact: true })).toBeVisible({
    timeout: 2000,
  });
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  const names = await page.getByRole('menuitem').allTextContents();
  expect(names).toEqual([
    '段落',
    '一级标题',
    '二级标题',
    '三级标题',
    '引用',
    '无序列表',
    '有序列表',
    '待办列表',
    '分隔线',
    '简单表格',
    '代码块',
  ]);
  await page.getByRole('menuitem', { name: '有序列表', exact: true }).click();
  await page.keyboard.insertText('条目');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('第二条');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('/引用');
  await expect(page.getByRole('menuitem', { name: '引用', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toContainText('/引用');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('/');
  expect(await page.getByRole('menuitem').allTextContents()).toEqual(names);
  await page.keyboard.insertText('待办');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('完成任务');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.listType, b.text]),
    )
    .toEqual([
      ['listItem', 'ordered', '条目'],
      ['listItem', 'ordered', '第二条'],
      ['listItem', 'todo', '完成任务'],
    ]);
});

test('有序条目连续编号，待办切换与分隔线插入各自保存并一次撤销', async ({ page, workspace }) => {
  await place(page, '列表与分隔线', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.insertText('/有序');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('一');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('二');
  expect(
    await editor
      .locator('[data-list-type=ordered]')
      .evaluateAll((items) => items.map((e) => getComputedStyle(e, '::before').content)),
  ).toEqual(['"1."', '"2."']);
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '转为待办列表', exact: true }).click();
  await page.getByRole('button', { name: '标为完成', exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[1]!.checked)
    .toBe(true);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[1]!.checked)
    .toBe(false);
  await editor.press('End');
  await editor.press('Enter');
  await editor.press('Enter');
  await page.keyboard.insertText('/分隔');
  await page.keyboard.press('Enter');
  await expect(editor.locator('hr')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const blocks = (await workspace.state()).cards[0]!.body.blocks;
  expect(blocks.map((b) => b.type)).toEqual(['listItem', 'listItem', 'divider', 'text']);
  await editor.press('Backspace');
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(blocks);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.at(-1)?.text)
    .toBe('/分隔');
  await workspace.restart();
  await workspace.open(page);
  expect((await workspace.state()).cards[0]!.body.blocks.at(-1)?.text).toBe('/分隔');
});

test('软换行替换选区会裁剪格式，撤销恢复文字格式与原身份', async ({ page, workspace }) => {
  await place(page, '软换行格式', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('格式AB');
  await editor.press('Meta+a');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = (await workspace.state()).cards[0]!.body.blocks;
  await editor.press('Shift+Enter');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.text, b.marks ?? []]),
    )
    .toEqual([[before[0]!.id, '\n', []]]);
  await editor.press('Meta+z');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(before);
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await expect(editor.locator('strong')).toHaveText('格式AB');
});

test('链接快捷键绑定原选区，取消保留文字与既有链接，IME Enter不提交', async ({
  page,
  workspace,
}) => {
  await place(page, '链接选区', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('原文链接尾部');
  await editor.press('Home');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  await editor.press('Shift+ArrowRight');
  await editor.press('Shift+ArrowRight');
  await editor.press('Meta+k');
  const address = page.getByLabel('链接地址', { exact: true });
  await expect(address).toBeVisible({ timeout: 2000 });
  await address.fill('https://example.com/one');
  await address.dispatchEvent('compositionstart');
  await address.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  await expect(address).toBeVisible();
  await address.dispatchEvent('compositionend');
  await page.getByRole('button', { name: '应用链接', exact: true }).click();
  await expect(editor.locator('a')).toHaveText('链接');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = (await workspace.state()).cards[0]!.body;
  await editor.press('Meta+k');
  await expect(address).toBeVisible();
  await address.fill('https://example.com/cancelled');
  await page.getByRole('button', { name: '取消链接', exact: true }).click();
  expect((await workspace.state()).cards[0]!.body).toEqual(before);
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/one');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('链接');
});

test('slash菜单IME优先且点正文外部取消保留原文，方向键成功消费命令', async ({
  page,
  workspace,
}) => {
  await place(page, '菜单优先级', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.insertText('/');
  await editor.dispatchEvent('compositionstart');
  for (const key of ['ArrowDown', 'Enter', 'Escape'])
    await editor.dispatchEvent('keydown', { key, keyCode: 229, isComposing: true });
  await expect(page.getByRole('menu', { name: '插入块类型' })).toBeVisible();
  await expect(editor).toHaveText('/');
  await editor.dispatchEvent('compositionend');
  await editor.locator('p').click();
  await expect(page.getByRole('menu', { name: '插入块类型' })).toHaveCount(0);
  await expect(editor).toHaveText('/');
  await editor.press('Meta+a');
  await editor.press('Backspace');
  await page.keyboard.insertText('/');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(editor.locator('h1')).toHaveText('');
  await page.keyboard.insertText('新标题');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(
    (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.level, b.text]),
  ).toEqual([['heading', 1, '新标题']]);
});

test('格式落盘仍等ACK，旧ACK不清除新格式草稿，最后确认后恢复区清空再重开', async ({
  page,
  workspace,
}) => {
  await place(page, '格式回执', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('原卡内容');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let releaseFirst!: () => void,
    releaseSecond!: () => void,
    count = 0,
    written = 0;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  await page.route('**/api/mapping/execute', async (route) => {
    if (route.request().postDataJSON().type !== 'body.edit') return route.continue();
    const index = ++count,
      response = await route.fetch();
    written = index;
    if (index === 1) await first;
    if (index === 2) await second;
    await route.fulfill({ response });
  });
  const recovery = () =>
    page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith('forkwise:recovery:v1:'))
        .map(([, value]) => JSON.parse(value)),
    );
  try {
    await editor.press('Meta+a');
    await page.getByRole('button', { name: '加粗', exact: true }).click();
    await expect.poll(() => written).toBe(1);
    await expect(page.getByRole('status')).not.toHaveText('已保存到本机');
    expect(
      (await recovery())[0].pending.blocks[0].marks.map((m: { type: string }) => m.type),
    ).toEqual(['bold']);
    await page.getByRole('button', { name: '斜体', exact: true }).click();
    releaseFirst();
    await expect.poll(() => written).toBe(2);
    await expect(page.getByRole('status')).not.toHaveText('已保存到本机');
    expect(
      (await recovery())[0].pending.blocks[0].marks.map((m: { type: string }) => m.type),
    ).toEqual(['bold', 'italic']);
    await expect(editor.locator('strong em')).toHaveText('原卡内容');
    releaseSecond();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect.poll(recovery).toEqual([]);
    await page.unrouteAll({ behavior: 'wait' });
    const saved = (await workspace.state()).cards[0]!.body;
    await workspace.restart();
    await workspace.open(page);
    expect((await workspace.state()).cards[0]!.body).toEqual(saved);
  } finally {
    releaseFirst();
    releaseSecond();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('同步改变原目标后取消块菜单和文字选区并提示，不把操作应用到新内容', async ({
  page,
  workspace,
}) => {
  await place(page, '失效目标', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('原文字');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const replace = async (text: string) => {
    const state = await workspace.state(),
      card = state.cards[0]!;
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: state.project.id,
      type: 'body.edit',
      expected: card.body.versionId,
      payload: { id: card.id, blocks: [{ ...card.body.blocks[0]!, text }] },
    });
    await expect(editor).toHaveText(text);
  };
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await replace('外部第一版');
  await expect(page.getByRole('menu', { name: '转换块类型' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('原目标已失效');
  await editor.press('Meta+a');
  await expect(page.getByRole('toolbar', { name: '文字格式' })).toBeVisible();
  await replace('外部第二版');
  await expect(page.getByRole('toolbar', { name: '文字格式' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('原文字选区已失效');
  const saved = (await workspace.state()).cards[0]!.body.blocks[0]!;
  expect([saved.type, saved.text, saved.marks]).toEqual(['text', '外部第二版', undefined]);
});

test('悬停显示当前块插入入口，统一菜单分组与筛选可由键盘操作', async ({ page, workspace }) => {
  await place(page, '按需入口', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await expect(page.getByRole('toolbar', { name: '文字格式' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '插入块', exact: true })).toHaveCount(0);
  await editor.locator('p').hover();
  await expect(page.getByRole('button', { name: '插入块', exact: true })).toBeVisible({
    timeout: 2000,
  });
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  await expect(
    page.getByRole('group', { name: '文字', exact: true }).getByRole('menuitem'),
  ).toHaveText(['段落', '一级标题', '二级标题', '三级标题', '引用']);
  await expect(
    page.getByRole('group', { name: '列表', exact: true }).getByRole('menuitem'),
  ).toHaveText(['无序列表', '有序列表', '待办列表']);
  await page.getByLabel('筛选块类型').fill('三级');
  await page.getByLabel('筛选块类型').press('Enter');
  await page.keyboard.insertText('键盘标题');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(
    (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.type, b.level, b.text]),
  ).toEqual([['heading', 3, '键盘标题']]);
});

for (const [name, shape] of [
  ['无序列表', 'bullet'],
  ['有序列表', 'ordered'],
  ['待办列表', 'todo'],
] as const) {
  test(`${name}中间Enter同级分块，块首Backspace先退类型再合并且保格式身份`, async ({
    page,
    workspace,
  }) => {
    await place(page, name + '键盘', 80, 120);
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.fill('ABCD');
    await editor.press('Meta+a');
    await page.getByRole('button', { name: '加粗', exact: true }).click();
    await page.getByRole('button', { name: '块菜单', exact: true }).click();
    await page.getByRole('menuitem', { name: '转为' + name, exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const before = (await workspace.state()).cards[0]!.body.blocks[0]!;
    await editor.press('Home');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('Enter');
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    let blocks = (await workspace.state()).cards[0]!.body.blocks;
    expect(blocks.map((b) => [b.type, b.listType, b.text, b.marks])).toEqual([
      ['listItem', shape, 'AB', [{ type: 'bold', start: 0, end: 2 }]],
      ['listItem', shape, 'CD', [{ type: 'bold', start: 0, end: 2 }]],
    ]);
    expect(blocks[0]!.id).toBe(before.id);
    expect(blocks[1]!.id).not.toBe(before.id);
    if (shape === 'todo') expect(blocks[1]!.checked).toBe(false);
    await editor.press('Backspace');
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    blocks = (await workspace.state()).cards[0]!.body.blocks;
    expect(blocks[1]!.type).toBe('text');
    expect(blocks).toHaveLength(2);
    await editor.press('Backspace');
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect((await workspace.state()).cards[0]!.body.blocks).toEqual([before]);
  });
}

test('空正文提示与窄窗口菜单可达，非空块加号在后插入且单次撤销', async ({
  page,
  workspace,
}, info) => {
  await page.setViewportSize({ width: 390, height: 660 });
  await place(page, '窄窗正文', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await expect(editor).toHaveAttribute('aria-placeholder', '输入文字，或用 / 插入');
  await expect(page.getByText('输入文字，或用 / 插入', { exact: true })).toBeVisible();
  await editor.fill('原块内容');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = (await workspace.state()).cards[0]!.body;
  await page.getByRole('button', { name: '块菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '转为段落', exact: true }).click();
  expect((await workspace.state()).cards[0]!.body).toEqual(before);
  await page.getByRole('button', { name: '插入块', exact: true }).click();
  const menu = page.getByRole('menu', { name: '插入块类型' });
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(660);
  await page.screenshot({ path: info.outputPath('narrow-insert-menu.png') });
  await page.getByRole('menuitem', { name: '引用', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const inserted = (await workspace.state()).cards[0]!.body.blocks;
  expect(inserted[0]).toEqual(before.blocks[0]);
  expect(inserted[1]).toMatchObject({ type: 'quote', text: '' });
  expect(inserted[1]!.id).not.toBe(before.blocks[0]!.id);
  await editor.press('Meta+z');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks)
    .toEqual(before.blocks);
});
