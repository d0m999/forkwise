import { expectTextFontSize } from "./text-font-expectation";
import { test, expect } from "./writing-board-fixture";

test("文字工具就地多行输入，Esc保留回选择，首次创建一步撤销重做并在服务重开后恢复", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 240, y: 180 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await expect(editor).toBeFocused();
  await editor.pressSequentially("Review");
  await editor.press("Enter");
  await editor.pressSequentially("Evidence");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "选择", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () =>
      ((await workspace.state()) as any).texts?.[0]?.content.runs
        .map((r: any) => r.text)
        .join(""),
    )
    .toBe("Review\nEvidence");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts)
    .toEqual([]);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect
    .poll(async () =>
      ((await workspace.state()) as any).texts?.[0]?.content.runs
        .map((r: any) => r.text)
        .join(""),
    )
    .toBe("Review\nEvidence");
  await workspace.restart();
  await page.reload();
  await expect(page.locator(".canvas-text-content")).toHaveText(
    "Review\nEvidence",
  );
  expect((await workspace.state()).cards).toEqual([]);
});
test("编辑文字点击其他卡片直接切换选择且保留输入，空白点击取消选择不连续创建", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    commandId: "other-card",
    projectId,
    type: "thought.create",
    expected: null,
    payload: { id: "other-card", title: "参考卡片", text: "", x: 750, y: 150 },
  });
  await page.reload();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 200, y: 170 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("离开后仍保留的判断");
  await page.getByRole("button", { name: "参考卡片", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".react-flow__node-thought")).toHaveClass(
    /selected/,
  );
  await expect
    .poll(async () =>
      ((await workspace.state()) as any).texts[0].content.runs
        .map((r: any) => r.text)
        .join(""),
    )
    .toBe("离开后仍保留的判断");
  await page.locator(".canvas-text-content").dblclick();
  await editor.press("End");
  await editor.pressSequentially("!");
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 560, y: 420 } });
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  expect(((await workspace.state()) as any).texts).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "选择", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("结束空白文字会移除对象，清空已有内容或新建未输入都能撤销恢复", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 220, y: 170 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("原来的判断");
  await editor.press("Escape");
  await page.locator(".canvas-text-content").dblclick();
  await editor.fill(" \n  ");
  expect(((await workspace.state()) as any).texts).toHaveLength(1);
  await editor.press("Escape");
  await expect
    .poll(async () => ((await workspace.state()) as any).texts)
    .toEqual([]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".canvas-text-content")).toHaveText("原来的判断");
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 600, y: 330 } });
  await editor.press("Escape");
  await expect
    .poll(async () => ((await workspace.state()) as any).texts.length)
    .toBe(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts.length)
    .toBe(2);
});
test("局部颜色加粗保留其他文字，混合加粗按钮不高亮且统一加粗，对象字号和对齐始终整块生效", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 240, y: 220 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("Alpha Beta");
  await editor.press("ControlOrMeta+a");
  await editor.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await editor.press("Shift+ArrowRight");
  const bold = page.getByRole("button", { name: "加粗文字", exact: true });
  await expect(bold).toBeVisible();
  await bold.click();
  await page.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByRole("button", { name: "红色文字", exact: true }).click();
  await editor.press("ControlOrMeta+a");
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "文字颜色", exact: true }),
  ).toHaveText("颜色");
  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("spinbutton", { name: "文字字号", exact: true })
    .fill("24");
  await page
    .getByRole("spinbutton", { name: "文字字号", exact: true })
    .press("Enter");
  await page.getByRole("button", { name: "文字右对齐", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].content)
    .toMatchObject({
      fontSize: 24,
      align: "right",
      runs: [
        { text: "Alpha", bold: true, color: "#ad343e" },
        { text: " Beta", bold: true },
      ],
    });
  const value = ((await workspace.state()) as any).texts[0].content;
  expect(value).toMatchObject({
    fontSize: 24,
    align: "right",
    runs: [
      { text: "Alpha", bold: true, color: "#ad343e" },
      { text: " Beta", bold: true },
    ],
  });
  await expectTextFontSize(page.locator(".canvas-text-content"), 24);
  await expect(page.locator(".canvas-text-content")).toHaveCSS(
    "text-align",
    "right",
  );
  await page.locator(".canvas-text-content").dblclick();
  await editor.press("ControlOrMeta+a");
  await editor.press("ArrowLeft");
  await editor.press("ArrowRight");
  await editor.press("ArrowRight");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "文字颜色", exact: true }),
  ).toHaveCSS("color", "rgb(173, 52, 62)");
  await page
    .getByRole("spinbutton", { name: "文字字号", exact: true })
    .fill("36");
  await page.getByRole("button", { name: "文字居中", exact: true }).click();
  await editor.press("Escape");
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].content)
    .toMatchObject({
      fontSize: 36,
      align: "center",
      runs: [
        { text: "Alpha", bold: true, color: "#ad343e" },
        { text: " Beta", bold: true },
      ],
    });
});
test("自动宽按实际文字增长至320单位，18px与27px行高实际渲染并持久保存真实多行高度", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 200, y: 180 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("观察");
  await expectTextFontSize(editor, 18);
  await expect(editor).toHaveCSS("line-height", "27px");
  expect((await editor.boundingBox())!.width).toBeLessThan(100);
  const long = "季度库存与需求需要继续观察，证据仍需逐项核对。".repeat(8);
  await editor.fill(long);
  await expect
    .poll(async () => Math.round((await editor.boundingBox())!.width))
    .toBe(320);
  expect((await editor.boundingBox())!.height).toBeGreaterThan(108);
  await editor.press("Escape");
  const rendered = page.locator(".canvas-text-content");
  await expect(rendered).toHaveText(long);
  const bounds = (await rendered.boundingBox())!;
  await expect
    .poll(
      async () => ((await workspace.state()) as any).texts[0].item.pose.height,
    )
    .toBeCloseTo(bounds.height, 0);
  const value = ((await workspace.state()) as any).texts[0];
  expect(value.content).toMatchObject({
    fontSize: 18,
    lineHeight: 1.5,
    widthMode: "auto",
    width: 320,
  });
  expect(value.item.pose.width).toBe(320);
  await page.screenshot({
    path: process.env.FORKWISE_ISSUE22_VISUAL_PATH!,
    fullPage: true,
  });
  await page.reload();
  await expect(rendered).toHaveText(long);
  expect((await rendered.boundingBox())!.height).toBeCloseTo(bounds.height, 0);
});
test("左右把手固定宽且不改字号，角点等比缩放并能拖动和撤销文字几何", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 180, y: 220 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("这是用于调宽与整体放大的画布注释，保持文字完整。");
  await editor.press("Escape");
  const right = page.getByRole("button", {
    name: "调整文字尺寸：右",
    exact: true,
  });
  await expect(right).toBeVisible();
  const handle = (await right.boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 180,
    handle.y + handle.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].content)
    .toMatchObject({ widthMode: "fixed", width: 500, fontSize: 18 });
  await page.locator(".canvas-text-content").dblclick();
  await editor.fill("短");
  await editor.press("Escape");
  await expect
    .poll(async () =>
      Math.round(
        (await page.locator(".canvas-text-content").boundingBox())!.width,
      ),
    )
    .toBe(500);
  const before = ((await workspace.state()) as any).texts[0];
  const corner = (await page
    .getByRole("button", { name: "调整文字尺寸：右下", exact: true })
    .boundingBox())!;
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    corner.x + corner.width / 2 + 250,
    corner.y + corner.height / 2 + 13.5,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(
      async () => ((await workspace.state()) as any).texts[0].content.fontSize,
    )
    .toBeCloseTo(27, 1);
  let scaled = ((await workspace.state()) as any).texts[0];
  expect(scaled.content.width).toBeCloseTo(750, 0);
  expect(scaled.item.pose.height).toBeCloseTo(40.5, 0);
  const text = (await page.locator(".canvas-text-content").boundingBox())!;
  await page.mouse.move(text.x + 10, text.y + 10);
  await page.mouse.down();
  await page.mouse.move(text.x + 110, text.y + 90, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].item.pose.x)
    .toBeCloseTo(scaled.item.pose.x + 100, 0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].item.pose.x)
    .toBeCloseTo(scaled.item.pose.x, 0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(
      async () => ((await workspace.state()) as any).texts[0].content.fontSize,
    )
    .toBe(18);
  expect(((await workspace.state()) as any).texts[0].content.width).toBe(
    before.content.width,
  );
});
test("编辑中自动保存且旧ACK只确认覆盖代际，等待期间继续输入不丢文并准确显示保存状态", async ({
  page,
  workspace,
}) => {
  let release!: () => void,
    submitted = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "text.edit" || submitted)
      return route.continue();
    submitted = true;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "文字", exact: true }).click();
    await page
      .locator(".react-flow__pane")
      .click({ position: { x: 200, y: 200 } });
    const editor = page.getByRole("textbox", { name: "独立文字" });
    await editor.fill("第一代内容");
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    await expect.poll(() => submitted).toBe(true);
    await editor.fill("第一代内容与后来继续输入的完整内容");
    release();
    await expect(editor).toHaveText("第一代内容与后来继续输入的完整内容");
    await expect
      .poll(async () =>
        ((await workspace.state()) as any).texts[0].content.runs
          .map((run: any) => run.text)
          .join(""),
      )
      .toBe("第一代内容与后来继续输入的完整内容");
    await expect(editor).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await editor.press("Escape");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect
      .poll(async () => ((await workspace.state()) as any).texts)
      .toEqual([]);
  } finally {
    release();
  }
});
test("丢ACK保留原请求与后来草稿，重载显式恢复后按原键重试并在切项目前保存原目标", async ({
  page,
  workspace,
}) => {
  let retry = false;
  const commands: any[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "text.edit") return route.continue();
    commands.push(command);
    const response = await route.fetch();
    if (!retry) return route.abort("failed");
    return route.fulfill({ response });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 220, y: 240 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("已写入但ACK丢失");
  await expect(page.getByRole("status")).toHaveText("文字保存未完成");
  const original = commands[0];
  await editor.fill("ACK丢失后继续输入的完整草稿");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "恢复独立文字草稿", exact: true }),
  ).toBeVisible();
  retry = true;
  const beforeRetry = commands.length;
  await page
    .getByRole("button", { name: "恢复独立文字草稿", exact: true })
    .click();
  await expect(editor).toHaveText("ACK丢失后继续输入的完整草稿");
  await expect.poll(() => commands.length).toBeGreaterThan(beforeRetry);
  expect(commands[beforeRetry]).toEqual(original);
  await expect
    .poll(async () =>
      ((await workspace.state()) as any).texts[0].content.runs
        .map((run: any) => run.text)
        .join(""),
    )
    .toBe("ACK丢失后继续输入的完整草稿");
  await editor.fill("切换项目之前的最后一代文字");
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(editor).toHaveCount(0);
  await page.getByRole("tab").first().click();
  await expect(page.locator(".canvas-text-content")).toHaveText(
    "切换项目之前的最后一代文字",
  );
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
});
test("合成IME在虚拟计时下不提交半成品，Esc与外部点击延后至compositionend保留最终文字", async ({
  page,
  workspace,
}) => {
  const edits: any[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/mapping/execute") &&
      request.postDataJSON()?.type === "text.edit"
    )
      edits.push(request.postDataJSON());
  });
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 220, y: 240 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await page.clock.install();
  await editor.dispatchEvent("compositionstart");
  await editor.fill("候选输入中");
  await page.clock.fastForward(2500);
  expect(edits).toEqual([]);
  await editor.press("Escape");
  await expect(editor).toBeVisible();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 600, y: 500 } });
  await expect(editor).toBeVisible();
  await editor.fill("最终证据观察");
  await editor.dispatchEvent("compositionend", { data: "最终证据观察" });
  await expect(editor).toHaveCount(0);
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].content.runs)
    .toEqual([{ text: "最终证据观察" }]);
  expect(edits).toHaveLength(1);
  expect(edits[0].payload.content.runs).toEqual([{ text: "最终证据观察" }]);
  await page.clock.resume();
});
test("选中菜单生成独立文字副本保完整样式与固定宽，服务重开及修改撤销不串原件", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 200, y: 200 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("Alpha Beta");
  await editor.press("ControlOrMeta+a");
  await editor.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await editor.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "加粗文字", exact: true }).click();
  await page.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByRole("button", { name: "红色文字", exact: true }).click();
  // A non-empty local range still changes the entire object's size/alignment.
  await page
    .getByRole("spinbutton", { name: "文字字号", exact: true })
    .fill("24");
  await page.getByRole("button", { name: "文字右对齐", exact: true }).click();
  await editor.press("Escape");
  const side = (await page
    .getByRole("button", { name: "调整文字尺寸：右", exact: true })
    .boundingBox())!;
  await page.mouse.move(side.x + 4, side.y + 4);
  await page.mouse.down();
  await page.mouse.move(side.x + 184, side.y + 4);
  await page.mouse.up();
  await expect
    .poll(
      async () => ((await workspace.state()) as any).texts[0].content.widthMode,
    )
    .toBe("fixed");
  const original = ((await workspace.state()) as any).texts[0];
  expect(original.content).toMatchObject({
    fontSize: 24,
    align: "right",
    runs: [{ text: "Alpha", bold: true, color: "#ad343e" }, { text: " Beta" }],
  });
  await page.getByRole("button", { name: "生成文字副本", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts.length)
    .toBe(2);
  const copy = ((await workspace.state()) as any).texts.find(
    (value: any) => value.id !== original.id,
  );
  expect(copy.content).toEqual(original.content);
  expect(copy.id).not.toBe(original.id);
  expect(copy.item.id).not.toBe(original.item.id);
  expect(copy.item.pose.x).toBe(original.item.pose.x + 24);
  expect(copy.item.pose.y).toBe(original.item.pose.y + 24);
  await workspace.restart();
  await page.reload();
  await expect(page.locator(".canvas-text-content")).toHaveCount(2);
  const copyNode = page.locator(
    `.react-flow__node[data-id="${copy.item.id}"]`,
  );
  await expect(copyNode).toHaveAttribute("data-id", copy.item.id);
  await copyNode.locator(".canvas-text-content").dblclick();
  await editor.fill("副本独立修改");
  await editor.press("Escape");
  expect(
    ((await workspace.state()) as any).texts.find(
      (value: any) => value.id === original.id,
    ).content,
  ).toEqual(
    original.content,
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(
      async () =>
        ((await workspace.state()) as any).texts.find(
          (value: any) => value.id === copy.id,
        ).content,
    )
    .toEqual(original.content);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts.length)
    .toBe(1);
});
test("对象格式在途时切项目必须等待完整队列，旧项目ACK不拉回画布且历史次序完整", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 220, y: 240 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("队列中的文字");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  let release!: () => void,
    submitted = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "text.edit" || submitted)
      return route.continue();
    submitted = true;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("spinbutton", { name: "文字字号", exact: true })
      .fill("24");
    await expect.poll(() => submitted).toBe(true);
    await page.getByRole("button", { name: "文字右对齐", exact: true }).click();
    const pendingStatus = await page.getByRole("status").innerText();
    await page.getByRole("button", { name: "新建研究", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    release();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.locator(".canvas-text-content")).toHaveCount(0);
    await page.getByRole("tab").first().click();
    const text = page.locator(".canvas-text-content");
    await expectTextFontSize(text, 24);
    await expect(text).toHaveCSS("text-align", "right");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(text).toHaveCSS("text-align", "left");
    await expectTextFontSize(text, 24);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expectTextFontSize(text, 18);
    const stored = (await workspace.state()) as any;
    const timeline = await (
      await page.request.get(
        workspace.origin +
          "/api/mapping/projects/" +
          stored.project.id +
          "/history",
      )
    ).json();
    console.info(
      "static-format-public-history",
      JSON.stringify({
        pendingStatus,
        content: stored.texts[0].content,
        undo: timeline.undo.map((action: any) => action.label),
        redo: timeline.redo.map((action: any) => action.label),
      }),
    );
    expect(pendingStatus).not.toBe("已保存到本机");
  } finally {
    release();
  }
});
test("公共画布混合多选整体移动所有成员且一次撤销恢复，文字菜单编辑入口可见", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    commandId: "mixed-card",
    projectId,
    type: "thought.create",
    expected: null,
    payload: {
      id: "mixed-card",
      title: "一起移动的卡片",
      text: "",
      x: 600,
      y: 180,
    },
  });
  await page.reload();
  for (const [index, position] of [
    { x: 180, y: 250 },
    { x: 350, y: 400 },
  ].entries()) {
    await page.getByRole("button", { name: "文字", exact: true }).click();
    await page.locator(".react-flow__pane").click({ position });
    const editor = page.getByRole("textbox", { name: "独立文字" });
    await editor.fill(`成员${index}`);
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
  }
  await page
    .getByRole("button", { name: "一起移动的卡片", exact: true })
    .click();
  for (const value of ["成员0", "成员1"])
    await page
      .getByText(value, { exact: true })
      .click({ modifiers: ["Shift"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
  const before = (await workspace.state()) as any;
  const anchor = (await page
    .getByRole("button", { name: "一起移动的卡片", exact: true })
    .boundingBox())!;
  await page.mouse.move(anchor.x + 20, anchor.y + 10);
  await page.mouse.down();
  await page.mouse.move(anchor.x + 80, anchor.y + 60, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.x)
    .toBe(before.cards[0].item.pose.x + 60);
  await expect
    .poll(async () =>
      ((await workspace.state()) as any).texts.map((value: any) => [
        value.item.pose.x,
        value.item.pose.y,
      ]),
    )
    .toEqual(
      before.texts.map((value: any) => [
        value.item.pose.x + 60,
        value.item.pose.y + 50,
      ]),
    );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () =>
      ((await workspace.state()) as any).texts.map(
        (value: any) => value.item.pose,
      ),
    )
    .toEqual(before.texts.map((value: any) => value.item.pose));
  expect((await workspace.state()).cards[0]!.item.pose).toEqual(
    before.cards[0].item.pose,
  );
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 100, y: 550 } });
  await page.getByText("成员0", { exact: true }).click();
  await page.getByRole("button", { name: "编辑文字", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "独立文字" })).toHaveText(
    "成员0",
  );
});
test("光标改粗色只作用后来实际输入，重新定位继承当地样式并保留原生文字undo与创建历史", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 220, y: 240 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("Alpha Beta");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await editor.press("ControlOrMeta+a");
  await editor.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await editor.press("ArrowRight");
  await page.clock.install();
  await page.getByRole("button", { name: "加粗文字", exact: true }).click();
  await page.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByRole("button", { name: "红色文字", exact: true }).click();
  await page.clock.fastForward(2500);
  expect(((await workspace.state()) as any).texts[0].content.runs).toEqual([
    { text: "Alpha Beta" },
  ]);
  await editor.pressSequentially("红");
  await editor.press("ControlOrMeta+a");
  await editor.press("ArrowLeft");
  await editor.press("ArrowRight");
  await editor.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "加粗文字", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await editor.pressSequentially("X");
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveText("Alpha红 Beta");
  expect(((await workspace.state()) as any).texts).toHaveLength(1);
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveText("AlXpha红 Beta");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await page.clock.resume();
  expect(((await workspace.state()) as any).texts[0].content.runs).toEqual([
    { text: "AlXpha" },
    { text: "红", bold: true, color: "#ad343e" },
    { text: " Beta" },
  ]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts)
    .toEqual([]);
});
test("跨类型新建保共同层级，选中文字不临时置前，混合选区不展示单对象工具", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    commandId: "layer-old-card",
    projectId,
    type: "thought.create",
    expected: null,
    payload: {
      id: "layer-old-card",
      title: "混合中的卡片",
      text: "",
      x: 800,
      y: 300,
    },
  });
  await workspace.execute(page, {
    commandId: "layer-text",
    projectId,
    type: "text.create",
    expected: null,
    payload: {
      id: "layer-text",
      content: {
        runs: [
          {
            text: "文字与卡片保持共同的创建顺序，选中文字仍保留遮挡。".repeat(
              3,
            ),
          },
        ],
        fontSize: 18,
        lineHeight: 1.5,
        align: "left",
        widthMode: "auto",
        width: 320,
      },
      pose: { x: 200, y: 250, width: 320, height: 135 },
    },
  });
  await workspace.execute(page, {
    commandId: "layer-new-card",
    projectId,
    type: "thought.create",
    expected: null,
    payload: {
      id: "layer-new-card",
      title: "后来创建的遮挡卡片",
      text: "",
      x: 360,
      y: 250,
    },
  });
  await page.reload();
  const state = (await workspace.state()) as any,
    frontId = state.cards[1].item.id;
  const text = page.locator(".canvas-text-content"),
    textBox = (await text.boundingBox())!;
  const cardBox = (await page.locator(`[data-id="${frontId}"]`).boundingBox())!;
  const overlap = {
    x: Math.max(textBox.x, cardBox.x) + 12,
    y: Math.max(textBox.y, cardBox.y) + 12,
  };
  const hit = () =>
    page.evaluate(
      (point) =>
        document
          .elementFromPoint(point.x, point.y)
          ?.closest(".react-flow__node")
          ?.getAttribute("data-id"),
      overlap,
    );
  await expect.poll(hit).toBe(frontId);
  await text.click({ position: { x: 12, y: 12 } });
  await expect(
    page.getByRole("button", { name: "编辑文字", exact: true }),
  ).toBeVisible();
  expect(await hit()).toBe(frontId);
  await page
    .getByRole("button", { name: "混合中的卡片", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await expect(page.getByRole("toolbar", { name: "独立文字样式" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("toolbar", { name: "卡片操作" })).toHaveCount(0);
  await expect(page.locator(".text-resize")).toHaveCount(0);
  expect(await hit()).toBe(frontId);
  await page.reload();
  await expect.poll(hit).toBe(frontId);
});
test("左侧与四角调节保持对边锚点，缩小至9px仍按1.5行高并保留宽度模式", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, {
    commandId: "geometry-text",
    projectId,
    type: "text.create",
    expected: null,
    payload: {
      id: "geometry-text",
      content: {
        runs: [{ text: "短" }],
        fontSize: 18,
        lineHeight: 1.5,
        align: "left",
        widthMode: "fixed",
        width: 400,
      },
      pose: { x: 300, y: 300, width: 400, height: 27 },
    },
  });
  await page.reload();
  const text = page.locator(".canvas-text-content");
  await text.click();
  const origin = (await text.boundingBox())!;
  try {
    const left = (await page
      .getByRole("button", { name: "调整文字尺寸：左", exact: true })
      .boundingBox())!;
    await page.mouse.move(left.x + 4, left.y + 4);
    await page.mouse.down();
    await page.mouse.move(left.x - 96, left.y + 4, { steps: 5 });
    const preview = (await text.boundingBox())!;
    expect(preview.x).toBeCloseTo(origin.x - 100, 0);
    expect(preview.x + preview.width).toBeCloseTo(origin.x + origin.width, 0);
    await page.mouse.up();
    await expect
      .poll(async () => ((await workspace.state()) as any).texts[0].content)
      .toMatchObject({ fontSize: 18, width: 500, widthMode: "fixed" });
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect
      .poll(async () => Math.round((await text.boundingBox())!.width))
      .toBe(400);
    for (const [label, dx, dy, x, y] of [
      ["左上", 200, 13.5, 500, 313.5],
      ["右上", -200, 13.5, 300, 313.5],
      ["左下", 200, -13.5, 500, 300],
      ["右下", -200, -13.5, 300, 300],
    ] as const) {
      const corner = (await page
        .getByRole("button", { name: `调整文字尺寸：${label}`, exact: true })
        .boundingBox())!;
      await page.mouse.move(corner.x + 4, corner.y + 4);
      await page.mouse.down();
      await page.mouse.move(corner.x + 4 + dx, corner.y + 4 + dy, { steps: 5 });
      await page.mouse.up();
      await expect
        .poll(
          async () =>
            ((await workspace.state()) as any).texts[0].content.fontSize,
        )
        .toBeCloseTo(9, 1);
      const value = ((await workspace.state()) as any).texts[0];
      const atPublicRead = await text.boundingBox();
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      console.log("corner-geometry-render-sync", JSON.stringify({ label, version: value.versionId, atPublicRead, after: await text.boundingBox() }));
      expect(value.content).toMatchObject({ widthMode: "fixed" });
      expect(value.item.pose.x).toBeCloseTo(x, 0);
      expect(value.item.pose.y).toBeCloseTo(y, 0);
      expect((await text.boundingBox())!.width).toBeCloseTo(200, 0);
      expect((await text.boundingBox())!.height).toBeCloseTo(13.5, 0);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect
        .poll(
          async () =>
            ((await workspace.state()) as any).texts[0].content.fontSize,
        )
        .toBe(18);
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
    }
  } finally {
    await page.mouse.up();
  }
});
test("文字工具条在视口顶部右缘保持完整可操作，编辑颜色面板也不越界", async ({
  page,
  workspace,
}) => {
  const projectId = (await workspace.state()).project.id,
    viewport = page.viewportSize()!;
  await workspace.execute(page, {
    commandId: "edge-text",
    projectId,
    type: "text.create",
    expected: null,
    payload: {
      id: "edge-text",
      content: {
        runs: [{ text: "边缘" }],
        fontSize: 18,
        lineHeight: 1.5,
        align: "left",
        widthMode: "auto",
        width: 320,
      },
      pose: { x: viewport.width - 150, y: 5, width: 36, height: 27 },
    },
  });
  await page.reload();
  await page.locator(".canvas-text-content").click();
  const toolbar = page.getByRole("toolbar", {
      name: "独立文字样式",
      exact: true,
    }),
    canvas = (await page.locator("main.canvas").boundingBox())!;
  const assertBounds = async () => {
    const box = (await toolbar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(canvas.x + 8);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(box.y).toBeGreaterThanOrEqual(canvas.y + 8);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8);
  };
  await assertBounds();
  await page
    .getByRole("spinbutton", { name: "文字字号", exact: true })
    .fill("24");
  await page.getByRole("button", { name: "文字右对齐", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].content)
    .toMatchObject({ fontSize: 24, align: "right" });
  await page.getByRole("button", { name: "编辑文字", exact: true }).click();
  await assertBounds();
  await page.getByRole("button", { name: "文字颜色", exact: true }).click();
  const palette = (await page.locator(".text-color-panel").boundingBox())!;
  expect(palette.x + palette.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(palette.y).toBeGreaterThanOrEqual(canvas.y);
  expect(palette.y + palette.height).toBeLessThanOrEqual(viewport.height - 8);
  await page.getByRole("button", { name: "红色文字", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.pressSequentially("观察");
  await editor.press("Escape");
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].content.runs)
    .toEqual([{ text: "边缘" }, { text: "观察", color: "#ad343e" }]);
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.screenshot({
    path: process.env.FORKWISE_ISSUE22_VISUAL_PATH!,
    fullPage: true,
  });
});
