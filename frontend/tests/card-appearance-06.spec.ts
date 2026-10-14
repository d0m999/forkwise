import { test, expect, place } from "./card-appearance-fixture";

test("A9-06 真实外观冲突保留我的输入，明确采用期间的新输入不被旧ACK删除", async ({
  page,
  workspace,
}, info) => {
  await place(page, "外观冲突");
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const initial = await workspace.state(),
    card = initial.cards[0]!;
  let count = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers: Promise<void>[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "card.appearance") {
      await route.continue();
      return;
    }
    count++;
    let done!: () => void;
    handlers.push(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    try {
      if (count === 1) {
        const peer = await page.request.post(
          workspace.origin + "/api/mapping/execute",
          {
            headers: { Origin: workspace.origin },
            data: {
              ...command,
              commandId: "peer-style",
              payload: {
                id: card.id,
                titleColor: "#f3dfe5",
                showPreview: true,
              },
            },
          },
        );
        expect(peer.status()).toBe(200);
        await route.continue();
      } else if (count === 2) {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      } else {
        await gate;
        await route.continue();
      }
    } finally {
      done();
    }
  });
  try {
    await page.getByRole("button", { name: "绿色", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("外观已更新");
    await expect(page.locator(".title-button")).toHaveCSS(
      "background-color",
      "rgb(220, 238, 226)",
    );
    expect((await workspace.state()).cards[0]!.appearance!.titleColor).toBe(
      "#f3dfe5",
    );
    await page
      .getByRole("button", { name: "确认保留我的外观", exact: true })
      .click();
    await expect.poll(() => count).toBeGreaterThanOrEqual(2);
    // Confirmation is outside the popup; D161 closes it. Reopen through the
    // actual toolbar before continuing input during the outstanding ACK.
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("button", { name: "淡紫色", exact: true }).click();
    await expect(page.locator(".title-button")).toHaveCSS(
      "background-color",
      "rgb(232, 225, 245)",
    );
    release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect
      .poll(
        async () => (await workspace.state()).cards[0]!.appearance!.titleColor,
      )
      .toBe("#e8e1f5");
    await page.screenshot({
      path: info.outputPath("appearance-conflict-new-input.png"),
    });
  } finally {
    release();
    await Promise.all(handlers);
    if (!page.isClosed()) await page.unroute("**/api/mapping/execute");
  }
});
