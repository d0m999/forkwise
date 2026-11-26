import { test, expect, place } from "./writing-board-fixture";

const picture = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#537364"/><circle cx="600" cy="300" r="180" fill="#f3ac64"/></svg>',
);
async function insert(page: import("@playwright/test").Page) {
  await place(page, "图片阅读");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "完整比例.svg",
    mimeType: "image/svg+xml",
    buffer: picture,
  });
  const image = page.locator(".body-image img");
  await expect(image).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  return image;
}

test("正文图片期望宽保存、窄面板临时约束、一次手势一次撤销及自动适应", async ({
  page,
  workspace,
}) => {
  const image = await insert(page);
  const editor = page.getByRole("textbox", { name: "卡片正文", exact: true });
  const natural = await image.evaluate((i: HTMLImageElement) => ({
    width: i.naturalWidth,
    height: i.naturalHeight,
    box: i.getBoundingClientRect().toJSON(),
  }));
  expect(natural.width).toBe(1200);
  expect(natural.height).toBe(600);
  expect(natural.box.width).toBeLessThan(1200);
  expect(natural.box.width / natural.box.height).toBeCloseTo(2, 1);
  await page.getByRole("button", { name: "展开写字板", exact: true }).click();
  await image.click();
  const grip = page.getByRole("slider", {
    name: "调整正文图片宽度",
    exact: true,
  });
  await expect(grip).toBeVisible();
  const before = (await workspace.state()).project.revision;
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = (await workspace.state()).cards[0]!.body.blocks.find(
    (b) => b.type === "image",
  )!;
  expect(saved.width).toBeGreaterThan(400);
  expect(saved.width).toBeLessThan(760);
  expect((await workspace.state()).project.revision).toBe(before + 1);
  await page.getByRole("button", { name: "还原写字板", exact: true }).click();
  expect((await image.boundingBox())!.width).toBeLessThan(Number(saved.width));
  expect(
    (await workspace.state()).cards[0]!.body.blocks.find(
      (b) => b.type === "image",
    )!.width,
  ).toBe(saved.width);
  await page.getByRole("button", { name: "展开写字板", exact: true }).click();
  await expect
    .poll(async () => (await image.boundingBox())!.width)
    .toBeCloseTo(Number(saved.width), 0);
  await image.click();
  await grip.click();
  expect((await workspace.state()).project.revision).toBe(before + 1);
  await editor.press("Meta+z");
  await expect
    .poll(
      async () =>
        (await workspace.state()).cards[0]!.body.blocks.find(
          (b) => b.type === "image",
        )!.width,
    )
    .toBeUndefined();
  // A committed SQLite undo can precede its ACK and the UI history unlock.
  await expect(editor).toHaveAttribute("aria-readonly", "false");
  await editor.press("Meta+Shift+z");
  await expect
    .poll(
      async () =>
        (await workspace.state()).cards[0]!.body.blocks.find(
          (b) => b.type === "image",
        )!.width,
    )
    .toBe(saved.width);
  await workspace.restart();
  await workspace.open(page);
  expect(
    (await workspace.state()).cards[0]!.body.blocks.find(
      (b) => b.type === "image",
    )!.width,
  ).toBe(saved.width);
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.locator(".body-image img").click();
  await page.getByRole("button", { name: "自动适应", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await workspace.state()).cards[0]!.body.blocks.find(
          (b) => b.type === "image",
        )!.width,
    )
    .toBeUndefined();
});

for (const folded of [false, true]) {
  test(`正文图片拖宽保存后留在原阅读位置${folded ? '，前置章节保持折叠' : ''}`, async ({ page, workspace }) => {
    await place(page, '正文图片调宽阅读');
    const state = await workspace.state(), card = state.cards[0]!;
    const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
      commandId: crypto.randomUUID(), projectId: state.project.id, type, payload, expected,
    });
    await execute('asset.save', { id: 'reading-image', name: '图文段落.svg', mime: 'image/svg+xml', base64: picture.toString('base64') });
    await execute('body.edit', { id: card.id, blocks: [
      ...(folded ? [
        { id: 'fold-heading', type: 'heading', level: 1, text: '预先收起的章节' },
        { id: 'fold-text', type: 'text', text: '折叠之后不占高度。'.repeat(100) },
        { id: 'open-heading', type: 'heading', level: 1, text: '正在阅读的章节' },
      ] : []),
      ...Array.from({ length: 9 }, (_, i) => ({ id: `before-${i}`, type: 'text', text: `第 ${i} 段，记录当前阅读位置。`.repeat(6) })),
      { id: 'reading-photo', type: 'image', assetId: 'reading-image', name: '图文段落.svg', mime: 'image/svg+xml', naturalWidth: 1200, naturalHeight: 600, width: 300 },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `after-${i}`, type: 'text', text: '图片后面的段落。'.repeat(12) })),
    ] }, card.body.versionId);
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const block = page.locator('[data-block-id="reading-photo"]'), image = block.locator('img');
    if (folded) {
      await page.getByRole('button', { name: '收起：预先收起的章节', exact: true }).click();
      await expect(page.locator('[data-block-id="fold-text"]')).toBeHidden();
    }
    await expect(image).toHaveJSProperty('naturalWidth', 1200);
    const target = await image.evaluate(el => {
      const scroll = el.closest('.board-scroll')!;
      scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 100;
      const bounds = el.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      return { x, y, visible: document.elementFromPoint(x, y) === el };
    });
    expect(target.visible).toBe(true);
    await page.mouse.click(target.x, target.y);
    const scrollState = () => image.evaluate(el => ({ top: el.getBoundingClientRect().top, scroll: el.closest('.board-scroll')!.scrollTop }));
    const before = await scrollState();
    expect(before.scroll).toBeGreaterThan(200);
    const beforeRevision = (await workspace.state()).project.revision;
    const grip = page.getByRole('slider', { name: '调整正文图片宽度' });
    const bounds = (await grip.boundingBox())!;
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 55, y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.find(b => b.id === 'reading-photo')!.width).toBe(245);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const resized = await scrollState();
    expect(Math.abs(resized.top - before.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(resized.scroll - before.scroll)).toBeLessThanOrEqual(1);
    const revision = (await workspace.state()).project.revision;
    expect(revision).toBe(beforeRevision + 1);
    if (folded) await expect(page.locator('[data-block-id="fold-text"]')).toBeHidden();
    await page.getByRole('button', { name: '查看大图', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(block).toBeFocused();
    expect(await scrollState()).toEqual(resized);
    expect((await workspace.state()).project.revision).toBe(revision);
  });
}
