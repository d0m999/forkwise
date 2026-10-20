import { test, expect } from "./writing-board-fixture";
import type { Route } from "@playwright/test";

test("历史在默认无标签、窄窗多标签换行和仅词条件下完整可见，恢复整组后保留搜索窗口", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  const names = [
    "产业库存周期",
    "长期供需跟踪",
    "公开材料核对",
    "季度更新记录",
    "现金流观察项",
    "估值变化条件",
    "经营数据来源",
    "同业比较范围",
  ];
  const tagIds = names.map((_, index) => `history-bound-${index}`);
  for (const [index, id] of tagIds.entries())
    await workspace.execute(page, {
      type: "tag.create",
      projectId,
      commandId: id,
      expected: null,
      payload: { id, name: names[index] },
    });
  const full = { text: "库存与现金流需要核对的完整历史条件", tagIds };
  const words = { text: "仅关键词历史", tagIds: [] as string[] };
  let saved = await workspace.execute(page, {
    type: "search.record",
    projectId,
    commandId: "history-bound-full",
    expected: null,
    payload: { query: full, intent: "exit" },
  });
  saved = await workspace.execute(page, {
    type: "search.record",
    projectId,
    commandId: "history-bound-words",
    expected: saved.searchState.versionId,
    payload: { query: words, intent: "exit" },
  });
  await workspace.execute(page, {
    type: "search.save",
    projectId,
    commandId: "history-bound-empty",
    expected: saved.searchState.versionId,
    payload: { query: { text: "", tagIds: [] } },
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  const popup = dialog.getByRole("region", { name: "最近搜索历史" });
  for (const [size, query] of [
    [{ width: 1280, height: 720 }, full],
    [{ width: 480, height: 720 }, words],
    [{ width: 360, height: 640 }, full],
  ] as const) {
    await page.setViewportSize(size);
    if (size.width === 480) {
      const chips = await dialog
        .locator('.search-tags > button[aria-label^="移除筛选标签 "]')
        .all();
      const rows = await Promise.all(
        chips.map(async (chip) => Math.round((await chip.boundingBox())!.y)),
      );
      expect(new Set(rows).size).toBeGreaterThan(1);
    }
    await dialog.getByRole("button", { name: "搜索历史", exact: true }).click();
    const label = [
      query.text,
      ...query.tagIds.map((id) => names[tagIds.indexOf(id)]),
    ].join("＋");
    const restore = popup.getByRole("button", {
      name: `恢复搜索 ${label}`,
      exact: true,
    });
    await restore.scrollIntoViewIfNeeded();
    const bounds = (await dialog.boundingBox())!;
    const visible = {
      left: Math.max(0, bounds.x),
      top: Math.max(0, bounds.y),
      right: Math.min(size.width, bounds.x + bounds.width),
      bottom: Math.min(size.height, bounds.y + bounds.height),
    };
    const targets = [
      popup,
      restore,
      restore.locator(":scope > span").first(),
      ...(await restore.locator(".project-tag").all()),
      restore.locator("time"),
    ];
    for (const target of targets) {
      await expect(target).toBeVisible();
      const rect = (await target.boundingBox())!;
      console.info(
        "history-visible-bounds " + JSON.stringify({ size, visible, rect }),
      );
      expect(rect.x).toBeGreaterThanOrEqual(visible.left - 1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(visible.right + 1);
      expect(rect.y).toBeGreaterThanOrEqual(visible.top - 1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(visible.bottom + 1);
    }
    await restore.click();
    await expect(dialog).toBeVisible();
    await expect(popup).not.toBeVisible();
    await expect(dialog.getByRole("searchbox", { name: "关键词" })).toHaveValue(
      query.text,
    );
    await expect(
      dialog.locator('.search-tags > button[aria-label^="移除筛选标签 "]'),
    ).toHaveCount(query.tagIds.length);
    for (const id of query.tagIds)
      await expect(
        dialog.getByRole("button", {
          name: `移除筛选标签 ${names[tagIds.indexOf(id)]}`,
          exact: true,
        }),
      ).toBeVisible();
  }
});

test("搜索条件真实保存并在服务重启刷新后恢复，预览不记录而关闭记录最后条件", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "search-state-card",
    expected: null,
    payload: {
      id: "search-state-card",
      title: "库存",
      text: "库存研究",
      x: 100,
      y: 100,
    },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  const input = dialog.getByRole("searchbox", { name: "关键词" });
  await input.fill("库存");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await dialog.getByRole("option").click();
  const read = async () =>
    (
      await page.request.get(
        workspace.origin +
          "/api/mapping/projects/" +
          projectId +
          "/search-state",
      )
    ).json();
  await expect.poll(async () => (await read()).current.text).toBe("库存");
  expect((await read()).history).toEqual([]);
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await expect
    .poll(async () => (await read()).history.map((h: any) => h.query.text))
    .toEqual(["库存"]);
  await workspace.restart();
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await expect(input).toHaveValue("库存");
  await dialog.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "恢复搜索 库存", exact: true }),
  ).toBeVisible();
});

