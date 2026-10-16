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
