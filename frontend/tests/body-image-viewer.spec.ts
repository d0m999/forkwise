import { test, expect, place } from "./writing-board-fixture";
test.use({ actionTimeout: 6000 });
test("正文大图实际尺寸fit/100%/缩放和平移，关闭恢复结构阅读锚点与焦点，重开重置", async ({
  page,
  workspace,
}) => {
  await place(page, "大图阅读");
  const state = await workspace.state(),
    card = state.cards[0]!;
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: "asset.save",
    expected: null,
    payload: {
      id: "large",
      name: "大图.svg",
      mime: "image/svg+xml",
      base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#537364"/><circle cx="1200" cy="800" r="500" fill="#f3ac64"/></svg>',
      ).toString("base64"),
    },
  });
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: "body.edit",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        ...Array.from({ length: 14 }, (_, i) => ({
          id: `text-${i}`,
          type: "text",
          text: `阅读段落 ${i}：保留结构位置。`.repeat(8),
        })),
        {
          id: "large-block",
          type: "image",
          assetId: "large",
          name: "大图.svg",
          mime: "image/svg+xml",
          naturalWidth: 2400,
          naturalHeight: 1600,
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `tail-${i}`,
          type: "text",
          text: `后续段落 ${i}。`.repeat(8),
        })),
      ],
    },
  });
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const block = page.locator("[data-block-id=large-block]"),
    image = block.locator("img");
  await image.scrollIntoViewIfNeeded();
  await image.click();
  const before = await block.evaluate((el) => ({
    top: el.getBoundingClientRect().top,
    scroll: el.closest(".board-scroll")!.scrollTop,
  }));
  const revision = (await workspace.state()).project.revision;
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "正文大图", exact: true }),
    photo = viewer.locator("img");
  await expect(viewer).toBeVisible();
  const fit = await photo.boundingBox();
  expect(fit!.width).toBeLessThan(1360);
  expect(fit!.height).toBeLessThan(900);
  expect(fit!.width / fit!.height).toBeCloseTo(1.5, 2);
  await viewer.getByRole("button", { name: "100%", exact: true }).click();
  await expect.poll(async () => (await photo.boundingBox())!.width).toBe(2400);
  await viewer.getByRole("button", { name: "放大图片", exact: true }).click();
  expect((await photo.boundingBox())!.width).toBe(3000);
  const stage = viewer.locator(".body-image-stage"),
    bounds = (await stage.boundingBox())!,
    start = (await photo.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 95,
    bounds.y + bounds.height / 2 + 55,
    { steps: 6 },
  );
  await page.mouse.up();
  expect((await photo.boundingBox())!.x - start.x).toBeCloseTo(95, 0);
  expect((await photo.boundingBox())!.y - start.y).toBeCloseTo(55, 0);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(block).toBeFocused();
  expect((await block.boundingBox())!.y).toBeCloseTo(before.top, 0);
  expect((await workspace.state()).project.revision).toBe(revision);
  await image.dblclick();
  await expect(viewer).toBeVisible();
  expect((await photo.boundingBox())!.width).toBeLessThan(1360);
  await viewer.getByRole("button", { name: "关闭大图", exact: true }).click();
  await expect(block).toBeFocused();
});
