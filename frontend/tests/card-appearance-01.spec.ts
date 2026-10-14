import { test, expect, place } from "./card-appearance-fixture";

test("A9-01 同栏四图标具名，外观连续即时保存，Esc单路由还焦点并保留写字板", async ({
  page,
  workspace,
}, info) => {
  await place(page, "颜色标题");
  const toolbar = page.getByRole("toolbar", { name: "卡片操作" });
  await expect(
    toolbar.getByRole("button", { name: "编辑标题", exact: true }),
  ).toBeVisible();
  for (const name of ["写字板", "外观", "AI", "更多"]) {
    const button = toolbar.getByRole("button", { name, exact: true });
    await button.focus();
    await expect(
      page.getByRole("tooltip", { name, exact: true }),
    ).toBeVisible();
    expect((await button.innerText()).trim()).toBe("");
  }
  await toolbar.getByRole("button", { name: "写字板", exact: true }).click();
  await page.getByLabel("卡片正文", { exact: true }).fill("白底完整正文");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await toolbar.getByRole("button", { name: "外观", exact: true }).click();
  const appearance = page.getByRole("dialog", { name: "卡片外观" });
  await expect(appearance).toBeVisible();
  await appearance.getByRole("button", { name: "杏色", exact: true }).click();
  await expect
    .poll(
      async () => (await workspace.state()).cards[0]!.appearance?.titleColor,
    )
    .toBe("#f7e9bd");
  await expect(appearance).toBeVisible();
  await expect(page.locator(".title-button")).toHaveCSS(
    "background-color",
    "rgb(247, 233, 189)",
  );
  await expect(page.locator(".preview")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await appearance.getByRole("button", { name: "绿色", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () => (await workspace.state()).cards[0]!.appearance?.titleColor,
    )
    .toBe("#dceee2");
  const saved = await workspace.state();
  await page.keyboard.press("Escape");
  await expect(appearance).toHaveCount(0);
  await expect(
    toolbar.getByRole("button", { name: "外观", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
    "白底完整正文",
  );
  expect(await workspace.state()).toEqual(saved);
  await page.screenshot({ path: info.outputPath("appearance-focus.png") });
});
