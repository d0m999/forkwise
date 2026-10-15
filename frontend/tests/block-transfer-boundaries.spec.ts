import { test, expect, place, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import type { Block } from '../../backend/src/mapping/contracts';
import { preserveClipboard } from './clipboard-fixture';

test.use({ actionTimeout: 6000 });
async function body(page: Page, workspace: Workspace, blocks: Block[]) {
  await place(page, '边界正文');
  const state = await workspace.state(),
    card = state.cards[0]!;
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
  return page.getByRole('textbox', { name: '卡片正文', exact: true });
}
const list: Block[] = [
  { id: 'p', inlineId: 'ip', type: 'listItem', listType: 'bullet', text: '父' },
  {
    id: 'c',
    inlineId: 'ic',
    type: 'listItem',
    listType: 'bullet',
    text: '子',
    parentId: 'p',
  },
  {
    id: 'q',
    inlineId: 'iq',
    type: 'listItem',
    listType: 'bullet',
    text: '目标父项',
  },
  { id: 'z', inlineId: 'iz', type: 'text', text: '尾段' },
];

test('合成组合输入期间块柄不启动拖动或结构历史', async ({ page, workspace }) => {
  const editor = await body(page, workspace, list),
    before = await workspace.state();
  await editor.dispatchEvent('compositionstart');
  const h = await page.getByRole('button', { name: '选择块：父', exact: true }).boundingBox();
  const z = await editor.locator('[data-block-id="z"]').boundingBox();
  await page.mouse.move(h!.x + 10, h!.y + 10);
  await page.mouse.down();
  await page.mouse.move(z!.x + 3, z!.y + z!.height - 2);
  await expect(editor.locator('[data-block-dragging="true"]')).toHaveCount(0);
  await page.mouse.up();
  await editor.dispatchEvent('compositionend');
  expect(await workspace.state()).toEqual(before);
});

test('文字操作取消旧块区，Shift柄从新锚点开始；多块不偷偷转换单块', async ({
  page,
  workspace,
}) => {
  const editor = await body(page, workspace, [
    { id: 'a', type: 'text', text: '甲' },
    { id: 'b', type: 'text', text: '乙' },
    { id: 'c', type: 'text', text: '丙' },
  ]);
  await page.getByRole('button', { name: '选择块：甲', exact: true }).click();
  await editor.locator('[data-block-id="b"]').click();
  await page
    .getByRole('button', { name: '选择块：丙', exact: true })
    .click({ modifiers: ['Shift'] });
  await expect(page.getByText('已选择 1 个块', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: '选择块：乙', exact: true })
    .click({ modifiers: ['Shift'] });
  await expect(page.getByText('已选择 2 个块', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: '转为一级标题', exact: true }),
  ).toBeDisabled();
});

test('列表落点明示目标父项和层级；禁入自身后代，拖出正文与中断不写历史', async ({
  page,
  workspace,
}) => {
  const editor = await body(page, workspace, list);
  const handle = page.getByRole('button', { name: '选择块：父', exact: true });
  async function start() {
    const h = await handle.boundingBox();
    await page.mouse.move(h!.x + 10, h!.y + 10);
    await page.mouse.down();
  }
  const q = await editor.locator('[data-block-id="q"]').boundingBox();
  await start();
  await page.mouse.move(q!.x + 30, q!.y + q!.height - 2);
  await expect(page.getByLabel('块落点', { exact: true })).toContainText(
    '第 2 层 · 父项：目标父项',
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.map((b) => [b.id, b.parentId ?? null]),
    )
    .toEqual([
      ['q', null],
      ['p', 'q'],
      ['c', 'p'],
      ['z', null],
    ]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks).toEqual(list);
  const before = await workspace.state();
  const c = await editor.locator('[data-block-id="c"]').boundingBox();
  await start();
  await page.mouse.move(c!.x + 28, c!.y + c!.height - 2);
  await expect(page.getByLabel('块落点', { exact: true })).toHaveCount(0);
  await page.mouse.up();
  expect(await workspace.state()).toEqual(before);
  for (const interruption of ['outside', 'pointercancel', 'blur']) {
    await start();
    await page.mouse.move(q!.x + 3, q!.y + q!.height - 2);
    if (interruption === 'outside') await page.mouse.move(100, 100);
    else if (interruption === 'pointercancel')
      await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel')));
    else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await expect(editor.locator('[data-block-dragging="true"]')).toHaveCount(0);
    expect(await workspace.state()).toEqual(before);
  }
});

