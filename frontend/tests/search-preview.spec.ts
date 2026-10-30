import { test, expect } from "./writing-board-fixture";

test("正文查找前置命中增删后仍选原命中而不是旧序号", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create", projectId, commandId: "hit-identity-card", expected: null,
    payload: { id: "hit-identity", title: "命中身份", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit", projectId, commandId: "hit-identity-body", expected: card.body.versionId,
    payload: { id: card.id, blocks: [
      { id: "first", type: "text", text: "库存首处" },
      { id: "second", type: "text", text: "库存末处" },
    ] },
  });
  await page.reload();
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", { name: "写字板" });
  await board.locator(".paragraph-editor").press("Meta+f");
  await board.getByRole("searchbox", { name: "查找当前正文" }).fill("库存");
  await expect(board.getByText("1 / 2", { exact: true })).toBeVisible();
  await board.getByRole("button", { name: "下一处", exact: true }).click();
  await expect(board.getByText("2 / 2", { exact: true })).toBeVisible();
  const first = board.locator("[data-block-id=first]");
  await first.click();
  await page.keyboard.type(" 库存新增");
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text).toBe("库存首处 库存新增");
  await expect(board.getByText("3 / 3", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => {
    const range = [...(CSS.highlights.get("search-board-current") ?? [])][0] as Range;
    return range.startContainer.parentElement?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
  })).toBe("second");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]!.text).toBe("库存首处");
  await expect(board.getByText("2 / 2", { exact: true })).toBeVisible();
});

test("宽窗自动首卡阅读后缩窄保留预览而不是退回列表", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create", projectId, commandId: "wide-reading", expected: null,
    payload: {
      id: "wide-reading", title: "自动预览阅读", x: 100, y: 100,
      text: "前文。".repeat(400) + "\n库存命中\n" + "后文。".repeat(400),
    },
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.reload();
  await page.getByRole("button", { name: "搜索当前项目卡片", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  const preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(preview.getByText("1 / 1", { exact: true })).toBeVisible();
  await preview.getByLabel("只读正文滚动区域").press("ArrowDown");
  await page.setViewportSize({ width: 650, height: 700 });
  await expect(preview).toBeVisible();
  await expect(dialog.getByRole("button", { name: "返回结果列表", exact: true })).toBeVisible();
  await expect(preview.getByText("1 / 1", { exact: true })).toBeVisible();
});

test("保留正文查找时远离命中编辑并保存不会跳回旧命中", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create", projectId, commandId: "save-anchor-card", expected: null,
    payload: { id: "save-anchor", title: "保存阅读位置", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit", projectId, commandId: "save-anchor-body", expected: card.body.versionId,
    payload: { id: card.id, blocks: [
      { id: "match", type: "text", text: "库存首处" },
      { id: "context", type: "text", text: "用于继续阅读的长文。".repeat(400) },
      { id: "far", type: "text", text: "远处记录" },
      { id: "tail", type: "text", text: "后文。".repeat(100) },
    ] },
  });
  await page.reload();
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", { name: "写字板" });
  await board.locator(".paragraph-editor").press("Meta+f");
  await board.getByRole("searchbox", { name: "查找当前正文" }).fill("库存");
  await expect(board.getByText("1 / 1", { exact: true })).toBeVisible();
  const far = board.locator("[data-block-id=far]");
  await far.click();
  await far.press("End");
  await page.keyboard.type("新增记录");
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.find(block => block.id === "far")!.text).toBe("远处记录新增记录");
  await expect(board.getByText("1 / 1", { exact: true })).toBeVisible();
  await expect(far).toBeInViewport();
});