test("真实Esc在连续清理撤销后仍逐层关闭，关键词和标签搜索框不执行原生清空", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "search.record",
    projectId,
    commandId: "escape-history",
    expected: null,
    payload: { query: { text: "库存", tagIds: [] }, intent: "exit" },
  });
  await page.reload();
  const opener = page.getByRole("button", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  const history = dialog.getByRole("button", { name: "搜索历史", exact: true });
  const popup = dialog.getByRole("region", { name: "最近搜索历史" });
  const input = dialog.getByRole("searchbox", { name: "关键词", exact: true });
  for (let round = 0; round < 3; round++) {
    await history.click();
    await popup
      .getByRole("button", { name: "清空全部历史", exact: true })
      .click();
    const undo = dialog.getByRole("button", {
      name: "撤销历史清理",
      exact: true,
    });
    if (round === 1) {
      await undo.focus();
      await page.keyboard.press("Enter");
    } else await undo.click();
    await expect(
      popup.getByRole("button", { name: "恢复搜索 库存", exact: true }),
    ).toBeVisible();
    await history.focus();
    await page.keyboard.press("Escape");
    await expect(dialog, `第${round + 1}轮Esc保留搜索窗口`).toBeVisible();
    await expect(popup).not.toBeVisible();
    await expect(history).toBeFocused();
    await expect(input).toHaveValue("库存");
  }
  await history.click();
  for (
    let step = 0;
    step < 8 &&
    !(await input.evaluate((element) => element === document.activeElement));
    step++
  )
    await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("库存");
  await expect(popup).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(history).toBeFocused();
  const tagTrigger = dialog.getByRole("button", { name: "筛选标签", exact: true });
  await tagTrigger.click();
  const picker = dialog.getByRole("region", { name: "标签筛选", exact: true });
  const tagInput = picker.getByRole("searchbox", {
    name: "查找已有标签",
    exact: true,
  });
  await tagInput.fill("标签名称");
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(tagTrigger).toBeFocused();
  await expect(input).toHaveValue("库存");
  const explanation = dialog.getByRole("button", { name: "匹配说明", exact: true });
  await explanation.click();
  await expect(dialog.getByText("同时包含：", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog.getByText("同时包含：", { exact: true })).not.toBeVisible();
  await expect(explanation).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("库存");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("清空历史立即移除列表且关闭重开不补回，分层Esc回焦点并能独立撤销清理", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("ETF 多头");
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  const read = async () =>
    (
      await page.request.get(
        workspace.origin +
          "/api/mapping/projects/" +
          projectId +
          "/search-state",
      )
    ).json();
  await expect.poll(async () => (await read()).history.length).toBe(1);
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const trigger = dialog.getByRole("button", { name: "搜索历史", exact: true });
  await trigger.click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type === "search.clear") await gate;
    await route.continue();
  });
  try {
    await dialog
      .getByRole("button", { name: "清空全部历史", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "恢复搜索 ETF 多头", exact: true }),
    ).not.toBeVisible();
    expect((await read()).history).toHaveLength(1);
  } finally {
    release();
  }
  await expect.poll(async () => (await read()).history).toEqual([]);
  await dialog.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await trigger.click();
  await expect(
    dialog.getByText("还没有搜索历史", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("searchbox", { name: "关键词" })).toHaveValue(
    "ETF 多头",
  );
  await dialog
    .getByRole("button", { name: "撤销历史清理", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "恢复搜索 ETF 多头", exact: true }),
  ).toBeVisible();
});

