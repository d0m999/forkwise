import { test, expect, place } from "./card-appearance-fixture";

test("A9-10 真实授权撤销后菜单和地图撤下，未确认外观留在恢复区，拒绝旧读写路径", async ({
  page,
  workspace,
}, info) => {
  await place(page, "授权卡");
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type === "card.appearance")
      await route.abort("failed");
    else await route.continue();
  });
  await page.getByRole("button", { name: "杏色", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("外观保存未完成");
  workspace.revoke();
  await expect(page.locator(".thought-card")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "卡片外观" })).toHaveCount(0);
  await expect(page.getByText(/授权已失效/)).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("forkwise-appearance-recovery-v1")!)[0]
          .value.titleColor,
    ),
  ).toBe("#f7e9bd");
  expect(
    (
      await page.request.get(workspace.origin + "/api/mapping/projects")
    ).status(),
  ).toBe(401);
  await page.unroute("**/api/mapping/execute");
  await page.getByRole("button", { name: "重试外观保存", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "外观保存未完成" }),
  ).toContainText(/授权|会话/);
  await page.screenshot({ path: info.outputPath("revoked-menu.png") });
});
