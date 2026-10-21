import { expectTextFontSize } from "./text-font-expectation";
import { test, expect } from "./writing-board-fixture";

test("真实浏览器拖入HTML和合成粘贴均只接收纯文本，编辑期间不嵌图片或正文块", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("原文");
  // An explicitly owned source fixture supplies native Chromium drag data.
  // This is real browser DnD; it does not read the OS clipboard or user files.
  await page.evaluate(() => {
    const source = document.createElement("iframe");
    source.id = "issue22-owned-drag-source";
    Object.assign(source.style, {
      position: "fixed",
      left: "40px",
      top: "120px",
      width: "120px",
      height: "60px",
      border: "0",
      zIndex: "500",
    });
    source.srcdoc =
      '<div id="source" draggable="true" style="padding:10px;background:white">拖动样例</div>';
    document.body.append(source);
  });
  const source = page
    .frameLocator("#issue22-owned-drag-source")
    .locator("#source");
  await source.evaluate((source) =>
    source.addEventListener("dragstart", (event) => {
      const data = (event as DragEvent).dataTransfer!;
      data.setData("text/plain", "拖入纯文本");
      data.setData(
        "text/html",
        '<h1>HTML标题</h1><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22/%3E"><p>HTML正文</p>',
      );
    }),
  );
  try {
    const bounds = (await editor.boundingBox())!;
    const drag = (await source.boundingBox())!;
    await page.mouse.move(drag.x + 20, drag.y + 20);
    await page.mouse.down();
    await page.mouse.move(drag.x + 40, drag.y + 25, { steps: 4 });
    await page.mouse.move(
      bounds.x + bounds.width - 2,
      bounds.y + bounds.height / 2,
      { steps: 8 },
    );
    await page.mouse.move(
      bounds.x + bounds.width - 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.up();
    await expect(editor.locator("img,h1,p,ul,table")).toHaveCount(0);
    await expect(editor).toHaveText("原文拖入纯文本");
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/plain", "粘贴纯文本");
      data.setData("text/html", '<h1>粘贴标题</h1><img src="invalid">');
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(editor.locator("img,h1,p,ul,table")).toHaveCount(0);
    await expect(editor).toHaveText("原文拖入纯文本粘贴纯文本");
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    expect(((await workspace.state()) as any).texts[0].content.runs).toEqual([
      { text: "原文拖入纯文本粘贴纯文本" },
    ]);
    expect((await workspace.state()).cards).toEqual([]);
  } finally {
    if (!page.isClosed())
      await page
        .evaluate(() =>
          document.getElementById("issue22-owned-drag-source")?.remove(),
        )
        .catch(() => {});
  }
});
test("对象样式丢ACK后重载保留原请求与排队对齐，显式恢复完整样式后才显示已保存", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("待确认样式");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  let retry = false;
  const commands: any[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "text.edit")
      return route.continue();
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (!retry) return route.abort("failed");
    return route.fulfill({ response });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("spinbutton", { name: "文字字号", exact: true })
    .fill("24");
  await expect(page.getByRole("status")).toHaveText("文字保存未完成");
  await page.getByRole("button", { name: "文字右对齐", exact: true }).click();
  const original = commands[0];
  await page.reload();
  await expect(
    page.getByRole("button", { name: "恢复独立文字草稿", exact: true }),
  ).toBeVisible();
  retry = true;
  const previous = commands.length;
  await page
    .getByRole("button", { name: "恢复独立文字草稿", exact: true })
    .click();
  await expect.poll(() => commands.length).toBeGreaterThan(previous);
  expect(commands[previous]).toEqual(original);
  await expect
    .poll(async () => ((await workspace.state()) as any).texts[0].content)
    .toMatchObject({
      fontSize: 24,
      align: "right",
      runs: [{ text: "待确认样式" }],
    });
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.reload();
  await expectTextFontSize(page.locator(".canvas-text-content"), 24);
  await expect(page.locator(".canvas-text-content")).toHaveCSS(
    "text-align",
    "right",
  );
  await expect(
    page.getByRole("button", { name: "恢复独立文字草稿", exact: true }),
  ).toHaveCount(0);
});
test("自动宽角点缩放后保模式和统一字号，复制及重开保留完整缩放内容", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("自动宽");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const before = (await page.locator(".canvas-text-content").boundingBox())!,
    corner = (await page
      .getByRole("button", { name: "调整文字尺寸：右下", exact: true })
      .boundingBox())!;
  await page.mouse.move(corner.x + 4, corner.y + 4);
  await page.mouse.down();
  await page.mouse.move(
    corner.x + 4 + before.width / 2,
    corner.y + 4 + before.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(
      async () => ((await workspace.state()) as any).texts[0].content.fontSize,
    )
    .toBeCloseTo(27, 1);
  const content = ((await workspace.state()) as any).texts[0].content;
  expect(content.widthMode).toBe("auto");
  expect(content.width).toBeCloseTo(480, 0);
  await page.getByRole("button", { name: "生成文字副本", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts.length)
    .toBe(2);
  await workspace.restart();
  await page.reload();
  for (const value of ((await workspace.state()) as any).texts)
    expect(value.content).toEqual(content);
});
test("几何在途确认先于undo及切项目，原目标移动与自动宽内容均完整保存", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("几何等待");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = ((await workspace.state()) as any).texts[0];
  let releaseResize!: () => void,
    releaseMove!: () => void,
    resizeSent = false,
    moveSent = false;
  const resize = new Promise<void>((resolve) => {
      releaseResize = resolve;
    }),
    move = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
  await page.route("**/api/mapping/execute", async (route) => {
    const type = route.request().postDataJSON().type;
    if (type !== "text.transform" && type !== "text.move")
      return route.continue();
    const response = await route.fetch();
    if (type === "text.transform") {
      resizeSent = true;
      await resize;
    } else {
      moveSent = true;
      await move;
    }
    await route.fulfill({ response });
  });
  try {
    const handle = (await page
      .getByRole("button", { name: "调整文字尺寸：右", exact: true })
      .boundingBox())!;
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    await page.mouse.move(handle.x + 104, handle.y + 4, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => resizeSent).toBe(true);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    releaseResize();
    await expect
      .poll(
        async () =>
          ((await workspace.state()) as any).texts[0].content.widthMode,
      )
      .toBe("auto");
    await expect
      .poll(async () => ((await workspace.state()) as any).texts[0].item.pose)
      .toEqual(original.item.pose);
    await page.locator(".canvas-text-content").click();
    const text = (await page.locator(".canvas-text-content").boundingBox())!;
    await page.mouse.move(text.x + 10, text.y + 10);
    await page.mouse.down();
    await page.mouse.move(text.x + 50, text.y + 40, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => moveSent).toBe(true);
    await page.getByRole("button", { name: "新建研究", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    releaseMove();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.locator(".canvas-text-content")).toHaveCount(0);
    const value = ((await workspace.state()) as any).texts[0];
    expect(value.item.pose.x).toBeCloseTo(original.item.pose.x + 40, 0);
    expect(value.item.pose.y).toBeCloseTo(original.item.pose.y + 30, 0);
    expect(value.content).toEqual(original.content);
  } finally {
    releaseResize();
    releaseMove();
  }
});
