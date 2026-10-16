import { test, expect, place } from "./writing-board-fixture";
test("小数渲染宽的原地点击与取消手势不写期望宽、不增加历史，调宽柄对齐真实图片边缘", async ({
  page,
  workspace,
}, info) => {
  await page.setViewportSize({ width: 1361, height: 900 });
  await place(page, "无变化手势");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "手势.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="green"/></svg>',
    ),
  });
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const image = page.locator(".body-image img");
  await image.click();
  const original = (await image.boundingBox())!,
    revision = (await workspace.state()).project.revision;
  expect(original.width % 1).not.toBe(0);
  const grip = page.getByRole("slider", {
    name: "调整正文图片宽度",
    exact: true,
  });
  const edge = (await grip.boundingBox())!;
  expect(
    Math.abs(edge.x + edge.width / 2 - original.x - original.width),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(edge.y + edge.height / 2 - original.y - original.height / 2),
  ).toBeLessThanOrEqual(1);
  await grip.click();
  await page.waitForTimeout(600);
  expect((await workspace.state()).project.revision).toBe(revision);
  expect(
    (await workspace.state()).cards[0]!.body.blocks.find(
      (b) => b.type === "image",
    )!.width,
  ).toBeUndefined();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x - 80, edge.y + edge.height / 2, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect((await workspace.state()).project.revision).toBe(revision);
  expect((await image.boundingBox())!.width).toBe(original.width);
  await info.attach("real-handle-geometry", {
    body: Buffer.from(JSON.stringify({ original, edge, revision })),
    contentType: "application/json",
  });
});
