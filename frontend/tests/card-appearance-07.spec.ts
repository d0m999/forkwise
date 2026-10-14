import { test, expect, place } from "./card-appearance-fixture";

test("A9-07 必要增高ACK晚到时标题已删短，最终重新测量缩回且不覆盖新标题", async ({
  page,
  workspace,
}, info) => {
  await place(page, "短");
  const height = (await workspace.state()).cards[0]!.item.pose.height;
  let release!: () => void, done!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    handled = new Promise<void>((r) => {
      done = r;
    });
  let captured = false;
  let holdReadback = false,
    readbackSeen = false,
    releaseReadback!: () => void;
  const readbackGate = new Promise<void>((r) => {
    releaseReadback = r;
  });
  await page.route("**/api/mapping/projects", async (route) => {
    if (!holdReadback || readbackSeen) {
      await route.continue();
      return;
    }
    readbackSeen = true;
    const response = await route.fetch();
    await readbackGate;
    await route.fulfill({ response });
  });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "card.layout" || captured) {
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
    await page.getByRole("button", { name: "编辑标题", exact: true }).click();
    await page
      .getByLabel("卡片标题", { exact: true })
      .fill("第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行");
    await page.getByLabel("卡片标题", { exact: true }).press("Enter");
    await expect.poll(() => captured).toBe(true);
    await page.getByRole("button", { name: "编辑标题", exact: true }).click();
    await page.getByLabel("卡片标题", { exact: true }).fill("短");
    await page.getByLabel("卡片标题", { exact: true }).press("Enter");
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.title)
      .toBe("短");
    holdReadback = true;
    release();
    await expect.poll(() => readbackSeen).toBe(true);
    // Let the real UI publish the readback while its project-list request is
    // outstanding; this is render scheduling, not a guessed sleep interval.
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    releaseReadback();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect
      .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
      .toBe(height);
    await expect(page.locator(".title-button")).toHaveText("短");
    await page.screenshot({ path: info.outputPath("height-late-ack.png") });
  } finally {
    release();
    releaseReadback();
    if (captured) await handled;
    if (!page.isClosed()) {
      await page.unroute("**/api/mapping/execute");
      await page.unroute("**/api/mapping/projects");
    }
  }
});