test("重开同卡预览读取写字板刚更新的折叠偏好", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create", projectId, commandId: "reopen-fold-card", expected: null,
    payload: { id: "reopen-fold", title: "库存标题", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit", projectId, commandId: "reopen-fold-body", expected: card.body.versionId,
    payload: { id: card.id, blocks: [
      { id: "chapter", type: "heading", level: 1, text: "章节" },
      { id: "inside", type: "text", text: "章节里的阅读内容" },
    ] },
  });
  await page.reload();
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", { name: "写字板" });
  await page.getByRole("button", { name: "搜索当前项目卡片", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" });
  const preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await expect(preview.locator("[data-block-id=inside]")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await board.getByRole("button", { name: "收起：章节", exact: true }).click();
  await expect(board.locator("[data-block-id=inside]")).toBeHidden();
  await page.getByRole("button", { name: "搜索当前项目卡片", exact: true }).click();
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await expect(preview.getByRole("button", { name: "展开：章节", exact: true })).toBeVisible();
  await expect(preview.locator("[data-block-id=inside]")).toBeHidden();
});

test("标签筛选按名称查找并全部满足，清词与清标签独立且空查询关闭说明", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, title] of [
    ["a", "多头"],
    ["b", "平仓"],
  ])
    await workspace.execute(page, {
      type: "thought.create",
      projectId,
      commandId: id,
      expected: null,
      payload: { id, title, text: title, x: 0, y: 0 },
    });
  for (const [id, name] of [
    ["z", "Zulu"],
    ["a-tag", "Alpha"],
    ["m", "Macro"],
  ])
    await workspace.execute(page, {
      type: "tag.create",
      projectId,
      commandId: id,
      expected: null,
      payload: { id, name },
    });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await dialog.getByRole("button", { name: "筛选标签", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toHaveText([
    "Alpha",
    "Macro",
    "Zulu",
  ]);
  await dialog
    .getByRole("searchbox", { name: "查找已有标签", exact: true })
    .fill("ma");
  await expect(dialog.getByRole("checkbox")).toHaveText(["Macro"]);
  await dialog.getByRole("checkbox", { name: "Macro", exact: true }).click();
  await dialog
    .getByRole("button", { name: "完成标签筛选", exact: true })
    .click();
  const input = dialog.getByRole("searchbox", { name: "关键词", exact: true });
  await input.fill("多头");
  await expect(
    dialog.getByText("没有符合全部条件的卡片", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "匹配说明", exact: true }).click();
  await expect(dialog.getByText("同时包含：", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "清除关键词", exact: true }).click();
  await expect(dialog.getByText("同时包含：", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByText("没有符合全部条件的卡片", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "清除标签", exact: true }).click();
  await expect(dialog.getByText("2 张卡片", { exact: true })).toBeVisible();
  await input.fill("平仓");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "匹配说明", exact: true }).click();
  await expect(dialog.locator(".search-explanation")).toContainText("平仓");
});

test("40/60只读全文首命中导航，切卡不动地图，窄窗列表与预览切换", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  for (const id of ["alpha", "beta"])
    await workspace.execute(page, {
      type: "thought.create",
      projectId,
      commandId: id,
      expected: null,
      payload: {
        id,
        title: id,
        text: `${id}开头\n${"完整上下文。".repeat(150)}库存第一处\n${"中间内容。".repeat(150)}库存最后一处`,
        x: id === "alpha" ? 2000 : 0,
        y: 100,
      },
    });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.waitForTimeout(250);
  const before = await workspace.state();
  const transform = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await dialog
    .getByRole("searchbox", { name: "关键词", exact: true })
    .fill("库存");
  const preview = dialog.getByRole("region", {
    name: "卡片只读预览",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("1 / 2", { exact: true })).toBeVisible();
  await expect(preview.locator("[contenteditable=true]")).toHaveCount(0);
  await expect(preview.locator(".search-document")).toContainText("开头");
  await expect(preview.locator(".search-document")).toContainText("最后一处");
  const widths = await dialog.evaluate((d) => [
    d.querySelector(".search-results")!.getBoundingClientRect().width,
    d.querySelector(".search-preview")!.getBoundingClientRect().width,
  ]);
  expect(widths[0]! / (widths[0]! + widths[1]!)).toBeCloseTo(0.4, 2);
  await preview.getByRole("button", { name: "下一处", exact: true }).click();
  await expect(preview.getByText("2 / 2", { exact: true })).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "下一处", exact: true }),
  ).toBeDisabled();
  await dialog.locator("[data-card-id=alpha]").click();
  await expect(
    preview.getByRole("heading", { name: "alpha", exact: true }),
  ).toBeVisible();
  expect(
    await page.locator(".react-flow__viewport").getAttribute("style"),
  ).toBe(transform);
  expect((await workspace.state()).project.revision).toBe(
    before.project.revision,
  );
  await page.setViewportSize({ width: 650, height: 700 });
  await expect(preview).toBeVisible();
  await dialog
    .getByRole("button", { name: "返回结果列表", exact: true })
    .click();
  await expect(preview).not.toBeVisible();
  await dialog.locator("[data-card-id=beta]").click();
  await expect(
    preview.getByRole("heading", { name: "beta", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".search-results")).not.toBeVisible();
});

