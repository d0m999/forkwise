import { test, expect, place } from "./writing-board-fixture";
test.use({ actionTimeout: 6000 });
const picture = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="green"/></svg>',
);
test("图注按需、替代文字用户填写、IME不误提交、保存失败保留说明草稿和正文", async ({
  page,
  workspace,
}) => {
  await place(page, "图片说明");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "卡片正文", exact: true });
  await editor.fill("保留的正文");
  await editor.press("End");
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "原始文件名.svg",
    mimeType: "image/svg+xml",
    buffer: picture,
  });
  const image = page.locator(".body-image img");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("alt", "原始文件名.svg");
  await expect(page.locator(".image-caption")).toHaveCount(0);
  await image.click();
  await page.getByRole("button", { name: "编辑图片说明", exact: true }).click();
  const caption = page.getByRole("textbox", { name: "图注", exact: true });
  await caption.fill("用户图注");
  const alt = page.getByRole("textbox", { name: "替代文字", exact: true });
  await alt.dispatchEvent("compositionstart");
  await alt.fill("完整的用户描述");
  await alt.press("Enter");
  await expect(caption).toHaveValue("用户图注");
  await alt.dispatchEvent("compositionend");
  let fail = true;
  await page.route("**/api/mapping/execute", async (route) => {
    if (fail && route.request().postDataJSON().type === "body.edit") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "说明保存失败" }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "保存图片说明", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("保存未完成");
  await expect(image).toHaveAttribute("alt", "完整的用户描述");
  await expect(page.locator(".image-caption")).toHaveText("用户图注");
  await expect(editor).toContainText("保留的正文");
  fail = false;
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = (await workspace.state()).cards[0]!.body.blocks.find(
    (b) => b.type === "image",
  )!;
  expect(saved).toMatchObject({ caption: "用户图注", alt: "完整的用户描述" });
  await workspace.restart();
  await workspace.open(page);
  expect(
    (await workspace.state()).cards[0]!.body.blocks.find(
      (b) => b.type === "image",
    ),
  ).toEqual(saved);
});
