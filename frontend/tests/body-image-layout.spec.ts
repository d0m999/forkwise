import { test, expect, place } from "./writing-board-fixture";
test.use({ actionTimeout: 6000 });
test("加载预留与失败图保持比例和阅读位置，布局变化与大图关闭恢复结构块", async ({
  page,
  workspace,
}, info) => {
  await place(page, "图片布局");
  const state = await workspace.state(),
    card = state.cards[0]!;
  await workspace.execute(page, {
    commandId: crypto.randomUUID(),
    projectId: state.project.id,
    type: "asset.save",
    expected: null,
    payload: {
      id: "layout-image",
      name: "布局.svg",
      mime: "image/svg+xml",
      base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="green"/></svg>',
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
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `before-${i}`,
          type: "text",
          text: `前文 ${i}。`.repeat(30),
        })),
        {
          id: "layout-block",
          type: "image",
          assetId: "layout-image",
          name: "布局.svg",
          mime: "image/svg+xml",
          naturalWidth: 1200,
          naturalHeight: 600,
          width: 640,
        },
        ...Array.from({ length: 14 }, (_, i) => ({
          id: `after-${i}`,
          type: "text",
          text: `后文 ${i}。`.repeat(30),
        })),
      ],
    },
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/assets/layout-image/content", async (route) => {
    await gate;
    await route.fulfill({ status: 503, body: "owned image loading failure" });
  });
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const block = page.locator("[data-block-id=layout-block]"),
    image = block.locator("img");
  await image.scrollIntoViewIfNeeded();
  const loading = (await image.boundingBox())!;
  expect(loading.width).toBeGreaterThan(200);
  expect(loading.height).toBeCloseTo(loading.width / 2, 1);
  const anchor = page.locator("[data-block-id=after-2]");
  await anchor.evaluate((el) => {
    const s = el.closest(".board-scroll")!;
    s.scrollTop +=
      el.getBoundingClientRect().top - s.getBoundingClientRect().top + 1;
  });
  const relative = () =>
    anchor.evaluate(
      (el) =>
        el.getBoundingClientRect().top -
        el.closest(".board-scroll")!.getBoundingClientRect().top,
    );
  const before = await relative();
  release();
  await expect(
    page.getByText("图片加载失败，原文件仍保留", { exact: true }),
  ).toBeAttached();
  expect(await relative()).toBeCloseTo(before, 0);
  expect((await image.boundingBox())!.height).toBeCloseTo(loading.height, 1);
  await page.getByRole("button", { name: "展开写字板", exact: true }).click();
  await expect
    .poll(async () => Math.abs((await relative()) - before))
    .toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect
    .poll(async () => Math.abs((await relative()) - before))
    .toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect
    .poll(async () => Math.abs((await relative()) - before))
    .toBeLessThanOrEqual(1);
  await image.scrollIntoViewIfNeeded();
  await image.click();
  const imageY = await block.evaluate(
    (el) =>
      el.getBoundingClientRect().top -
      el.closest(".board-scroll")!.getBoundingClientRect().top,
  );
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 760 });
  const viewer = page.getByRole("dialog", { name: "正文大图" });
  await expect(viewer.getByRole("alert")).toContainText("大图加载失败");
  await viewer.getByRole("button", { name: "关闭大图", exact: true }).click();
  await expect(block).toBeFocused();
  expect(
    Math.abs(
      (await block.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest(".board-scroll")!.getBoundingClientRect().top,
      )) - imageY,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    (await workspace.state()).cards[0]!.body.blocks.find(
      (b) => b.type === "image",
    )!.width,
  ).toBe(640);
  await info.attach("failed-image-layout", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
