import { test, expect, place } from "./card-appearance-fixture";

test("A9-11 测量版本冲突后重读失败可见，并能重试取得当前投影", async ({
  page,
  workspace,
}) => {
  await place(page, "短");
  let conflict = false,
    failedRead = false;
  await page.route("**/api/mapping/projects/**", async (route) => {
    if (
      conflict &&
      !failedRead &&
      new URL(route.request().url()).pathname.endsWith("/map")
    ) {
      failedRead = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "card.layout" && !conflict) {
      const state = await workspace.state();
      const card = state.cards[0]!;
      const peer = await page.request.post(
        workspace.origin + "/api/mapping/execute",
        {
          headers: { Origin: workspace.origin },
          data: {
            commandId: crypto.randomUUID(),
            projectId: state.project.id,
            type: "thought.title",
            expected: card.versionId,
            payload: { id: card.id, title: card.title + "\n同伴修订" },
          },
        },
      );
      expect(peer.status()).toBe(200);
      conflict = true;
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "编辑标题", exact: true }).click();
    await page
      .getByLabel("卡片标题", { exact: true })
      .fill("第一行\n第二行\n第三行\n第四行\n第五行\n第六行");
    await page.getByLabel("卡片标题", { exact: true }).press("Enter");
    await expect.poll(() => failedRead).toBe(true);
    await expect(
      page.getByRole("alert").filter({ hasText: /fetch|卡面布局/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "重试卡面布局", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(page.locator(".title-button")).toContainText("同伴修订");
    await expect
      .poll(
        async () =>
          (await workspace.state()).cards[0]!.item.heightPolicy!
            .necessaryHeight,
      )
      .toBeGreaterThan(100);
  } finally {
    if (!page.isClosed()) {
      await page.unroute("**/api/mapping/execute");
      await page.unroute("**/api/mapping/projects/**");
    }
  }
});