test("明确打开保持缩放几何并临时置前，外点关闭不穿透，输入与结果键盘可达", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  for (const id of ["buried", "cover"])
    await workspace.execute(page, {
      type: "thought.create",
      projectId,
      commandId: id,
      expected: null,
      payload: { id, title: id, text: `${id}全文`, x: 1800, y: 900 },
    });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const viewport = page.locator(".react-flow__viewport");
  const oldZoom = await viewport.evaluate(
    (e) => new DOMMatrixReadOnly(getComputedStyle(e).transform).a,
  );
  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await expect
    .poll(async () => {
      const currentZoom = await viewport.evaluate(
        (e) => new DOMMatrixReadOnly(getComputedStyle(e).transform).a,
      );
      return Math.abs(currentZoom - Math.max(0.5, oldZoom / 1.2));
    })
    .toBeLessThan(1e-6);
  const before = await workspace.state();
  const zoom = await viewport.evaluate(
    (e) => new DOMMatrixReadOnly(getComputedStyle(e).transform).a,
  );
  const trigger = page.getByRole("button", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  const input = dialog.getByRole("searchbox", { name: "关键词", exact: true });
  await input.fill("buried");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "在画布中打开", exact: true }),
  ).toBeEnabled();
  await input.press("Enter");
  await expect(dialog).not.toBeVisible();
  const card = before.cards.find((c) => c.id === "buried")!;
  const node = page.locator(`.react-flow__node[data-id="${card.item.id}"]`);
  await expect(node).toHaveClass(/selected/);
  await expect(page.getByRole("complementary", { name: "写字板" })).toHaveCount(
    0,
  );
  await expect(node.locator("article")).toBeFocused();
  await expect
    .poll(async () => {
      const box = await node.boundingBox(),
        canvas = await page.locator(".canvas").boundingBox();
      return Math.abs(
        box!.x + box!.width / 2 - (canvas!.x + canvas!.width / 2),
      );
    })
    .toBeLessThan(2);
  expect(
    await page
      .locator(".react-flow__viewport")
      .evaluate((e) => new DOMMatrixReadOnly(getComputedStyle(e).transform).a),
  ).toBe(zoom);
  expect((await workspace.state()).cards.map((c) => c.item.pose)).toEqual(
    before.cards.map((c) => c.item.pose),
  );
  const visible = await node.evaluate((e) => {
    const b = e.getBoundingClientRect();
    return document
      .elementFromPoint(b.x + b.width / 2, b.y + 15)
      ?.closest(".react-flow__node")
      ?.getAttribute("data-id");
  });
  expect(visible).toBe(card.item.id);
  await trigger.click();
  await expect(dialog).toBeVisible();
  const selectedBefore = await page
    .locator(".react-flow__node.selected")
    .getAttribute("data-id");
  await page.mouse.click(10, 10);
  await expect(dialog).not.toBeVisible();
  expect(
    await page.locator(".react-flow__node.selected").getAttribute("data-id"),
  ).toBe(selectedBefore);
  await trigger.focus();
  await trigger.press("Meta+k");
  await expect(input).toBeFocused();
  await input.press("ArrowDown");
  await expect(dialog.locator("[data-card-id=buried]")).toBeFocused();
});

