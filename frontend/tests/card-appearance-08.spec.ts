import { test, expect, place } from "./card-appearance-fixture";

test("A9-08 外观失败刷新后保留输入并重试原请求，真实服务重启与新context往返完整状态", async ({
  page,
  workspace,
  browser,
}, info) => {
  await place(page, "外观恢复");
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const requests: unknown[] = [];
  let fail = true;
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "card.appearance") {
      await route.continue();
      return;
    }
    requests.push(command);
    if (fail) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "杏色", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("外观保存未完成");
  fail = false;
  page.once("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "重试外观保存", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".title-button")).toHaveCSS(
    "background-color",
    "rgb(247, 233, 189)",
  );
  await page.getByRole("button", { name: "重试外观保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect(requests[1]).toEqual(requests[0]);
  await page.unroute("**/api/mapping/execute");
  await page.getByRole("button", { name: "编辑正文" }).click();
  await page
    .getByLabel("卡片正文", { exact: true })
    .fill("完整正文\n重开不截断\n独立Body身份");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".title-button").click();
  const handle = page.getByRole("button", {
    name: "调整卡片尺寸：下",
    exact: true,
  });
  await handle.press("ArrowDown");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = await workspace.state();
  await page.context().close();
  await workspace.restart();
  const context = await browser.newContext();
  try {
    const reopened = await context.newPage();
    await workspace.open(reopened);
    expect(await workspace.state(reopened)).toEqual(saved);
    expect(await reopened.evaluate(() => localStorage.length)).toBe(0);
    await expect(reopened.locator(".title-button")).toHaveCSS(
      "background-color",
      "rgb(247, 233, 189)",
    );
    await reopened.getByRole("button", { name: "编辑正文" }).click();
    await expect(reopened.getByLabel("卡片正文", { exact: true })).toHaveValue(
      "完整正文\n重开不截断\n独立Body身份",
    );
    await reopened.screenshot({
      path: info.outputPath("reopened-appearance-sqlite.png"),
    });
    await info.attach("reopened-authority", {
      body: JSON.stringify(await workspace.state(reopened)),
      contentType: "application/json",
    });
  } finally {
    await context.close();
  }
});
