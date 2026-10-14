import { test, expect, place } from "./card-appearance-fixture";

test("A9-03 丢ACK时外观立即可见并保留更新输入，原请求恢复不覆盖新选择/正文草稿", async ({
  page,
  workspace,
}, info) => {
  await place(page, "原卡");
  await place(page, "另一卡", 500, 350);
  const before = await workspace.state(),
    original = before.cards[0]!,
    other = before.cards[1]!;
  await page
    .locator(".react-flow__node")
    .nth(0)
    .locator(".title-button")
    .click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handled!: () => void;
  const handling = new Promise<void>((resolve) => {
    handled = resolve;
  });
  let intercepted = false;
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "card.appearance") {
      await route.continue();
      return;
    }
    requests.push(command);
    if (!intercepted) {
      intercepted = true;
      try {
        await route.fetch();
        await gate;
        await route.abort("failed");
      } finally {
        handled();
      }
    } else await route.continue();
  });
  try {
    await page.getByRole("button", { name: "杏色", exact: true }).click();
    await expect(page.locator(".title-button").nth(0)).toHaveCSS(
      "background-color",
      "rgb(247, 233, 189)",
    );
    await page.getByRole("button", { name: "绿色", exact: true }).click();
    await expect(page.locator(".title-button").nth(0)).toHaveCSS(
      "background-color",
      "rgb(220, 238, 226)",
    );
    await page
      .locator(".react-flow__node")
      .nth(1)
      .getByRole("button", { name: "编辑正文" })
      .click();
    await page
      .getByLabel("卡片正文", { exact: true })
      .fill("另一卡的新草稿不会被旧外观ACK清除");
    release();
    await expect(page.getByRole("alert")).toContainText(
      /外观|Failed to fetch|fetch/i,
    );
    await page
      .getByRole("button", { name: "重试外观保存", exact: true })
      .click();
    await expect
      .poll(
        async () => (await workspace.state()).cards[0]!.appearance?.titleColor,
      )
      .toBe("#dceee2");
    await expect(page.getByLabel("卡片正文", { exact: true })).toHaveValue(
      "另一卡的新草稿不会被旧外观ACK清除",
    );
    const after = await workspace.state();
    expect(after.cards[1]!.id).toBe(other.id);
    expect(after.cards[1]!.appearance).toBeUndefined();
    expect(after.cards[0]!.id).toBe(original.id);
    expect(requests[1]).toEqual(requests[0]);
    expect(
      (requests[2] as { payload: { titleColor: string } }).payload.titleColor,
    ).toBe("#dceee2");
    await page.screenshot({ path: info.outputPath("appearance-late-ack.png") });
    await info.attach("original-request-recovery", {
      body: JSON.stringify(requests),
      contentType: "application/json",
    });
  } finally {
    release();
    if (intercepted) await handling;
    await page.unroute("**/api/mapping/execute");
  }
});