test("已开写字板接续当前命中并暂展全部祖先，结束查找恢复偏好，普通打开从开头", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "reading",
    expected: null,
    payload: { id: "reading", title: "阅读卡", text: "", x: 120, y: 120 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "body",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        { id: "h", type: "heading", level: 1, text: "折叠章节" },
        { id: "first", type: "text", text: "库存首处" },
        { id: "long", type: "text", text: "上下文。".repeat(350) },
        { id: "parent", type: "listItem", listType: "bullet", text: "父条目" },
        {
          id: "child",
          type: "listItem",
          listType: "bullet",
          parentId: "parent",
          text: "库存子条目",
        },
      ],
    },
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", {
    name: "写字板",
    exact: true,
  });
  await board
    .getByRole("button", { name: "收起：父条目", exact: true })
    .click();
  await board
    .getByRole("button", { name: "收起：折叠章节", exact: true })
    .click();
  await expect(board.locator("[data-block-id=child]")).toBeHidden();
  const before = await workspace.state();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await dialog
    .getByRole("searchbox", { name: "关键词", exact: true })
    .fill("库存");
  await expect(dialog.getByText("1 / 2", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "下一处", exact: true }).click();
  await dialog
    .getByRole("button", { name: "在画布中打开", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(board.getByText("2 / 2", { exact: true })).toBeVisible();
  await expect(board.locator("[data-block-id=child]")).toBeInViewport();
  await board
    .getByRole("button", { name: "结束正文查找", exact: true })
    .click();
  await expect(board.locator("[data-block-id=child]")).toBeHidden();
  expect((await workspace.state()).project.revision).toBe(
    before.project.revision,
  );
  await board.getByRole("button", { name: "关闭正文", exact: true }).click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await expect
    .poll(() => board.locator(".board-scroll").evaluate((e) => e.scrollTop))
    .toBe(0);
  await expect(board.getByText("2 / 2", { exact: true })).toHaveCount(0);
  await board.locator(".paragraph-editor").press("Meta+f");
  await expect(
    board.getByRole("searchbox", { name: "查找当前正文", exact: true }),
  ).toBeFocused();
});

test("预览折叠遵守阅读偏好，命中临时展开且手动折叠不修改正文", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "fold",
    expected: null,
    payload: { id: "fold", title: "折叠测试", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "fold-body",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        { id: "head", type: "heading", level: 1, text: "章节" },
        { id: "inside", type: "text", text: "库存正文" },
      ],
    },
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", {
    name: "写字板",
    exact: true,
  });
  await board.getByRole("button", { name: "收起：章节", exact: true }).click();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
      name: "搜索当前项目卡片",
      exact: true,
    }),
    preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await expect(
    preview.getByRole("button", { name: "展开：章节", exact: true }),
  ).toBeVisible();
  await expect(preview.locator("[data-block-id=inside]")).toBeHidden();
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(preview.locator("[data-block-id=inside]")).toBeVisible();
  await preview
    .getByRole("button", { name: "收起：章节", exact: true })
    .click();
  await expect(preview.locator("[data-block-id=inside]")).toBeHidden();
  await dialog.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await expect(board.locator("[data-block-id=inside]")).toBeHidden();
});

test("结束正文查找不隐藏编辑光标，离开编辑后恢复折叠", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "cursor",
    expected: null,
    payload: { id: "cursor", title: "光标保护", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "cursor-body",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        { id: "head", type: "heading", level: 1, text: "章节" },
        { id: "inside", type: "text", text: "库存正文" },
      ],
    },
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", {
    name: "写字板",
    exact: true,
  });
  await board.getByRole("button", { name: "收起：章节", exact: true }).click();
  await board.locator(".paragraph-editor").press("Meta+f");
  await board.getByRole("searchbox", { name: "查找当前正文" }).fill("库存");
  await expect(board.getByText("1 / 1", { exact: true })).toBeVisible();
  await board.locator("[data-block-id=inside]").click();
  await board.getByRole("button", { name: "结束正文查找" }).click();
  await expect(board.locator("[data-block-id=inside]")).toBeVisible();
  await page.locator(".react-flow__pane").click({ position: { x: 10, y: 10 } });
  await expect(board.locator("[data-block-id=inside]")).toBeHidden();
});