test("搜索记录提交后丢失ACK仍保留后来输入，关闭不阻塞且重试复用原命令再保存最新条件", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  let failed = false;
  const saves: Record<string, unknown>[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "search.save") {
      saves.push(body);
      if (!failed) {
        failed = true;
        await route.fetch();
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: "UNAVAILABLE", message: "响应丢失" }),
        });
      }
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("原查询");
  await expect(
    page.getByText("未能保存搜索记录 · 重试", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("后来查询");
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "重试保存搜索记录", exact: true })
    .click();
  const read = async () =>
    (
      await page.request.get(
        workspace.origin +
          "/api/mapping/projects/" +
          projectId +
          "/search-state",
      )
    ).json();
  await expect
    .poll(async () => (await read()).history.map((h: any) => h.query.text))
    .toEqual(["后来查询"]);
  expect(saves[1]).toEqual(saves[0]);
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await expect(dialog.getByRole("searchbox", { name: "关键词" })).toHaveValue(
    "后来查询",
  );
  await expect(
    page.getByText("未能保存搜索记录 · 重试", { exact: true }),
  ).not.toBeVisible();
});

test("另一页面更新搜索版本后，明确重试重新读取版本且保留本页查询", async ({
  page,
  workspace,
  context,
}) => {
  const projectId = (await workspace.state()).project.id;
  const second = await context.newPage();
  try {
    await workspace.open(second);
    for (const target of [page, second]) {
      await target
        .getByRole("button", { name: "搜索当前项目卡片", exact: true })
        .click();
      await expect(
        target.getByRole("searchbox", { name: "关键词" }),
      ).toBeEnabled();
    }
    await page.getByRole("searchbox", { name: "关键词" }).fill("第一页");
    const read = async () =>
      (
        await page.request.get(
          workspace.origin +
            "/api/mapping/projects/" +
            projectId +
            "/search-state",
        )
      ).json();
    await expect.poll(async () => (await read()).current.text).toBe("第一页");
    await second.getByRole("searchbox", { name: "关键词" }).fill("第二页保留");
    await expect(
      second.getByText("未能保存搜索记录 · 重试", { exact: true }),
    ).toBeVisible();
    await second
      .getByRole("button", { name: "重试保存搜索记录", exact: true })
      .click();
    await expect
      .poll(async () => (await read()).current.text)
      .toBe("第二页保留");
    await expect(second.getByRole("searchbox", { name: "关键词" })).toHaveValue(
      "第二页保留",
    );
    await expect(
      second.getByText("未能保存搜索记录 · 重试", { exact: true }),
    ).not.toBeVisible();
  } finally {
    await second.close();
  }
});