test('长正文底部边缘持续自动滚动，取消保留同一版本', async ({ page, workspace }) => {
  const blocks: Block[] = Array.from({ length: 90 }, (_, i) => ({
    id: `p${i}`,
    type: 'text',
    text: `段落 ${i}`,
  }));
  const editor = await body(page, workspace, blocks),
    before = await workspace.state();
  const h = await page
    .getByRole('button', { name: '选择块：段落 0', exact: true })
    .boundingBox();
  const scroll = page.locator('.board-scroll'),
    clip = await scroll.boundingBox(),
    area = await editor.boundingBox();
  await page.mouse.move(h!.x + 10, h!.y + 10);
  await page.mouse.down();
  await page.mouse.move(area!.x + 3, clip!.y + clip!.height - 12);
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
  await page.mouse.move(100, 100);
  await page.mouse.up();
  expect(await workspace.state()).toEqual(before);
});

test('剪切等待外部写入时正文已改或编辑区关闭，晚到成功不删除新内容', async ({
  page,
  workspace,
}) => {
  const editor = await body(page, workspace, [
    { id: 'p', inlineId: 'ip', type: 'text', text: '原文' },
  ]);
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: () =>
        new Promise<void>((resolve) => {
          (window as any).resolveClipboard = resolve;
        }),
    }),
  );
  await page.getByRole('button', { name: '选择块：原文', exact: true }).click();
  await page.getByRole('menuitem', { name: '剪切所选块', exact: true }).click();
  await editor.fill('原文已继续输入');
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text)
    .toBe('原文已继续输入');
  const before = await workspace.state();
  await page.evaluate(() => (window as any).resolveClipboard());
  await expect(page.getByRole('alert')).toContainText('已复制但未剪切');
  expect(await workspace.state()).toEqual(before);
  await page.getByRole('button', { name: '选择块：原文已继续输入', exact: true }).click();
  await page.getByRole('menuitem', { name: '剪切所选块', exact: true }).click();
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await page.evaluate(() => (window as any).resolveClipboard());
  expect(await workspace.state()).toEqual(before);
});

test('真实剪贴板将未知JSON与资源引用粘到同项目另一正文，原件仍完整', async ({
  page,
  workspace,
}, info) => {
  await place(page, '原件卡', 80, 120);
  await place(page, '目标卡', 420, 120);
  let state = await workspace.state();
  const source = state.cards.find((c) => c.title === '原件卡')!,
    target = state.cards.find((c) => c.title === '目标卡')!;
  const originals: Block[] = [
    {
      id: 'raw',
      type: 'vendor',
      parentId: 'vendor-owner',
      original: { text: '原文', nested: [null, true] },
    },
    { id: 'asset', type: 'image', assetId: 'saved-image', caption: '图注' },
  ];
  await workspace.installOriginalBody(source.id, originals);
  await workspace.open(page);
  const targetNode = page
    .locator('.react-flow__node')
    .filter({ has: page.getByRole('button', { name: '目标卡', exact: true }) });
  const sourceNode = page
    .locator('.react-flow__node')
    .filter({ has: page.getByRole('button', { name: '原件卡', exact: true }) });
  await targetNode.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('目标文字');
  await expect
    .poll(
      async () =>
        (await workspace.state()).cards.find((c) => c.id === target.id)!.body.blocks[0]!.text,
    )
    .toBe('目标文字');
  await sourceNode.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.getByLabel('只读正文原件')).toBeVisible();
  const guard = await preserveClipboard(page, info);
  try {
    await page.getByRole('button', { name: '选择块：vendor', exact: true }).click();
    await page
      .getByRole('button', { name: '选择块：image', exact: true })
      .click({ modifiers: ['Shift'] });
    await page.getByRole('menuitem', { name: '复制所选块', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('[vendor]\n[image]');
    await guard.wrote('[vendor]\n[image]');
    await targetNode.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.click();
    await page.keyboard.press('Meta+End');
    await page.keyboard.press('Meta+v');
    await expect
      .poll(
        async () =>
          (await workspace.state()).cards.find((c) => c.id === target.id)!.body.blocks.length,
      )
      .toBe(3);
    state = await workspace.state();
    const copied = state.cards.find((c) => c.id === target.id)!.body.blocks;
    expect({ ...copied[1], id: 'raw' }).toEqual(originals[0]);
    expect({ ...copied[2], id: 'asset' }).toEqual(originals[1]);
    expect(state.cards.find((c) => c.id === source.id)!.body.blocks).toEqual(originals);
    const snapshot = await page.locator('.workspace').getAttribute('data-snapshot');
    // The browser view and Agent expansion read the same committed revision.
    const map = await workspace.agentBody(state.project.id, target.id, snapshot!);
    expect(map.body.blocks).toEqual(copied);
    expect(map.revision).toBe(state.project.revision);
  } finally {
    await guard.restore();
  }
});