test("明确打开的晚到校验不能覆盖已关闭搜索，窗口内快捷键重新聚焦", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "late",
    expected: null,
    payload: { id: "late", title: "晚到打开", text: "库存", x: 1500, y: 1500 },
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const before = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  const trigger = page.getByRole("button", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    waiting = new Promise<void>((resolve) => (started = resolve));
  await page.route("**/cards/late/identity", async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  await dialog
    .getByRole("button", { name: "在画布中打开", exact: true })
    .click();
  await waiting;
  await dialog.press("Escape");
  await expect(dialog).not.toBeVisible();
  release();
  await page.waitForTimeout(300);
  expect(
    await page.locator(".react-flow__viewport").getAttribute("style"),
  ).toBe(before);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await trigger.click();
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await dialog.locator("[data-card-id=late]").focus();
  await dialog.locator("[data-card-id=late]").press("Meta+k");
  await expect(
    dialog.getByRole("searchbox", { name: "关键词", exact: true }),
  ).toBeFocused();
});

test("同卡内容更新缩减命中后保持有效序号，非命中更新保结构阅读锚点", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "refresh",
    expected: null,
    payload: { id: "refresh", title: "更新卡", text: "", x: 100, y: 100 },
  });
  let card = (await workspace.state()).cards[0]!;
  const blocks = [
    { id: "one", type: "text", text: "库存第一处" },
    { id: "two", type: "text", text: "库存第二处" },
    { id: "three", type: "text", text: "库存第三处" },
    { id: "long", type: "text", text: "上文。".repeat(500) },
    { id: "context", type: "text", text: "手动阅读上下文" },
    { id: "tail", type: "text", text: "后文。".repeat(500) },
  ];
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "refresh-body",
    expected: card.body.versionId,
    payload: { id: card.id, blocks },
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
      name: "搜索当前项目卡片",
      exact: true,
    }),
    preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(preview.getByText("1 / 3", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "下一处", exact: true }).click();
  await preview.getByRole("button", { name: "下一处", exact: true }).click();
  card = (await workspace.state()).cards[0]!;
  const remaining = blocks.filter(
    (block) => !["two", "three"].includes(block.id),
  );
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "fewer",
    expected: card.body.versionId,
    payload: { id: card.id, blocks: remaining },
  });
  await expect(preview.getByText("1 / 1", { exact: true })).toBeVisible();
  await preview
    .locator("[data-block-id=context]")
    .evaluate((e) => e.scrollIntoView({ block: "start" }));
  const top = await preview
    .locator("[data-block-id=context]")
    .evaluate((e) => e.getBoundingClientRect().top);
  card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "append",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [...remaining, { id: "new", type: "text", text: "尾部更新" }],
    },
  });
  await expect(preview.locator("[data-block-id=new]")).toHaveText("尾部更新");
  expect(
    await preview
      .locator("[data-block-id=context]")
      .evaluate((e) => e.getBoundingClientRect().top),
  ).toBeCloseTo(top, 0);
});

test("正文编辑未保存时不把旧命中涂到新文字，保存后重新查找", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "draft-hit",
    expected: null,
    payload: {
      id: "draft-hit",
      title: "编辑命中",
      text: "库存正文",
      x: 100,
      y: 100,
    },
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", {
      name: "写字板",
      exact: true,
    }),
    editor = board.locator(".paragraph-editor");
  await editor.press("Meta+f");
  await board.getByRole("searchbox", { name: "查找当前正文" }).fill("库存");
  await expect(board.getByText("1 / 1", { exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type === "body.edit") await gate;
    await route.continue();
  });
  try {
    await editor.click();
    await editor.press("Meta+ArrowLeft");
    await page.keyboard.insertText("新增");
    await expect(editor).toContainText("新增库存正文");
    expect(
      await page.evaluate(() =>
        [...(CSS.highlights.get("search-board") ?? [])].map((range) =>
          (range as Range).toString(),
        ),
      ),
    ).not.toContain("新增");
    await expect(board.getByText("1 / 1", { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect(board.getByText("1 / 1", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      [...(CSS.highlights.get("search-board-current") ?? [])].map((range) =>
        (range as Range).toString(),
      ),
    ),
  ).toEqual(["库存"]);
});

test("结果内展示紧凑标签，说明浮层外点收起且继续明确点击的预览", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "tagged",
    expected: null,
    payload: { id: "tagged", title: "标签卡", text: "库存", x: 100, y: 100 },
  });
  await workspace.execute(page, {
    type: "tag.create",
    projectId,
    commandId: "visible-tag",
    expected: { cardTags: null },
    payload: { id: "visible-tag", name: "需要核对", cardId: "tagged" },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "搜索当前项目卡片",
    exact: true,
  });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "匹配说明", exact: true }).click();
  await dialog.locator("[data-card-id=tagged]").click();
  await expect(dialog.locator(".search-explanation")).toHaveCount(0);
  await expect(dialog.locator("[data-card-id=tagged] .project-tag")).toHaveText(
    "需要核对",
  );
  await expect(
    dialog.getByRole("region", { name: "卡片只读预览" }),
  ).toContainText("标签卡");
  await expect(page.getByRole("complementary", { name: "写字板" })).toHaveCount(
    0,
  );
});