test("历史标签改名同步且删除后保留失效条件，明确移除失效标签才恢复结果", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "tag-card",
    expected: null,
    payload: {
      id: "tag-card",
      title: "标签命中卡",
      text: "仍然保留",
      x: 100,
      y: 100,
    },
  });
  await workspace.execute(page, {
    type: "tag.create",
    projectId,
    commandId: "tag",
    expected: { cardTags: null },
    payload: { id: "macro", name: "原名称", cardId: "tag-card" },
  });
  await workspace.execute(page, {
    type: "search.record",
    projectId,
    commandId: "history",
    expected: null,
    payload: { query: { text: "", tagIds: ["macro"] }, intent: "exit" },
  });
  let state = await workspace.state();
  await workspace.execute(page, {
    type: "tag.update",
    projectId,
    commandId: "rename-tag",
    expected: state.tags![0]!.versionId,
    payload: { id: "macro", name: "新名称" },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await dialog.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(
    dialog
      .getByRole("region", { name: "最近搜索历史" })
      .getByText("新名称", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  state = await workspace.state();
  await workspace.execute(page, {
    type: "tag.delete",
    projectId,
    commandId: "delete-tag",
    expected: {
      tag: state.tags![0]!.versionId,
      cardTags: { "tag-card": state.cards[0]!.cardTags!.versionId },
    },
    payload: { id: "macro" },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await dialog.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(
    dialog
      .getByRole("region", { name: "最近搜索历史" })
      .getByText("新名称（已删除）", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /^恢复搜索/ }).click();
  await expect(
    dialog.getByText("标签条件已失效，请移除或恢复对应标签后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "移除失效标签", exact: true })
    .click({ timeout: 5000 });
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  const saved = await (
    await page.request.get(
      workspace.origin + "/api/mapping/projects/" + projectId + "/search-state",
    )
  ).json();
  expect(saved.history[0].query).toEqual({ text: "", tagIds: ["macro"] });
});

test("撤销已获焦点的清理提示后，新删除提示按自身焦点和悬停计时", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "search.record",
    projectId,
    commandId: "notice-lifecycle",
    expected: null,
    payload: { query: { text: "库存", tagIds: [] }, intent: "exit" },
  });
  await page.reload();
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await dialog.getByRole("button", { name: "搜索历史", exact: true }).click();
  await dialog
    .getByRole("button", { name: "清空全部历史", exact: true })
    .click();
  const undo = dialog.getByRole("button", { name: "撤销历史清理", exact: true });
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "完成历史选择", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(undo).toBeFocused();
  await page.clock.fastForward(12000);
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(undo).not.toBeVisible();
  await dialog.getByRole("button", { name: "删除历史 库存", exact: true }).click();
  const input = dialog.getByRole("searchbox", { name: "关键词", exact: true });
  await input.click();
  await page.mouse.move(1, 1);
  await expect(input).toBeFocused();
  expect(
    await undo.evaluate((button) => {
      const notice = button.closest('[role="alert"]')!;
      return {
        undoFocused: button === document.activeElement,
        undoHovered: button.matches(":hover"),
        noticeFocused: notice.contains(document.activeElement),
        noticeHovered: notice.matches(":hover"),
      };
    }),
  ).toEqual({
    undoFocused: false,
    undoHovered: false,
    noticeFocused: false,
    noticeHovered: false,
  });
  await page.clock.fastForward(7990);
  await expect(undo).toBeVisible();
  await page.clock.fastForward(100);
  await expect(undo).not.toBeVisible();
});

test("连续删除为最后一次清理重新提供8秒撤销，提示获焦点或指针停留时暂停计时", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  const first = await workspace.execute(page, {
    type: "search.record",
    projectId,
    commandId: "timer-a",
    expected: null,
    payload: { query: { text: "历史甲", tagIds: [] }, intent: "exit" },
  });
  await workspace.execute(page, {
    type: "search.record",
    projectId,
    commandId: "timer-b",
    expected: first.searchState.versionId,
    payload: { query: { text: "历史乙", tagIds: [] }, intent: "exit" },
  });
  await page.reload();
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await dialog.getByRole("button", { name: "搜索历史", exact: true }).click();
  await dialog
    .getByRole("button", { name: "删除历史 历史甲", exact: true })
    .click();
  await page.clock.fastForward(6000);
  await dialog
    .getByRole("button", { name: "删除历史 历史乙", exact: true })
    .click();
  const undo = dialog.getByRole("button", {
    name: "撤销历史清理",
    exact: true,
  });
  await page.clock.fastForward(3000);
  await expect(undo).toBeVisible();
  await undo.focus();
  await page.clock.fastForward(10000);
  await expect(undo).toBeVisible();
  await undo.hover();
  await dialog.getByRole("searchbox", { name: "关键词" }).focus();
  await page.clock.fastForward(10000);
  await expect(undo).toBeVisible();
  await page.mouse.move(1, 1);
  await page.clock.fastForward(4990);
  await expect(undo).toBeVisible();
  await page.clock.fastForward(100);
  await expect(undo).not.toBeVisible();
});

test("搜索已返回新版正文而地图投影仍在途时隐藏旧预览，投影到达后显示同版原文", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "stale-card",
    expected: null,
    payload: {
      id: "stale-card",
      title: "库存",
      text: "库存旧稿",
      x: 100,
      y: 100,
    },
  });
  await workspace.execute(page, {
    type: "tag.create",
    projectId,
    commandId: "stale-tag",
    expected: { cardTags: null },
    payload: { id: "stale-tag", name: "匹配标签", cardId: "stale-card" },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  const preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(preview.getByText("库存旧稿", { exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/changes?**", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    const card = (await workspace.state()).cards[0]!;
    await workspace.execute(page, {
      type: "body.edit",
      projectId,
      commandId: "stale-update",
      expected: card.body.versionId,
      payload: { id: card.id, text: "库存新稿" },
    });
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/search") &&
        response.request().postDataJSON().tagIds?.includes("stale-tag"),
    );
    await dialog.getByRole("button", { name: "筛选标签", exact: true }).click();
    await dialog
      .getByRole("checkbox", { name: "匹配标签", exact: true })
      .click();
    const value = await (await response).json();
    expect(value.results[0].segments[0].text).toBe("库存新稿");
    await expect(
      dialog.getByText("正在搜索…", { exact: true }),
    ).not.toBeVisible();
    await expect(
      preview.getByText("库存旧稿", { exact: true }),
    ).not.toBeVisible();
    await expect(preview.getByRole("alert")).toContainText("正文版本正在更新");
  } finally {
    release();
  }
  await expect(preview.getByText("库存新稿", { exact: true })).toBeVisible();
});

test("正常离开应用时收拢已提交但ACK仍在途的保存，并只记录离开前最后条件", async ({
  page,
  context,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  const traffic: unknown[] = [];
  context.on("requestfailed", (request) => {
    if (request.url().endsWith("/execute"))
      traffic.push({
        event: "requestfailed",
        body: request.postDataJSON(),
        failure: request.failure(),
      });
  });
  context.on("response", (response) => {
    if (response.url().endsWith("/execute"))
      traffic.push({
        event: "response",
        body: response.request().postDataJSON(),
        status: response.status(),
      });
  });
  let release!: () => void, submitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  let held = false;
  const holdSave = async (route: Route) => {
    traffic.push({ event: "route", body: route.request().postDataJSON() });
    if (route.request().postDataJSON().type === "search.save" && !held) {
      held = true;
      const response = await route.fetch();
      submitted();
      await gate;
      try {
        await route.fulfill({ response });
      } catch {
        /* The old page may already be gone. */
      }
    } else await route.continue();
  };
  await context.route("**/api/mapping/execute", holdSave);
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("在途条件");
  await committed;
  // Keep the already-held ACK, but let the unload keepalive use real network.
  // A CDP interception of that new request can be cancelled with its renderer.
  await context.unroute("**/api/mapping/execute", holdSave);
  await dialog
    .getByRole("searchbox", { name: "关键词" })
    .fill("离开前最后条件");
  try {
    await page.goto("about:blank");
  } finally {
    release();
  }
  const read = async () =>
    (
      await page.request.get(
        workspace.origin +
          "/api/mapping/projects/" +
          projectId +
          "/search-state",
      )
    ).json();
  try {
    await expect
      .poll(async () => (await read()).history.map((h: any) => h.query.text))
      .toEqual(["离开前最后条件"]);
  } finally {
    console.info("search-exit-traffic " + JSON.stringify(traffic));
    await test.info().attach("search-exit-traffic", {
      body: JSON.stringify(traffic, null, 2),
      contentType: "application/json",
    });
  }
  await workspace.open(page);
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await expect(dialog.getByRole("searchbox", { name: "关键词" })).toHaveValue(
    "离开前最后条件",
  );
});

test("搜索保存失败后切换项目仍保留本项目未确认条件与可见重试，另一项目保持独立", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  let unavailable = true;
  await page.route("**/api/mapping/execute", async (route) => {
    const body = route.request().postDataJSON();
    if (
      unavailable &&
      body.projectId === projectId &&
      body.type.startsWith("search.")
    )
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "UNAVAILABLE", message: "服务暂不可用" }),
      });
    else await route.continue();
  });
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("未确认条件");
  await expect(
    dialog.getByText("未能保存搜索记录 · 重试", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await expect(dialog.getByRole("searchbox", { name: "关键词" })).toHaveValue(
    "",
  );
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await page.locator(`[role="tab"][title="${projectId}"]`).click();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await expect(dialog.getByRole("searchbox", { name: "关键词" })).toHaveValue(
    "未确认条件",
  );
  await expect(
    dialog.getByText("未能保存搜索记录 · 重试", { exact: true }),
  ).toBeVisible();
  unavailable = false;
  await dialog
    .getByRole("button", { name: "重试保存搜索记录", exact: true })
    .click();
  const read = async () =>
    (
      await page.request.get(
        workspace.origin +
          "/api/mapping/projects/" +
          projectId +
          "/search-state",
      )
    ).json();
  await expect
    .poll(async () => (await read()).history.map((h: any) => h.query.text))
    .toEqual(["未确认条件"]);
  await expect(
    dialog.getByText("未能保存搜索记录 · 重试", { exact: true }),
  ).not.toBeVisible();
});

