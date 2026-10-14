import { test, expect, place } from "./card-appearance-fixture";

test("A9-05 边缘菜单避卡且外点还合理焦点，打开菜单跨undo/redo重取当前外观与项目身份", async ({
  page,
  workspace,
}, info) => {
  await place(page, "边缘卡", 1020, 16);
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "卡片外观" });
  const toolbar = page.getByRole("toolbar", { name: "卡片操作" });
  const bounds = (await page.locator(".canvas").boundingBox())!,
    box = (await popup.boundingBox())!,
    cardBox = (await page.locator(".thought-card").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  expect(
    box.x + box.width <= cardBox.x ||
      box.x >= cardBox.x + cardBox.width ||
      box.y + box.height <= cardBox.y ||
      box.y >= cardBox.y + cardBox.height,
  ).toBe(true);
  await popup.getByRole("button", { name: "杏色", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await popup.getByRole("button", { name: "杏色", exact: true }).focus();
  await page.keyboard.press("Control+z");
  await expect(
    popup.getByRole("button", { name: "默认蓝", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "绿色", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await workspace.state()).cards[0]!.appearance!.titleColor).toBe(
    "#dceee2",
  );
  await page.keyboard.press("Control+z");
  await expect(
    popup.getByRole("button", { name: "默认蓝", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Shift+z");
  await expect(
    popup.getByRole("button", { name: "绿色", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "重命名当前项目" }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByLabel("项目名称", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await toolbar.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(toolbar).toHaveCount(0);
  await expect(popup).toHaveCount(0);
  await expect(page.locator(".thought-card")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("menu-current-identity.png") });
});
