import { test, expect, place } from "./card-appearance-fixture";

test("A9-09 打开的外观目标经真实历史删除后菜单撤下，旧ACK与后续输入不能复活", async ({
  page,
  workspace,
}, info) => {
  await place(page, "将删除的卡");
  const card = (await workspace.state()).cards[0]!;
  await page.getByRole("button", { name: "外观", exact: true }).click();
  let release!: () => void,
    done!: () => void,
    captured = false;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    handled = new Promise<void>((r) => {
      done = r;
    });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "card.appearance" || captured) {
      await route.continue();
      return;
    }
    captured = true;
    try {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } finally {
      done();
    }
  });
  try {
    await page.getByRole("button", { name: "杏色", exact: true }).click();
    await expect
      .poll(
        async () => (await workspace.state()).cards[0]!.appearance?.titleColor,
      )
      .toBe("#f7e9bd");
    await page.getByRole("button", { name: "绿色", exact: true }).click();
    workspace.removeCard(card.id);
    await expect(page.locator(".thought-card")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "卡片外观" })).toHaveCount(0);
    release();
    await expect(page.getByRole("alert")).toContainText("已删除");
    expect((await workspace.state()).cards).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("forkwise-appearance-recovery-v1")!,
          )[0].value.titleColor,
      ),
    ).toBe("#dceee2");
    await page.screenshot({
      path: info.outputPath("deleted-style-target.png"),
    });
  } finally {
    release();
    if (captured) await handled;
    if (!page.isClosed()) await page.unroute("**/api/mapping/execute");
  }
});
