import { test, expect, place } from "./writing-board-fixture";
import { twoFrameGif } from "./image-reading-fixtures";
test("动图首帧降级时大图Tab跳过禁用播放控件，关闭仍恢复正文焦点", async ({
  page,
  workspace,
}) => {
  await page.evaluate(() => {
    Object.defineProperty(window, "ImageDecoder", {
      value: undefined,
      configurable: true,
    });
  });
  await place(page, "首帧阅读");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "首帧.gif",
    mimeType: "image/gif",
    buffer: twoFrameGif(),
  });
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".body-image canvas").click();
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "正文大图" });
  await expect(
    viewer.getByRole("button", {
      name: "当前浏览器仅显示动图首帧",
      exact: true,
    }),
  ).toBeDisabled();
  const close = viewer.getByRole("button", { name: "关闭大图", exact: true });
  await close.focus();
  await close.press("Shift+Tab");
  await expect(
    viewer.getByRole("button", { name: "放大图片", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".body-image")).toBeFocused();
});