test("纯图结果保留图片数与失败重试，重试不打开卡片", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "photos",
    expected: null,
    payload: { id: "photos", title: "图片卡", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "asset.save",
    projectId,
    commandId: "photo-asset",
    expected: null,
    payload: {
      id: "photo-asset",
      name: "示例.svg",
      mime: "image/svg+xml",
      base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#537364"/></svg>',
      ).toString("base64"),
    },
  });
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "photo-body",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: ["photo-one", "photo-two"].map((id) => ({
        id,
        type: "image",
        assetId: "photo-asset",
        name: "示例.svg",
        mime: "image/svg+xml",
        naturalWidth: 160,
        naturalHeight: 80,
      })),
    },
  });
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "other",
    expected: null,
    payload: { id: "other", title: "其他卡", text: "正文", x: 500, y: 100 },
  });
  await page.reload();
  let failed = true;
  await page.route("**/assets/photo-asset/content", (route) =>
    failed
      ? route.fulfill({ status: 503, body: "synthetic failure" })
      : route.continue(),
  );
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
      name: "搜索当前项目卡片",
      exact: true,
    }),
    row = dialog.locator("[data-card-id=photos]");
  await expect(row.getByText("2 张图片", { exact: true })).toBeVisible();
  await expect(row.getByText("缩略图加载失败", { exact: true })).toBeVisible();
  failed = false;
  await row.getByRole("button", { name: "重新加载缩略图" }).click();
  await expect
    .poll(() =>
      row.locator("img").evaluate((e: HTMLImageElement) => e.naturalWidth),
    )
    .toBe(160);
  await expect(row.getByText("缩略图加载失败", { exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-card-id=other]")).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("表格同偏移命中按单元格保位，导航横向显露宽表格和代码", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "wide",
    expected: null,
    payload: { id: "wide", title: "宽内容", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "wide-body",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        {
          id: "table",
          type: "table",
          header: false,
          rows: [
            [
              { text: "库存" },
              ...Array.from({ length: 4 }, () => ({ text: "中间列" })),
              { text: "库存" },
            ],
          ],
          columnWidths: [200, 200, 200, 200, 200, 200],
        },
        {
          id: "code",
          type: "code",
          language: "text",
          wrap: false,
          text: "x".repeat(180) + " 库存",
        },
      ],
    },
  });
  await workspace.execute(page, {
    type: "tag.create",
    projectId,
    commandId: "wide-tag",
    expected: { cardTags: null },
    payload: { id: "wide-tag", name: "宽表", cardId: card.id },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
      name: "搜索当前项目卡片",
      exact: true,
    }),
    preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(preview.getByText("1 / 3", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "下一处" }).click();
  const visibleHit = () =>
    page.evaluate(() => {
      const range = [
        ...(CSS.highlights.get("search-preview-current") ?? []),
      ][0] as Range;
      const element = range.startContainer.parentElement!,
        host = element.closest<HTMLElement>(".imported-table, pre")!;
      const rect = range.getBoundingClientRect(),
        bounds = host.getBoundingClientRect();
      return {
        visible: rect.left >= bounds.left && rect.right <= bounds.right,
        cell: element.closest<HTMLElement>("[data-cell]")?.dataset.cell,
      };
    });
  await expect.poll(async () => (await visibleHit()).visible).toBe(true);
  expect((await visibleHit()).cell).toBe("0,5");
  await dialog.getByRole("button", { name: "筛选标签", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "宽表", exact: true }).click();
  await dialog.getByRole("button", { name: "完成标签筛选" }).click();
  await expect(preview.getByText("2 / 3", { exact: true })).toBeVisible();
  expect((await visibleHit()).cell).toBe("0,5");
  await preview.getByRole("button", { name: "下一处" }).click();
  await expect(preview.getByText("3 / 3", { exact: true })).toBeVisible();
  await expect.poll(async () => (await visibleHit()).visible).toBe(true);
});

