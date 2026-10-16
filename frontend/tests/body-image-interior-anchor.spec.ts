import { test, expect, place } from "./writing-board-fixture";
test.use({ actionTimeout: 6000 });
test("高图内部阅读点在真实宽高变化和大图关闭后仍指向同一原图位置", async ({
  page,
  workspace,
}, info) => {
  await place(page, "高图内部锚点");
  const state = await workspace.state(),
    card = state.cards[0]!;
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: "asset.save",
    expected: null,
    payload: {
      id: "tall",
      name: "高图.svg",
      mime: "image/svg+xml",
      base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="3600"><rect width="1200" height="1200" fill="red"/><rect y="1200" width="1200" height="1200" fill="green"/><rect y="2400" width="1200" height="1200" fill="blue"/></svg>',
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
        {
          id: "tall-block",
          type: "image",
          assetId: "tall",
          name: "高图.svg",
          mime: "image/svg+xml",
          naturalWidth: 1200,
          naturalHeight: 3600,
          width: 640,
        },
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `tail-${i}`,
          type: "text",
          text: "高图之后。".repeat(20),
        })),
      ],
    },
  });
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("button", { name: "展开写字板", exact: true }).click();
  const block = page.locator("[data-block-id=tall-block]"),
    image = block.locator("img");
  await expect(image).toHaveJSProperty("complete", true);
  await image.evaluate((el) => {
    const s = el.closest(".board-scroll")!;
    const r = el.getBoundingClientRect();
    s.scrollTop += r.top - s.getBoundingClientRect().top + r.height * 0.48 + 2;
  });
  const measure = () =>
    image.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        bounds = el.closest(".board-scroll")!.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        fraction: (bounds.top + 2 - r.top) / r.height,
      };
    });
  const original = await measure();
  expect(original.width).toBe(640);
  expect(original.height).toBe(1920);
  await page.setViewportSize({ width: 500, height: 900 });
  await expect.poll(async () => (await measure()).width).toBeLessThan(500);
  const narrow = await measure();
  expect(narrow.height).toBeLessThan(original.height);
  expect(
    Math.abs(narrow.fraction - original.fraction) * narrow.height,
  ).toBeLessThanOrEqual(1);
  await image.click({
    position: { x: narrow.width / 2, y: narrow.height * narrow.fraction + 70 },
  });
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("button", { name: "关闭大图", exact: true }).click();
  await expect(block).toBeFocused();
  const returned = await measure();
  expect(returned.width).toBe(640);
  expect(
    Math.abs(returned.fraction - original.fraction) * returned.height,
  ).toBeLessThanOrEqual(1);
  expect((await workspace.state()).cards[0]!.body.blocks[0]!.width).toBe(640);
  await info.attach("tall-image-interior-anchor", {
    body: Buffer.from(JSON.stringify({ original, narrow, returned })),
    contentType: "application/json",
  });
  await info.attach("tall-image-return", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
