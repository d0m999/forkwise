import { test, expect } from "./writing-board-fixture";

test("当前项目搜索展示原文命中、全部条件及未闭合引号提示，阅读不改内容时间", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, title, text] of [
    ["continuous", "原文", "😀多頭平倉 ＥＴＦ"],
    ["separated", "观察", "多头开始平仓 ETF"],
    ["partial", "多头", "仓位"],
  ])
    await workspace.execute(page, {
      type: "thought.create",
      projectId,
      commandId: id,
      expected: null,
      payload: { id, title, text, x: 0, y: 0 },
    });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const before = await workspace.state();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  const input = dialog.getByRole("searchbox", { name: "关键词", exact: true });
  await input.fill("多头平仓");
  await expect(dialog.getByText("2 张卡片", { exact: true })).toBeVisible();
  await input.fill("“多头平仓” etf");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await expect(dialog.locator("mark")).toHaveText(["多頭平倉", "ＥＴＦ"]);
  await dialog.getByRole("button", { name: "匹配说明", exact: true }).click();
  await expect(
    dialog.getByText("多头平仓（连续文字）", { exact: true }),
  ).toBeVisible();
  await input.fill('"多头平仓');
  await expect(dialog.getByText("可补全右引号", { exact: true })).toBeVisible();
  await expect(input).toHaveValue('"多头平仓');
  await input.fill("没有该文字");
  await expect(
    dialog.getByText("没有符合全部条件的卡片", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "清除关键词", exact: true }).click();
  await expect(dialog.getByText("3 张卡片", { exact: true })).toBeVisible();
  expect((await workspace.state()).project.revision).toBe(
    before.project.revision,
  );
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "搜索当前项目卡片", exact: true }),
  ).toBeFocused();
});

test("组合输入不查询或关闭，过期响应和背景撤销不能改变当前搜索", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, text] of [
    ["a", "多头"],
    ["b", "平仓"],
  ])
    await workspace.execute(page, {
      type: "thought.create",
      projectId,
      commandId: id,
      expected: null,
      payload: { id, title: id, text, x: 0, y: 0 },
    });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  const input = dialog.getByRole("searchbox", { name: "关键词", exact: true });
  await expect(dialog.getByText("2 张卡片", { exact: true })).toBeVisible();
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/search")) requests++;
  });
  await input.dispatchEvent("compositionstart");
  await input.fill("多头");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await input.dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    keyCode: 229,
  });
  await page.waitForTimeout(300);
  expect(requests).toBe(0);
  await expect(dialog).toBeVisible();
  await input.dispatchEvent("compositionend");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await expect(dialog.locator("[data-card-id]")).toHaveAttribute(
    "data-card-id",
    "a",
  );
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/search", async (route) => {
    const response = await route.fetch();
    if (route.request().postDataJSON().text === "多") {
      started();
      await gate;
    }
    await route.fulfill({ response });
  });
  await input.fill("多");
  await waiting;
  try {
    await expect(dialog.getByText("正在搜索…", { exact: true })).toBeVisible();
    await expect(dialog.locator("[data-card-id]")).toHaveAttribute(
      "data-card-id",
      "a",
    );
    await input.fill("平仓");
    await expect(dialog.locator("[data-card-id]")).toHaveAttribute(
      "data-card-id",
      "b",
    );
  } finally {
    release();
  }
  await page.waitForTimeout(150);
  await expect(dialog.locator("[data-card-id]")).toHaveAttribute(
    "data-card-id",
    "b",
  );
  const before = await workspace.state();
  const close = dialog.getByRole("button", { name: "关闭搜索", exact: true });
  await close.focus();
  await close.press("Meta+z");
  await close.press("Delete");
  expect((await workspace.state()).project.revision).toBe(
    before.project.revision,
  );
  await expect(dialog).toBeVisible();
  await close.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "搜索当前项目卡片", exact: true }),
  ).toBeFocused();
});