test("正文查找快速改回已完成的关键词不会停在等待状态", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "return-query",
    expected: null,
    payload: {
      id: "return-query",
      title: "查找状态",
      text: "库存正文",
      x: 100,
      y: 100,
    },
  });
  await page.reload();
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", { name: "写字板" });
  await board.locator(".paragraph-editor").press("Meta+f");
  const input = board.getByRole("searchbox", { name: "查找当前正文" });
  await input.fill("库存");
  await expect(board.getByText("1 / 1", { exact: true })).toBeVisible();
  await input.fill("库存x");
  await input.fill("库存");
  await expect(board.getByText("1 / 1", { exact: true })).toBeVisible();
  await expect(board.getByText("正在查找…", { exact: true })).toHaveCount(0);
});

test("同卡改关键词从新首命中继续", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "query-reset",
    expected: null,
    payload: {
      id: "query-reset",
      title: "改词卡",
      text: "库存甲 订单甲\n库存乙 订单乙\n库存丙 订单丙",
      x: 100,
      y: 100,
    },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" }),
    input = dialog.getByRole("searchbox", { name: "关键词" });
  await input.fill("库存");
  await expect(dialog.getByText("1 / 3", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "下一处" }).click();
  await dialog.getByRole("button", { name: "下一处" }).click();
  await expect(dialog.getByText("3 / 3", { exact: true })).toBeVisible();
  await input.fill("订单");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1 / 3", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      [...(CSS.highlights.get("search-preview-current") ?? [])].map((range) =>
        (range as Range).toString(),
      ),
    ),
  ).toEqual(["订单"]);
});

test("导航先展开折叠祖先再滚到长文命中，折叠箭头不重复正文", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "hidden-hit",
    expected: null,
    payload: { id: "hidden-hit", title: "折叠定位", text: "", x: 100, y: 100 },
  });
  const card = (await workspace.state()).cards[0]!;
  await workspace.execute(page, {
    type: "body.edit",
    projectId,
    commandId: "hidden-body",
    expected: card.body.versionId,
    payload: {
      id: card.id,
      blocks: [
        { id: "first", type: "text", text: "库存首处" },
        { id: "before", type: "text", text: "很长的上下文。".repeat(600) },
        { id: "head", type: "heading", level: 1, text: "深层章节" },
        { id: "hidden", type: "text", text: "库存末处" },
        { id: "tail", type: "text", text: "后文。".repeat(600) },
      ],
    },
  });
  await page.reload();
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const board = page.getByRole("complementary", { name: "写字板" });
  await board
    .getByRole("button", { name: "收起：深层章节", exact: true })
    .click();
  await board.getByRole("button", { name: "关闭正文" }).click();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" }),
    preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(preview.getByText("1 / 2", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "下一处" }).click();
  await expect(preview.locator("[data-block-id=hidden]")).toBeInViewport();
  const control = await preview
    .getByRole("button", { name: "收起：深层章节", exact: true })
    .boundingBox();
  expect(control!.width).toBeLessThanOrEqual(28);
  expect(control!.height).toBeLessThanOrEqual(28);
});

test("窄窗首次自动首卡进入预览时才定位长文首命中", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    type: "thought.create",
    projectId,
    commandId: "narrow-first",
    expected: null,
    payload: {
      id: "narrow-first",
      title: "首次预览",
      text: "前文。".repeat(1000) + "\n库存命中\n" + "后文。".repeat(1000),
      x: 100,
      y: 100,
    },
  });
  await page.setViewportSize({ width: 650, height: 700 });
  await page.reload();
  await page
    .getByRole("button", { name: "搜索当前项目卡片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "搜索当前项目卡片" }),
    preview = dialog.getByRole("region", { name: "卡片只读预览" });
  await dialog.getByRole("searchbox", { name: "关键词" }).fill("库存");
  await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
  await expect(preview).not.toBeVisible();
  await dialog.getByRole("button", { name: "查看预览" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const range = [
          ...(CSS.highlights.get("search-preview-current") ?? []),
        ][0] as Range;
        const box = range.getBoundingClientRect(),
          bounds = document
            .querySelector(".search-preview-scroll")!
            .getBoundingClientRect();
        return box.top >= bounds.top && box.bottom <= bounds.bottom;
      }),
    )
    .toBe(true);
});