test("pagehide生命周期探针：退出封套遇另页更新后，明确重试保原清理请求并保存最后条件", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  const read = async () =>
    (
      await page.request.get(
        workspace.origin +
          "/api/mapping/projects/" +
          projectId +
          "/search-state",
      )
    ).json();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("清理目标");
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await expect.poll(async () => (await read()).history.length).toBe(1);
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  await dialog.getByRole("button", { name: "搜索历史", exact: true }).click();
  let release!: () => void, submitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const clears: unknown[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "search.clear") {
      clears.push(body);
      if (clears.length === 1) {
        const response = await route.fetch();
        submitted();
        await gate;
        return route.fulfill({ response });
      }
    }
    await route.continue();
  });
  try {
    await dialog
      .getByRole("button", { name: "清空全部历史", exact: true })
      .click();
    await committed;
    const state = await read();
    await workspace.execute(page, {
      type: "search.save",
      projectId,
      commandId: "peer-after-clear",
      expected: state.versionId,
      payload: { query: { text: "另页更新", tagIds: [] } },
    });
    await dialog
      .getByRole("searchbox", { name: "关键词" })
      .fill("本页最后条件");
    // Public lifecycle handler probe only; actual navigation is covered above.
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      ),
    );
    await expect(
      dialog.getByText("未能保存搜索记录 · 重试", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
  await dialog
    .getByRole("button", { name: "重试保存搜索记录", exact: true })
    .click();
  await expect(
    dialog.getByText("未能保存搜索记录 · 重试", { exact: true }),
  ).not.toBeVisible();
  await expect
    .poll(async () => (await read()).history.map((h: any) => h.query.text))
    .toEqual(["本页最后条件"]);
  expect(clears[1]).toEqual(clears[0]);
  await expect(dialog.getByRole("searchbox", { name: "关键词" })).toHaveValue(
    "本页最后条件",
  );
});
