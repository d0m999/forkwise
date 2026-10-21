import { expectTextFontSize } from "./text-font-expectation";
import { test, expect } from "./writing-board-fixture";

test("结束空白文字的删除ACK在途时停止接受编辑，撤销仍恢复完整原文", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("删除前原文");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await page.locator(".canvas-text-content").dblclick();
  await editor.fill("");
  let release!: () => void,
    commit!: () => void,
    sent = false,
    committed = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const beforeCommit = new Promise<void>((resolve) => {
    commit = resolve;
  });
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "text.delete")
      return route.continue();
    sent = true;
    await beforeCommit;
    const response = await route.fetch();
    committed = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await editor.press("Escape");
    await expect.poll(() => sent).toBe(true);
    await expect(editor).toHaveCount(0);
    await page.keyboard.type("删除确认期间的按键");
    commit();
    await expect.poll(() => committed).toBe(true);
    await expect(page.getByRole("status")).not.toHaveText("已保存到本机");
    release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(((await workspace.state()) as any).texts).toEqual([]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".canvas-text-content")).toHaveText("删除前原文");
  } finally {
    commit();
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("创建提交后丢ACK原键重试不增身份，重载后显式恢复原创建并继续首次输入", async ({
  page,
  workspace,
}) => {
  const commands: any[] = [];
  let fail = true;
  page.on("dialog", (dialog) => dialog.accept());
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "text.create")
      return route.continue();
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (fail) return route.abort("failed");
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  await expect(page.getByRole("status")).toHaveText("文字保存未完成");
  expect(((await workspace.state()) as any).texts).toHaveLength(1);
  fail = false;
  await page.getByRole("button", { name: "重试文字保存", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await expect(editor).toBeFocused();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await editor.fill("原身份首次输入");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  fail = true;
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 550, y: 400 } });
  await expect(page.getByRole("status")).toHaveText("文字保存未完成");
  const original = commands[2];
  await page.reload();
  await expect(
    page.getByRole("button", { name: "恢复独立文字草稿", exact: true }),
  ).toBeVisible();
  fail = false;
  await page
    .getByRole("button", { name: "恢复独立文字草稿", exact: true })
    .click();
  await expect(editor).toBeFocused();
  expect(commands[3]).toEqual(original);
  await editor.fill("恢复的首次输入");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const values = ((await workspace.state()) as any).texts;
  expect(values).toHaveLength(2);
  expect(values.map((t: any) => t.id)).toEqual([
    commands[0].payload.id,
    original.payload.id,
  ]);
  expect(values.map((t: any) => t.content.runs)).toEqual([
    [{ text: "原身份首次输入" }],
    [{ text: "恢复的首次输入" }],
  ]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => ((await workspace.state()) as any).texts.length)
    .toBe(1);
});

test("真实文字409保留两份完整样式并显式取舍，重载不重发已确定冲突且先保恢复副本", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("初稿");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const original = ((await workspace.state()) as any).texts[0],
    commands: any[] = [];
  let interfere = true,
    writes = 0;
  const remote = {
    ...original.content,
    runs: [{ text: "服务端新文字", bold: true, color: "#ad343e" }],
    fontSize: 30,
    align: "right",
    widthMode: "fixed",
    width: 420,
  };
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "text.edit" && command.payload.id === original.id) {
      commands.push(command);
      if (interfere) {
        interfere = false;
        await workspace.execute(page, {
          commandId: crypto.randomUUID(),
          projectId: command.projectId,
          type: "text.edit",
          expected: command.expected,
          payload: {
            id: original.id,
            content: ++writes === 1 ? remote : { ...remote, fontSize: 31 },
          },
        });
      }
    }
    return route.continue();
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator(".canvas-text-content").dblclick();
  await editor.fill("我的未确认文字");
  await page
    .getByRole("spinbutton", { name: "文字字号", exact: true })
    .fill("24");
  await editor.press("Escape");
  const panel = page.getByRole("region", {
    name: "独立文字保存冲突",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByLabel("已保存的独立文字", { exact: true }),
  ).toHaveValue("服务端新文字");
  await expect(panel.getByLabel("我的独立文字", { exact: true })).toHaveValue(
    "我的未确认文字",
  );
  const local = commands[0].payload.content,
    count = commands.length;
  await page.reload();
  await page
    .getByRole("button", { name: "恢复独立文字草稿", exact: true })
    .click();
  await expect(panel).toBeVisible();
  expect(commands).toHaveLength(count);
  await panel
    .getByRole("button", { name: "确认保留已保存的文字", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const values = ((await workspace.state()) as any).texts;
  expect(values.find((t: any) => t.id === original.id).content).toEqual(remote);
  expect(values.find((t: any) => t.id !== original.id).content).toEqual(local);
  expect(values.find((t: any) => t.id !== original.id).item.pose).toMatchObject(
    { x: original.item.pose.x + 24, y: original.item.pose.y + 24 },
  );
  interfere = true;
  await page
    .locator(".canvas-text-content")
    .filter({ hasText: "服务端新文字" })
    .dblclick();
  await editor.fill("明确采用的我的文字");
  await editor.press("Escape");
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", { name: "确认保留我的文字", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const resolved = ((await workspace.state()) as any).texts;
  expect(resolved).toHaveLength(3);
  expect(resolved.find((t: any) => t.id === original.id).content.runs).toEqual([
    { text: "明确采用的我的文字", bold: true, color: "#ad343e" },
  ]);
  expect(
    resolved
      .filter((t: any) => t.id !== original.id)
      .map((t: any) => t.content),
  ).toContainEqual({ ...remote, fontSize: 31 });
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".canvas-text-content")).toHaveCount(0);
});

test("文字切卡片或移动互斥，选中工具决定落点创建并在文字结束后返回选择", async ({
  page,
  workspace,
}) => {
  const text = page.getByRole("button", { name: "文字", exact: true }),
    card = page.getByRole("button", { name: "卡片", exact: true }),
    pan = page.getByRole("button", { name: "移动", exact: true }),
    select = page.getByRole("button", { name: "选择", exact: true });
  await text.click();
  await card.click();
  await expect(text).toHaveAttribute("aria-pressed", "false");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  expect(((await workspace.state()) as any).texts).toEqual([]);
  await page.keyboard.press("Escape");
  await text.click();
  await pan.click();
  await expect(text).toHaveAttribute("aria-pressed", "false");
  await expect(pan).toHaveAttribute("aria-pressed", "true");
  await expect(card).toHaveAttribute("aria-pressed", "false");
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 500, y: 400 } });
  expect(((await workspace.state()) as any).texts).toEqual([]);
  await select.click();
  await expect(pan).toHaveAttribute("aria-pressed", "false");
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await text.click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 500, y: 400 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("真正文字落点");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(text).toHaveAttribute("aria-pressed", "false");
  await expect(pan).toHaveAttribute("aria-pressed", "false");
  await expect(card).toHaveAttribute("aria-pressed", "false");
});

test("单字符短文字四角缩半保持真实宽高比例与固定对角锚点，持久Pose与undo一致", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("I");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  for (const [label, left, top] of [
    ["左上", true, true],
    ["右上", false, true],
    ["左下", true, false],
    ["右下", false, false],
  ] as const) {
    const before = (await page.locator(".canvas-text-content").boundingBox())!,
      saved = ((await workspace.state()) as any).texts[0];
    const handle = (await page
      .getByRole("button", { name: `调整文字尺寸：${label}`, exact: true })
      .boundingBox())!;
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    await page.mouse.move(
      handle.x + 4 + ((left ? 1 : -1) * before.width) / 2,
      handle.y + 4 + ((top ? 1 : -1) * before.height) / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          ((await workspace.state()) as any).texts[0].content.fontSize,
      )
      .toBeCloseTo(9, 1);
    await expect
      .poll(
        async () =>
          (await page.locator(".canvas-text-content").boundingBox())!.width,
      )
      .toBeCloseTo(before.width / 2, 1);
    const after = (await page.locator(".canvas-text-content").boundingBox())!;
    expect(after.height).toBeCloseTo(before.height / 2, 1);
    expect(after.x + (left ? after.width : 0)).toBeCloseTo(
      before.x + (left ? before.width : 0),
      1,
    );
    expect(after.y + (top ? after.height : 0)).toBeCloseTo(
      before.y + (top ? before.height : 0),
      1,
    );
    await expect
      .poll(
        async () => ((await workspace.state()) as any).texts[0].item.pose.width,
      )
      .toBeCloseTo(after.width, 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect
      .poll(async () => ((await workspace.state()) as any).texts[0].content)
      .toEqual(saved.content);
    await expect
      .poll(
        async () =>
          (await page.locator(".canvas-text-content").boundingBox())!.width,
      )
      .toBeCloseTo(before.width, 1);
    await page.locator(".canvas-text-content").click();
  }
});

test("聚焦尺寸把手可用方向键调左右宽与四角统一字号，每次一个原子transform且可撤销", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("键盘尺寸");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const original = ((await workspace.state()) as any).texts[0];
  for (const [label, key, left] of [
    ["右", "Shift+ArrowRight", false],
    ["左", "Shift+ArrowLeft", true],
  ] as const) {
    const bounds = (await page.locator(".canvas-text-content").boundingBox())!,
      handle = page.getByRole("button", {
        name: `调整文字尺寸：${label}`,
        exact: true,
      });
    await handle.focus();
    await handle.press(key);
    await expect
      .poll(async () => ((await workspace.state()) as any).texts[0].content)
      .toMatchObject({
        widthMode: "fixed",
        width: bounds.width + 10,
        fontSize: 18,
      });
    expect(((await workspace.state()) as any).texts[0].item.pose.x).toBeCloseTo(
      original.item.pose.x - (left ? 10 : 0),
      1,
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect
      .poll(async () => ((await workspace.state()) as any).texts[0].content)
      .toEqual(original.content);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await page.locator(".canvas-text-content").click();
  }
  for (const [label, key, left, top] of [
    ["左上", "Shift+ArrowLeft", true, true],
    ["右上", "Shift+ArrowRight", false, true],
    ["左下", "Shift+ArrowLeft", true, false],
    ["右下", "Shift+ArrowRight", false, false],
  ] as const) {
    const bounds = (await page.locator(".canvas-text-content").boundingBox())!,
      handle = page.getByRole("button", {
        name: `调整文字尺寸：${label}`,
        exact: true,
      });
    await handle.focus();
    await handle.press(key);
    await expect
      .poll(
        async () =>
          ((await workspace.state()) as any).texts[0].content.fontSize,
      )
      .toBeGreaterThan(18);
    const value = ((await workspace.state()) as any).texts[0];
    const atPublicRead = await page.locator(".canvas-text-content").boundingBox();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const after = (await page.locator(".canvas-text-content").boundingBox())!;
    console.log("keyboard-geometry-render-sync", JSON.stringify({ label, version: value.versionId, atPublicRead, after }));
    expect(value.content.widthMode).toBe("auto");
    expect(after.width / value.content.fontSize).toBeCloseTo(
      bounds.width / 18,
      1,
    );
    expect(after.height / value.content.fontSize).toBeCloseTo(1.5, 1);
    expect(after.x + (left ? after.width : 0)).toBeCloseTo(
      bounds.x + (left ? bounds.width : 0),
      1,
    );
    expect(after.y + (top ? after.height : 0)).toBeCloseTo(
      bounds.y + (top ? bounds.height : 0),
      1,
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect
      .poll(async () => ((await workspace.state()) as any).texts[0].content)
      .toEqual(original.content);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await page.locator(".canvas-text-content").click();
  }
});

test("结束编辑后的格式队列与几何真实409也移交显式冲突，保留后代样式并按原子Pose取舍", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("静态格式冲突");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const initial = ((await workspace.state()) as any).texts[0],
    sent: any[] = [];
  const remote = {
    ...initial.content,
    runs: [{ text: "外部文字", bold: true }],
    fontSize: 30,
    align: "center",
    widthMode: "fixed",
    width: 480,
  };
  let release!: () => void,
    rejected = false,
    format = true,
    geometry = false,
    geometryCommand: any;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    sent.push(command);
    if (command.type === "text.edit" && format) {
      format = false;
      await workspace.execute(page, {
        commandId: crypto.randomUUID(),
        projectId: command.projectId,
        type: "text.edit",
        expected: command.expected,
        payload: { id: initial.id, content: remote },
      });
      const response = await route.fetch();
      expect(response.status()).toBe(409);
      rejected = true;
      await gate;
      return route.fulfill({ response });
    }
    if (command.type === "text.transform" && geometry) {
      geometry = false;
      geometryCommand = command;
      await workspace.execute(page, {
        commandId: crypto.randomUUID(),
        projectId: command.projectId,
        type: "text.move",
        expected: command.expected.pose,
        payload: { id: initial.id, x: 700, y: 500 },
      });
      const response = await route.fetch();
      expect(response.status()).toBe(409);
      return route.fulfill({ response });
    }
    return route.continue();
  });
  page.on("dialog", (dialog) => dialog.accept());
  try {
    await page
      .getByRole("spinbutton", { name: "文字字号", exact: true })
      .fill("24");
    await expect.poll(() => rejected).toBe(true);
    await page.getByRole("button", { name: "文字右对齐", exact: true }).click();
    release();
    const panel = page.getByRole("region", {
      name: "独立文字保存冲突",
      exact: true,
    });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByLabel("我的独立文字预览", { exact: true }),
    ).toHaveCSS("font-size", "24px");
    await expect(
      panel.getByLabel("我的独立文字预览", { exact: true }),
    ).toHaveCSS("text-align", "right");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "恢复独立文字草稿", exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "恢复独立文字草稿", exact: true })
      .click();
    await expect(panel).toBeVisible();
    await panel
      .getByRole("button", { name: "确认保留已保存的文字", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    let values = ((await workspace.state()) as any).texts;
    expect(values.find((t: any) => t.id === initial.id).content).toEqual(
      remote,
    );
    expect(values.find((t: any) => t.id !== initial.id).content).toEqual({
      ...initial.content,
      fontSize: 24,
      align: "right",
    });
    expect(
      sent.filter(
        (c) =>
          c.commandId === sent.find((c) => c.type === "text.edit").commandId,
      ),
    ).toHaveLength(1);
    await page
      .locator(".canvas-text-content")
      .filter({ hasText: "外部文字" })
      .click();
    geometry = true;
    const handle = (await page
      .getByRole("button", { name: "调整文字尺寸：右", exact: true })
      .boundingBox())!;
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    await page.mouse.move(handle.x + 104, handle.y + 4, { steps: 5 });
    await page.mouse.up();
    await expect(panel).toBeVisible();
    await panel
      .getByRole("button", { name: "确认保留我的文字", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    values = ((await workspace.state()) as any).texts;
    expect(values).toHaveLength(3);
    expect(values.find((t: any) => t.id === initial.id)).toMatchObject({
      content: geometryCommand.payload.content,
      item: { pose: geometryCommand.payload.pose },
    });
    expect(
      values.find(
        (t: any) =>
          t.id !== initial.id && t.content.runs[0].text === "外部文字",
      ).item.pose,
    ).toMatchObject({ x: 724, y: 524 });
    expect(
      sent.filter((c) => c.commandId === geometryCommand.commandId),
    ).toHaveLength(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("单文字移动真实409选择保留已保存位置后清理本地预览，并保留本次位置的恢复副本", async ({
  page,
  workspace,
}) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("移动位置冲突");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const initial = ((await workspace.state()) as any).texts[0],
    before = (await page.locator(".canvas-text-content").boundingBox())!;
  let command: any;
  await page.route("**/api/mapping/execute", async (route) => {
    const value = route.request().postDataJSON();
    if (value.type !== "text.move") return route.continue();
    command = value;
    await workspace.execute(page, {
      commandId: crypto.randomUUID(),
      projectId: value.projectId,
      type: "text.move",
      expected: value.expected,
      payload: { id: initial.id, x: 700, y: 500 },
    });
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    return route.fulfill({ response });
  });
  await page.mouse.move(before.x + 10, before.y + 10);
  await page.mouse.down();
  await page.mouse.move(before.x + 50, before.y + 40, { steps: 5 });
  await page.mouse.up();
  const panel = page.getByRole("region", {
    name: "独立文字保存冲突",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", { name: "确认保留已保存的文字", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const values = ((await workspace.state()) as any).texts;
  expect(values).toHaveLength(2);
  expect(values.find((t: any) => t.id === initial.id).item.pose).toMatchObject({
    x: 700,
    y: 500,
  });
  expect(values.find((t: any) => t.id !== initial.id)).toMatchObject({
    content: initial.content,
    item: { pose: { x: command.payload.x + 24, y: command.payload.y + 24 } },
  });
  const target = page.locator(
    `.react-flow__node[data-id="${initial.item.id}"] .canvas-text-content`,
  );
  await expect
    .poll(async () => (await target.boundingBox())!.x)
    .toBeCloseTo(before.x + 700 - initial.item.pose.x, 1);
  expect((await target.boundingBox())!.y).toBeCloseTo(
    before.y + 500 - initial.item.pose.y,
    1,
  );
});

test("静态格式绑定显示版本，prepare之前外部正文及颜色更新不会被旧runs静默覆盖", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("屏幕旧正文");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const initial = ((await workspace.state()) as any).texts[0];
  const remote = { ...initial.content, runs: [{ text: "外部新正文", color: "#ad343e" }] };
  const projectId = ((await workspace.state()) as any).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: "text.edit", expected: initial.versionId, payload: { id: initial.id, content: remote } });
  await expect(page.locator(".canvas-text-content")).toHaveText("屏幕旧正文");
  await page.getByRole("button", { name: "加粗文字", exact: true }).click();
  const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
  await expect(panel).toBeVisible();
  expect(((await workspace.state()) as any).texts[0].content).toEqual(remote);
  await expect(panel.getByLabel("我的独立文字", { exact: true })).toHaveValue("屏幕旧正文");
  await expect(panel.getByLabel("已保存的独立文字", { exact: true })).toHaveValue("外部新正文");
  await expect(panel.getByLabel("我的独立文字预览", { exact: true }).locator("span")).toHaveCSS("font-weight", "700");
  await panel.getByRole("button", { name: "确认保留已保存的文字", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const values = ((await workspace.state()) as any).texts;
  expect(values).toHaveLength(2);
  expect(values.find((t: any) => t.id === initial.id).content).toEqual(remote);
  expect(values.find((t: any) => t.id !== initial.id).content.runs).toEqual([{ text: "屏幕旧正文", bold: true }]);
});

test("几何计算保留显示Pose依赖，预先外部移动后的键盘调宽和指针角点均原子冲突恢复", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("几何依赖");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const id = ((await workspace.state()) as any).texts[0].id;
  const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
  for (const method of ["keyboard", "pointer"]) {
    const state = (await workspace.state()) as any;
    const initial = state.texts.find((t: any) => t.id === id);
    const target = page.locator(`.react-flow__node[data-id="${initial.item.id}"] .canvas-text-content`);
    await target.click();
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.move", expected: initial.item.versionId, payload: { id, x: initial.item.pose.x + 130, y: initial.item.pose.y + 80 } });
    const remote = ((await workspace.state()) as any).texts.find((t: any) => t.id === id);
    if (method === "keyboard") {
      await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).press("Shift+ArrowRight");
    } else {
      const corner = (await page.getByRole("button", { name: "调整文字尺寸：右下", exact: true }).boundingBox())!;
      await page.mouse.move(corner.x + 4, corner.y + 4);
      await page.mouse.down();
      await page.mouse.move(corner.x + 34, corner.y + 14, { steps: 5 });
      await page.mouse.up();
    }
    await expect(panel).toBeVisible();
    expect(((await workspace.state()) as any).texts.find((t: any) => t.id === id)).toEqual(remote);
    await panel.getByRole("button", { name: "确认保留已保存的文字", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const values = ((await workspace.state()) as any).texts;
    expect(values.find((t: any) => t.id === id).content).toEqual(initial.content);
    expect(values.find((t: any) => t.id === id).item.pose).toEqual(remote.item.pose);
    const copy = values.find((t: any) => !state.texts.some((old: any) => old.id === t.id));
    expect(copy.item.pose).toMatchObject({ x: initial.item.pose.x + 24, y: initial.item.pose.y + 24 });
    if (method === "keyboard") expect(copy.content).toMatchObject({ fontSize: 18, widthMode: "fixed", width: initial.item.pose.width + 10 });
    else expect(copy.content.fontSize).toBeGreaterThan(initial.content.fontSize);
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
  }
});

test("确定404的编辑格式与几何保完整本地意图，重载显式恢复新身份副本后释放导航", async ({ page, workspace }) => {
  page.on("dialog", (dialog) => dialog.accept());
  const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
  for (const method of ["edit", "format", "geometry"]) {
    await page.getByRole("button", { name: "文字", exact: true }).click();
    await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
    const editor = page.getByRole("textbox", { name: "独立文字" });
    await editor.fill(`被删除的${method}`);
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    let state = (await workspace.state()) as any;
    const created = state.texts.at(-1);
    const styled = { ...created.content, runs: [{ text: `被删除的${method}`, bold: true, color: "#ad343e" }], fontSize: 26, align: "right", widthMode: "fixed", width: 400 };
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.edit", expected: created.versionId, payload: { id: created.id, content: styled } });
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const target = page.locator(`.react-flow__node[data-id="${created.item.id}"] .canvas-text-content`);
    await target.click();
    if (method === "edit") await target.dblclick();
    state = (await workspace.state()) as any;
    const initial = state.texts.find((t: any) => t.id === created.id);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.delete", expected: { text: initial.versionId, pose: initial.item.versionId }, payload: { id: initial.id } });
    const rejected: any[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      if (route.request().postDataJSON().payload.id !== initial.id) return route.continue();
      rejected.push(route.request().postDataJSON());
      const response = await route.fetch();
      expect(response.status()).toBe(404);
      return route.fulfill({ response });
    });
    let content = styled;
    if (method === "edit") {
      await editor.press("End");
      await editor.pressSequentially("本地新增");
      content = { ...styled, runs: [{ text: `被删除的${method}本地新增`, bold: true, color: "#ad343e" }] };
      await editor.press("Escape");
    } else if (method === "format") {
      await page.getByRole("button", { name: "加粗文字", exact: true }).click();
      content = { ...styled, runs: [{ text: `被删除的${method}`, color: "#ad343e" }] } as any;
    } else {
      await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).press("Shift+ArrowRight");
      content = { ...styled, width: 410 };
    }
    await expect(panel).toBeVisible();
    expect(((await workspace.state()) as any).texts.some((t: any) => t.id === initial.id)).toBe(false);
    await expect(panel.getByLabel("已保存的独立文字", { exact: true })).toHaveValue("原文字已删除");
    await page.reload();
    await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click();
    await expect(panel).toBeVisible();
    expect(rejected).toHaveLength(1);
    await panel.getByRole("button", { name: "将我的文字恢复为副本", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const values = ((await workspace.state()) as any).texts;
    expect(values.some((t: any) => t.id === initial.id)).toBe(false);
    const copy = values.find((t: any) => t.content.runs[0].text === content.runs[0].text);
    expect(copy.id).not.toBe(initial.id);
    expect(copy.content).toEqual(content);
    expect(copy.item.pose).toMatchObject({ x: initial.item.pose.x + 24, y: initial.item.pose.y + 24 });
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("独立文字可真实Tab聚焦并方向键平移撤销，尺寸及编辑IME不误移且混合选择原子移动", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 350, y: 350 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("键盘平移文字");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const target = page.locator(".canvas-text-content");
  for (let index = 0; index < 50 && !(await target.evaluate((element) => element === document.activeElement)); index++) await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  const initial = ((await workspace.state()) as any).texts[0];
  await target.press("ArrowRight");
  await expect.poll(async () => ((await workspace.state()) as any).texts[0].item.pose.x).toBe(initial.item.pose.x + 10);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await target.press("ArrowDown");
  await expect.poll(async () => ((await workspace.state()) as any).texts[0].item.pose.y).toBe(initial.item.pose.y + 10);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => ((await workspace.state()) as any).texts[0].item.pose.y).toBe(initial.item.pose.y);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => ((await workspace.state()) as any).texts[0].item.pose).toEqual(initial.item.pose);
  await target.click();
  await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).press("ArrowRight");
  await expect.poll(async () => ((await workspace.state()) as any).texts[0].content.width).toBe(initial.item.pose.width + 1);
  expect(((await workspace.state()) as any).texts[0].item.pose).toMatchObject({ x: initial.item.pose.x, y: initial.item.pose.y });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => ((await workspace.state()) as any).texts[0].content).toEqual(initial.content);
  await target.dblclick();
  await editor.press("ArrowLeft");
  await editor.dispatchEvent("compositionstart");
  await editor.dispatchEvent("keydown", { key: "ArrowRight", code: "ArrowRight", isComposing: true });
  await editor.dispatchEvent("keyup", { key: "ArrowRight", code: "ArrowRight", isComposing: true });
  await editor.dispatchEvent("compositionend");
  expect(((await workspace.state()) as any).texts[0].item.pose).toEqual(initial.item.pose);
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await target.focus();
  await target.dispatchEvent("keydown", { key: "ArrowRight", code: "ArrowRight", isComposing: true });
  await target.dispatchEvent("keyup", { key: "ArrowRight", code: "ArrowRight", isComposing: true });
  await target.press("a");
  expect(((await workspace.state()) as any).texts[0].item.pose).toEqual(initial.item.pose);
  expect(((await workspace.state()) as any).texts[0].content).toEqual(initial.content);
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 80, y: 100 } });
  await page.getByLabel("卡片标题", { exact: true }).fill("混合键盘卡片");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const before = (await workspace.state()) as any;
  await target.click();
  await page.keyboard.down("Shift");
  await page.getByRole("button", { name: "混合键盘卡片", exact: true }).click();
  await page.keyboard.up("Shift");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await target.focus();
  await target.press("ArrowDown");
  await expect.poll(async () => ((await workspace.state()) as any).cards[0].item.pose.y).toBe(before.cards[0].item.pose.y + 10);
  expect(((await workspace.state()) as any).texts[0].item.pose.y).toBe(before.texts[0].item.pose.y + 10);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => ((await workspace.state()) as any).cards[0].item.pose).toEqual(before.cards[0].item.pose);
  expect(((await workspace.state()) as any).texts[0].item.pose).toEqual(before.texts[0].item.pose);
});

test("本队列测量ACK在手势期间推进Pose依赖，结束编辑立即调宽不误判外部冲突", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("测量后调宽");
  await editor.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  let release!: () => void, held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "text.layout") return route.continue();
    const response = await route.fetch();
    if (!held) { held = true; await gate; }
    await route.fulfill({ response });
  });
  try {
    await page.locator(".canvas-text-content").dblclick();
    await page.getByRole("spinbutton", { name: "文字字号", exact: true }).fill("24");
    await editor.press("Escape");
    await expect.poll(() => held).toBe(true);
    await expectTextFontSize(page.locator(".canvas-text-content"), 24);
    const before = (await page.locator(".canvas-text-content").boundingBox())!;
    const handle = (await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).boundingBox())!;
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    release();
    await page.mouse.move(handle.x + 44, handle.y + 4, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(page.getByRole("region", { name: "独立文字保存冲突", exact: true })).toHaveCount(0);
    const value = ((await workspace.state()) as any).texts[0];
    expect(value.content).toMatchObject({ fontSize: 24, widthMode: "fixed", width: before.width + 40 });
    expect(value.item.pose).toMatchObject({ x: 300, y: 300 });
    await page.getByRole("button", { name: "生成文字副本", exact: true }).click();
    await expect.poll(async () => ((await workspace.state()) as any).texts.length).toBe(2);
    expect(((await workspace.state()) as any).texts[1].content).toEqual(value.content);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("整对象字号ACK在途后立即调宽沿本机确切内容版本继续，保完整样式且不误报冲突", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("格式后调宽");
  await editor.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  let release!: () => void, held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/mapping/execute", async (route) => {
    if (route.request().postDataJSON().type !== "text.edit") return route.continue();
    const response = await route.fetch();
    if (!held) { held = true; await gate; }
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("spinbutton", { name: "文字字号", exact: true }).fill("24");
    await expect.poll(() => held).toBe(true);
    await expectTextFontSize(page.locator(".canvas-text-content"), 24);
    const before = (await page.locator(".canvas-text-content").boundingBox())!;
    const handle = (await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).boundingBox())!;
    await page.mouse.move(handle.x + 4, handle.y + 4);
    await page.mouse.down();
    await page.mouse.move(handle.x + 44, handle.y + 4, { steps: 5 });
    await page.mouse.up();
    release();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(page.getByRole("region", { name: "独立文字保存冲突", exact: true })).toHaveCount(0);
    const value = ((await workspace.state()) as any).texts[0];
    expect(value.content).toMatchObject({ runs: [{ text: "格式后调宽" }], fontSize: 24, widthMode: "fixed", width: before.width + 40 });
    expect(value.item.pose).toMatchObject({ x: 300, y: 300 });
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => ((await workspace.state()) as any).texts[0].content).toMatchObject({ fontSize: 24, widthMode: "auto" });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("混合移动未知ACK保持原键，确定409保整组意图重载显式放弃并释放导航且不部分写", async ({ page, workspace }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 350, y: 350 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("混合冲突文字"); await editor.press("Escape");
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 80, y: 100 } });
  await page.getByLabel("卡片标题", { exact: true }).fill("混合冲突卡片");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".canvas-text-content").click({ modifiers: ["Shift"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  let mode = "unknown"; const commands: any[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "canvas.move") return route.continue();
    commands.push(command);
    if (mode === "unknown") { mode = "pass"; await route.fetch(); return route.abort("failed"); }
    if (mode === "conflict") {
      mode = "pass";
      const text = command.payload.targets.find((t: any) => t.kind === "text");
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: command.projectId, type: "text.move", expected: command.expected[text.itemId], payload: { id: text.id, x: text.x + 90, y: text.y } });
      const response = await route.fetch(); expect(response.status()).toBe(409); return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "移动卡片：方向键调整位置", exact: true }).press("ArrowRight");
  await expect(page.getByRole("status")).toHaveText("文字保存未完成");
  await expect(page.getByRole("region", { name: "混合移动保存冲突", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "重试文字保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect(commands[1]).toEqual(commands[0]);
  const before = (await workspace.state()) as any;
  mode = "conflict";
  const card = (await page.getByRole("button", { name: "混合冲突卡片", exact: true }).boundingBox())!;
  await page.mouse.move(card.x + 20, card.y + 10); await page.mouse.down();
  await page.mouse.move(card.x + 60, card.y + 40, { steps: 5 }); await page.mouse.up();
  const panel = page.getByRole("region", { name: "混合移动保存冲突", exact: true });
  await expect(panel).toBeVisible();
  const rejected = commands[2];
  expect(rejected.payload.targets).toHaveLength(2);
  const remote = (await workspace.state()) as any;
  expect(remote.cards[0].item.pose).toEqual(before.cards[0].item.pose);
  expect(remote.texts[0].item.pose.x).toBe(rejected.payload.targets.find((t: any) => t.kind === "text").x + 90);
  const shown = await panel.locator("tbody tr").allTextContents();
  expect(shown).toHaveLength(2);
  for (const [index, target] of rejected.payload.targets.entries()) expect(shown[index]).toContain(`${target.x}, ${target.y}`);
  await page.reload();
  await page.getByRole("button", { name: "恢复混合移动草稿", exact: true }).click();
  await expect(panel).toBeVisible();
  expect(commands).toHaveLength(3);
  expect(await panel.locator("tbody tr").allTextContents()).toEqual(shown);
  await panel.getByRole("button", { name: "放弃本次混合移动，保留已保存位置", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await workspace.state()).cards[0].item.pose).toEqual(remote.cards[0].item.pose);
  expect(((await workspace.state()) as any).texts[0].item.pose).toEqual(remote.texts[0].item.pose);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("等待本机字号ACK后编辑沿完整确认样式和版本续写，真正外部正文竞争仍明确冲突", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("确认后续写"); await editor.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const initial = (await workspace.state()) as any;
  let release!: () => void, held = false, receipt: any;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const commands: any[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "text.edit") return route.continue();
    commands.push(command);
    const response = await route.fetch();
    if (!held) { held = true; receipt = await response.json(); await gate; }
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("spinbutton", { name: "文字字号", exact: true }).fill("24");
    await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "编辑文字", exact: true }).click();
    release();
    await expect(editor).toBeVisible();
    await expectTextFontSize(editor, 24);
    await editor.press("End"); await editor.pressSequentially("!"); await editor.press("Escape");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const saved = ((await workspace.state()) as any).texts[0];
    expect(saved.content).toEqual({ ...initial.texts[0].content, fontSize: 24, runs: [{ text: "确认后续写!" }] });
    expect(commands[1].expected).toBe(receipt.textVersions.text);
    expect(commands[1].projectId).toBe(initial.project.id);
    const external = { ...saved.content, runs: [{ text: "外部真实正文", color: "#ad343e" }] };
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: initial.project.id, type: "text.edit", expected: saved.versionId, payload: { id: saved.id, content: external } });
    await page.locator(".canvas-text-content").dblclick();
    await expect(editor).toBeVisible();
    await editor.press("End"); await editor.pressSequentially("?"); await editor.press("Escape");
    await expect(page.getByRole("region", { name: "独立文字保存冲突", exact: true })).toBeVisible();
    expect(((await workspace.state()) as any).texts[0].content).toEqual(external);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("移动prepare确定源已删除时持久保完整意图并清预览，重载显式副本恢复后释放导航", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 330, y: 270 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("移动前已删除"); await editor.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const created = ((await workspace.state()) as any).texts[0];
  const content = { ...created.content, runs: [{ text: "移动前已删除", bold: true, color: "#ad343e" }], fontSize: 26, align: "right", widthMode: "fixed", width: 400 };
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: created.projectId ?? (await workspace.state()).project.id, type: "text.edit", expected: created.versionId, payload: { id: created.id, content } });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const node = page.locator(`.react-flow__node[data-id="${created.item.id}"]`);
  const target = node.locator(".canvas-text-content"); await target.click();
  const state = (await workspace.state()) as any, initial = state.texts[0];
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.delete", expected: { text: initial.versionId, pose: initial.item.versionId }, payload: { id: initial.id } });
  const moves: any[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "text.move") moves.push(command);
    await route.continue();
  });
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 }); await page.mouse.up();
  const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
  await expect(panel).toBeVisible();
  await expect(node).toHaveCount(0);
  await expect(panel.getByLabel("已保存的独立文字", { exact: true })).toHaveValue("原文字已删除");
  await expect(panel.getByLabel("我的独立文字", { exact: true })).toHaveValue("移动前已删除");
  await expect(panel.getByLabel("我的独立文字预览", { exact: true })).toHaveCSS("font-size", "26px");
  await expect(panel).toContainText(`位置 ${initial.item.pose.x + 40}, ${initial.item.pose.y + 20}`);
  expect(((await workspace.state()) as any).texts).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click();
  await expect(panel).toBeVisible();
  expect(moves).toEqual([]);
  await panel.getByRole("button", { name: "将我的文字恢复为副本", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const copies = ((await workspace.state()) as any).texts;
  expect(copies).toHaveLength(1);
  expect(copies[0].id).not.toBe(initial.id);
  expect(copies[0].item.id).not.toBe(initial.item.id);
  expect(copies[0].content).toEqual(content);
  expect(copies[0].item.pose).toMatchObject({ x: initial.item.pose.x + 64, y: initial.item.pose.y + 44 });
  expect(moves).toEqual([]);
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("副本prepare确定源已删除时保完整快照，同目标后续队列退役且重载可显式恢复新身份", async ({ page, workspace }) => {
  for (const mode of ["queue", "reload"]) {
    const text = `副本源已删除${mode}`;
    await page.getByRole("button", { name: "文字", exact: true }).click();
    await page.locator(".react-flow__pane").click({ position: { x: 330, y: 270 } });
    const editor = page.getByRole("textbox", { name: "独立文字" });
    await editor.fill(text); await editor.press("Escape");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    let state = (await workspace.state()) as any;
    const created = state.texts.find((value: any) => value.content.runs[0].text === text);
    const content = { ...created.content, runs: [{ text, bold: true, color: "#ad343e" }], fontSize: 26, align: "right", widthMode: "fixed", width: 400 };
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.edit", expected: created.versionId, payload: { id: created.id, content } });
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const node = page.locator(`.react-flow__node[data-id="${created.item.id}"]`);
    await node.locator(".canvas-text-content").click();
    state = (await workspace.state()) as any;
    const initial = state.texts.find((value: any) => value.id === created.id);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.delete", expected: { text: initial.versionId, pose: initial.item.versionId }, payload: { id: initial.id } });
    let held = false, hold = true, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const copies: any[] = [];
    await page.route("**/api/mapping/execute", async (route) => {
      const command = route.request().postDataJSON();
      if (command.type === "text.copy") copies.push(command);
      await route.continue();
    });
    await page.route("**/api/mapping/projects/*/map?**", async (route) => {
      if (!hold || new URL(route.request().url()).searchParams.get("view") !== "index") return route.continue();
      hold = false;
      const response = await route.fetch(); held = true; await gate;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole("button", { name: "生成文字副本", exact: true }).click();
      await expect.poll(() => held).toBe(true);
      if (mode === "queue") await page.getByRole("button", { name: "生成文字副本", exact: true }).click();
      release();
      const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
      await expect(panel).toBeVisible();
      await expect(node).toHaveCount(0);
      await expect(panel.getByLabel("我的独立文字", { exact: true })).toHaveValue(text);
      await expect(panel.getByLabel("已保存的独立文字", { exact: true })).toHaveValue("原文字已删除");
      if (mode === "reload") {
        await page.reload();
        await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click();
        await expect(panel).toBeVisible();
      }
      expect(copies).toEqual([]);
      await panel.getByRole("button", { name: "将我的文字恢复为副本", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole("status")).toHaveText("已保存到本机");
      const values = ((await workspace.state()) as any).texts;
      expect(values.some((value: any) => value.id === initial.id)).toBe(false);
      const recovered = values.filter((value: any) => value.content.runs[0].text === text);
      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).not.toBe(initial.id);
      expect(recovered[0].item.id).not.toBe(initial.item.id);
      expect(recovered[0].content).toEqual(content);
      expect(recovered[0].item.pose).toMatchObject({ x: initial.item.pose.x + 24, y: initial.item.pose.y + 24 });
      expect(copies).toEqual([]);
    } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  }
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
});

test("移动prepare外部位置已变时显式冲突不拉回，未知读取和丢ACK仍保队列及原请求", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("位置先变化"); await editor.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const initial = ((await workspace.state()) as any).texts[0];
  const node = page.locator(`.react-flow__node[data-id="${initial.item.id}"]`), target = node.locator(".canvas-text-content");
  await target.click();
  let failRead = true, loseAck = true;
  const moves: any[] = [];
  await page.route("**/api/mapping/projects/*/map?**", async (route) => {
    if (failRead && new URL(route.request().url()).searchParams.get("view") === "index") { failRead = false; return route.abort("failed"); }
    return route.continue();
  });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "text.move") return route.continue();
    moves.push(command);
    if (loseAck) { loseAck = false; await route.fetch(); return route.abort("failed"); }
    return route.continue();
  });
  try {
    await target.press("ArrowRight");
    await expect(page.getByRole("status")).toHaveText("文字保存未完成");
    expect(moves).toEqual([]);
    expect(((await workspace.state()) as any).texts[0].item.pose).toEqual(initial.item.pose);
    const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "重试文字保存", exact: true }).click();
    await expect.poll(() => moves.length).toBe(1);
    await expect(page.getByRole("status")).toHaveText("文字保存未完成");
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "重试文字保存", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(moves).toHaveLength(2);
    expect(moves[1]).toEqual(moves[0]);
    const state = (await workspace.state()) as any, before = state.texts[0];
    expect(before.item.pose).toMatchObject({ x: initial.item.pose.x + 10, y: initial.item.pose.y });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.move", expected: before.item.versionId, payload: { id: before.id, x: 430, y: 280 } });
    const remote = ((await workspace.state()) as any).texts[0];
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 }); await page.mouse.up();
    await expect(panel).toBeVisible();
    await expect(node).toHaveCSS("transform", "matrix(1, 0, 0, 1, 430, 280)");
    await expect(panel).toContainText(`位置 ${before.item.pose.x + 40}, ${before.item.pose.y + 20}`);
    await expect(panel).toContainText("位置 430, 280");
    expect(((await workspace.state()) as any).texts[0].item).toEqual(remote.item);
    await panel.getByRole("button", { name: "确认保留已保存的文字", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const values = ((await workspace.state()) as any).texts;
    expect(values.find((text: any) => text.id === initial.id).item).toEqual(remote.item);
    const copy = values.find((text: any) => text.id !== initial.id);
    expect(copy.content).toEqual(initial.content);
    expect(copy.item.pose).toMatchObject({ x: before.item.pose.x + 64, y: before.item.pose.y + 44 });
    expect(moves).toHaveLength(2);
    await page.getByRole("button", { name: "新建研究", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});

test("副本prepare在途后排样式与冻结副本分别持久恢复，未知恢复ACK按各自原请求续完", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 200 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("副本与后排样式"); await editor.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  let state = (await workspace.state()) as any;
  const created = state.texts[0], content = { ...created.content, runs: [{ text: "副本与后排样式", bold: true, color: "#ad343e" }], fontSize: 26, align: "right", widthMode: "fixed", width: 400 };
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.edit", expected: created.versionId, payload: { id: created.id, content } });
  await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".canvas-text-content").click();
  state = (await workspace.state()) as any; const initial = state.texts[0];
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.delete", expected: { text: initial.versionId, pose: initial.item.versionId }, payload: { id: initial.id } });
  let hold = true, held = false, release!: () => void, lose = true;
  const gate = new Promise<void>((resolve) => { release = resolve; }), creates: any[] = [], stale: any[] = [];
  await page.route("**/api/mapping/projects/*/map?**", async (route) => {
    if (!hold || new URL(route.request().url()).searchParams.get("view") !== "index") return route.continue();
    hold = false; const response = await route.fetch(); held = true; await gate; await route.fulfill({ response });
  });
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "text.copy" || command.type === "text.edit") stale.push(command);
    if (command.type === "text.create") {
      creates.push(command);
      if (lose) { lose = false; await route.fetch(); return route.abort("failed"); }
    }
    return route.continue();
  });
  try {
    await page.getByRole("button", { name: "生成文字副本", exact: true }).click(); await expect.poll(() => held).toBe(true);
    await page.getByRole("spinbutton", { name: "文字字号", exact: true }).fill("32");
    await page.getByRole("button", { name: "文字居中", exact: true }).click();
    await expectTextFontSize(page.locator(".canvas-text-content"), 32);
    await expect(page.locator(".canvas-text-content")).toHaveCSS("text-align", "center");
    release();
    const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
    await expect(panel).toBeVisible();
    await page.reload(); await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click();
    await expect(panel).toBeVisible();
    const recover = panel.getByRole("button", { name: /将我的文字恢复为副本|恢复副本快照与后续样式/ });
    await recover.click(); await expect(page.getByRole("status")).toHaveText("文字保存未完成");
    await expect(panel).toBeVisible();
    await recover.click(); await expect(panel).toHaveCount(0); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const values = ((await workspace.state()) as any).texts;
    expect(values.map((value: any) => value.content)).toContainEqual({ ...content, fontSize: 32, align: "center" });
    expect(values.map((value: any) => value.content)).toContainEqual(content);
    expect(values).toHaveLength(2);
    for (const value of values) { expect(value.id).not.toBe(initial.id); expect(value.item.id).not.toBe(initial.item.id); }
    expect(creates[1]).toEqual(creates[0]); expect(creates).toHaveLength(3); expect(stale).toEqual([]);
    await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(((await workspace.state()) as any).texts.map((value: any) => value.content)).toEqual(values.map((value: any) => value.content));
    await page.getByRole("button", { name: "新建研究", exact: true }).click(); await expect(page.getByRole("tab")).toHaveCount(2);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("移动与变换冲突接管后排样式，重载保留我的完整版本并以一次undo恢复两域", async ({ page, workspace }) => {
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/mapping/execute")) {
      console.log("conflict-resolution-public-trace", JSON.stringify({ command: response.request().postDataJSON(), status: response.status(), result: await response.json() }));
    }
  });
  for (const method of ["move", "transform"]) {
    const text = `几何后排样式${method}`;
    await page.getByRole("button", { name: "文字", exact: true }).click();
    await page.locator(".react-flow__pane").click({ position: { x: 300, y: 200 } });
    const editor = page.getByRole("textbox", { name: "独立文字" });
    await editor.fill(text); await editor.press("Escape"); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    let state = (await workspace.state()) as any;
    const created = state.texts.find((value: any) => value.content.runs[0].text === text);
    const content = { ...created.content, runs: [{ text, bold: true, color: "#ad343e" }], fontSize: 26, align: "right", widthMode: "fixed", width: 400 };
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.edit", expected: created.versionId, payload: { id: created.id, content } });
    await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const node = page.locator(`.react-flow__node[data-id="${created.item.id}"]`), target = node.locator(".canvas-text-content"); await target.click();
    state = (await workspace.state()) as any; const initial = state.texts.find((value: any) => value.id === created.id);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.move", expected: initial.item.versionId, payload: { id: initial.id, x: 430, y: 280 } });
    const remote = ((await workspace.state()) as any).texts.find((value: any) => value.id === initial.id);
    let hold = true, held = false, release!: () => void, sawRejection = false;
    const gate = new Promise<void>((resolve) => { release = resolve; }), commands: any[] = [];
    await page.route("**/api/mapping/projects/*/map?**", async (route) => {
      if (!hold || new URL(route.request().url()).searchParams.get("view") !== "index") return route.continue();
      hold = false; const response = await route.fetch(); held = true; await gate; await route.fulfill({ response });
    });
    await page.route("**/api/mapping/execute", async (route) => {
      const command = route.request().postDataJSON();
      if (command.payload.id === initial.id && ["text.move", "text.transform", "text.edit"].includes(command.type)) commands.push(command);
      if (method === "transform" && command.type === "text.transform" && command.payload.id === initial.id && !sawRejection) {
        sawRejection = true; const response = await route.fetch(); expect(response.status()).toBe(409); return route.fulfill({ response });
      }
      return route.continue();
    });
    try {
      if (method === "move") {
        const box = (await target.boundingBox())!;
        await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
        await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 }); await page.mouse.up();
      } else await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).press("Shift+ArrowRight");
      await expect.poll(() => held).toBe(true);
      await page.getByRole("spinbutton", { name: "文字字号", exact: true }).fill("32");
      await page.getByRole("button", { name: "文字居中", exact: true }).click();
      await expectTextFontSize(target, 32); await expect(target).toHaveCSS("text-align", "center");
      release();
      const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
      await expect(panel).toBeVisible();
      await page.reload(); await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click(); await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "确认保留我的文字", exact: true }).click();
      await expect(panel).toHaveCount(0); await expect(page.getByRole("status")).toHaveText("已保存到本机");
      const desired = { ...content, fontSize: 32, align: "center", width: method === "transform" ? 410 : 400 };
      const chosen = ((await workspace.state()) as any).texts.find((value: any) => value.id === initial.id);
      expect(chosen.content).toEqual(desired);
      expect(chosen.item.pose).toMatchObject({ x: initial.item.pose.x + (method === "move" ? 40 : 0), y: initial.item.pose.y + (method === "move" ? 20 : 0), width: desired.width });
      expect(commands.at(-1)).toMatchObject({ type: "text.transform", expected: { text: remote.versionId, pose: remote.item.versionId }, payload: { id: initial.id, content: desired } });
      await page.getByRole("button", { name: "撤销", exact: true }).click(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
      await expect.poll(async () => ((await workspace.state()) as any).texts.find((value: any) => value.id === initial.id)?.content).toEqual(content);
      const undone = ((await workspace.state()) as any).texts.find((value: any) => value.id === initial.id);
      expect(undone.content).toEqual(content); expect(undone.item.pose).toEqual(remote.item.pose);
      await page.getByRole("button", { name: "重做", exact: true }).click(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
      await expect.poll(async () => ((await workspace.state()) as any).texts.find((value: any) => value.id === initial.id)?.content).toEqual(desired);
      const redone = ((await workspace.state()) as any).texts.find((value: any) => value.id === initial.id);
      expect(redone.content).toEqual(desired); expect(redone.item.pose).toEqual(chosen.item.pose);
    } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  }
});

test("本机变换正常ACK在途排入样式后续写沿确切确认内容保新宽且不自冲突", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 200 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("变换确认后排样式"); await editor.press("Escape"); await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const state = (await workspace.state()) as any, created = state.texts[0];
  const content = { ...created.content, runs: [{ text: "变换确认后排样式", bold: true, color: "#ad343e" }], fontSize: 26, align: "right", widthMode: "fixed", width: 400 };
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.edit", expected: created.versionId, payload: { id: created.id, content } });
  await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机"); await page.locator(".canvas-text-content").click();
  let held = false, release!: () => void, transform: any;
  const gate = new Promise<void>((resolve) => { release = resolve; }), edits: any[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.payload.id !== created.id || !["text.transform", "text.edit"].includes(command.type)) return route.continue();
    const response = await route.fetch(), receipt = await response.json();
    if (command.type === "text.transform") { expect(response.status()).toBe(200); transform = { command, receipt }; held = true; await gate; }
    else edits.push({ command, status: response.status(), receipt });
    return route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).press("Shift+ArrowRight"); await expect.poll(() => held).toBe(true);
    await page.getByRole("spinbutton", { name: "文字字号", exact: true }).fill("32"); await page.getByRole("button", { name: "文字居中", exact: true }).click();
    release(); await expect.poll(() => edits.length).toBeGreaterThan(0);
    console.log("transform-ack-format-trace", JSON.stringify({ transform, edits }));
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(page.getByRole("region", { name: "独立文字保存冲突", exact: true })).toHaveCount(0);
    const desired = { ...content, fontSize: 32, align: "center", width: 410 };
    const saved = ((await workspace.state()) as any).texts[0]; expect(saved.content).toEqual(desired); expect(saved.item.pose.width).toBe(410);
    expect(edits.map((value) => value.status)).toEqual([200, 200]);
    expect(edits[0].command.expected).toBe(transform.receipt.textVersions.text);
    expect(edits[0].command.payload.content).toEqual({ ...content, fontSize: 32, width: 410 });
    expect(edits[1].command.expected).toBe(edits[0].receipt.textVersions.text);
    expect(edits[1].command.payload.content).toEqual(desired);
    await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机"); expect(((await workspace.state()) as any).texts[0].content).toEqual(desired);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

for (const { view, expectedMessage } of [
  { view: "text-index", expectedMessage: "文字索引与卡片快照不一致，请重新读取" },
  { view: "text-detail", expectedMessage: "文字详情与卡片快照不一致，请重新读取" },
] as const) {
  const subject = view === "text-index" ? "文字索引" : "文字详情";
  test(`${subject}首响应的快照或修订与主索引不符时拒绝整份投影，正常重读完整可用`, async ({ page, workspace }) => {
    await page.getByRole("button", { name: "卡片", exact: true }).click(); await page.locator(".react-flow__pane").click({ position: { x: 80, y: 100 } });
    await page.getByLabel("卡片标题", { exact: true }).fill("完整投影卡片"); await page.getByLabel("卡片标题", { exact: true }).press("Enter");
    await page.getByRole("button", { name: "文字", exact: true }).click(); await page.locator(".react-flow__pane").click({ position: { x: 350, y: 300 } });
    const editor = page.getByRole("textbox", { name: "独立文字" }); await editor.fill("完整投影文字"); await editor.press("Escape"); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    for (const field of ["snapshot", "revision"]) {
      let changed = false;
      await page.route("**/api/mapping/projects/*/map?**", async (route) => {
        if (changed || new URL(route.request().url()).searchParams.get("view") !== view) return route.continue();
        const response = await route.fetch(); expect(response.status()).toBe(200); const value = await response.json();
        const original = { snapshot: value.snapshot, revision: value.revision };
        if (field === "snapshot") value.snapshot += "-foreign";
        else { value.revision += 1000; value.project.revision = value.revision; }
        for (let pass = 0; pass < 5; pass++) { const bytes = Buffer.byteLength(JSON.stringify(value)); if (value.bytes === bytes) break; value.bytes = bytes; }
        const body = JSON.stringify(value); expect(Buffer.byteLength(body)).toBe(value.bytes); changed = true;
        console.log(`${view}-cross-snapshot-fixture`, JSON.stringify({ field, original, returned: { snapshot: value.snapshot, revision: value.revision }, validBytes: value.bytes }));
        return route.fulfill({ status: 200, contentType: "application/json", body });
      });
      await page.reload(); await expect.poll(() => changed).toBe(true);
      await expect(page.getByRole("alert").filter({ hasText: expectedMessage })).toBeVisible();
      await expect(page.locator(".react-flow__node")).toHaveCount(0);
      const persisted = (await workspace.state()) as any; expect(persisted.cards).toHaveLength(1); expect(persisted.texts).toHaveLength(1);
      await page.unrouteAll({ behavior: "wait" }); await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
      await expect(page.getByRole("button", { name: "完整投影卡片", exact: true })).toBeVisible(); await expect(page.locator(".canvas-text-content")).toHaveText("完整投影文字");
    }
  });
}

test("变换确认后的首排格式真实冲突接管未prepare样式，重载恢复副本保确认宽度与完整内容", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 300, y: 200 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("确认几何后的格式冲突"); await editor.press("Escape"); await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const state = (await workspace.state()) as any, created = state.texts[0];
  const content = { ...created.content, runs: [{ text: "确认几何后的格式冲突", bold: true, color: "#ad343e" }], fontSize: 26, align: "right", widthMode: "fixed", width: 400 };
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.edit", expected: created.versionId, payload: { id: created.id, content } });
  await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机"); await page.locator(".canvas-text-content").click();
  let held = false, release!: () => void, transform: any, remote: any, rejected = false;
  const gate = new Promise<void>((resolve) => { release = resolve; }), edits: any[] = [];
  await page.route("**/api/mapping/execute", async (route) => {
    const command = route.request().postDataJSON();
    if (command.payload.id !== created.id || !["text.transform", "text.edit"].includes(command.type)) return route.continue();
    if (command.type === "text.transform") {
      const response = await route.fetch(); expect(response.status()).toBe(200); transform = { command, receipt: await response.json() }; held = true; await gate; return route.fulfill({ response });
    }
    edits.push(command);
    if (!rejected) {
      rejected = true;
      const current = ((await workspace.state()) as any).texts.find((value: any) => value.id === created.id);
      remote = { ...current.content, runs: [{ text: "真实外部新正文", color: "#156064" }] };
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: "text.edit", expected: current.versionId, payload: { id: created.id, content: remote } });
      const response = await route.fetch(); expect(response.status()).toBe(409);
      console.log("transform-ack-format-conflict", JSON.stringify({ transform, rejected: command, remote, status: response.status() }));
      return route.fulfill({ response });
    }
    return route.continue();
  });
  try {
    await page.getByRole("button", { name: "调整文字尺寸：右", exact: true }).press("Shift+ArrowRight"); await expect.poll(() => held).toBe(true);
    await page.getByRole("spinbutton", { name: "文字字号", exact: true }).fill("32"); await page.getByRole("button", { name: "文字居中", exact: true }).click();
    release();
    const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true }); await expect(panel).toBeVisible();
    expect(edits).toHaveLength(1); expect(edits[0].expected).toBe(transform.receipt.textVersions.text);
    expect(edits[0].payload.content).toEqual({ ...content, fontSize: 32, width: 410 });
    await page.reload(); await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click(); await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "确认保留已保存的文字", exact: true }).click();
    await expect(panel).toHaveCount(0); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const saved = (await workspace.state()) as any, original = saved.texts.find((value: any) => value.id === created.id), copy = saved.texts.find((value: any) => value.id !== created.id);
    expect(saved.texts).toHaveLength(2); expect(original.content).toEqual(remote);
    expect(copy.content).toEqual({ ...content, fontSize: 32, align: "center", width: 410 }); expect(copy.item.pose.width).toBe(410);
    expect(edits).toHaveLength(1);
    await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机"); expect(((await workspace.state()) as any).texts.find((value: any) => value.id === copy.id).content).toEqual(copy.content);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});

test("左右调宽下限随字号变化，预览和重开保持固定宽及未拖动对边", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const fontSize of [36, 9]) {
    for (const [side, label] of [["left", "左"], ["right", "右"]] as const) {
      const id = `minimum-width-${fontSize}-${side}`;
      const content = {
        runs: [{ text: `宽度${fontSize}${label}`, bold: true, color: "#ad343e" }],
        fontSize, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 400,
      };
      await workspace.execute(page, {
        commandId: `create-${id}`, projectId, type: "text.create", expected: null,
        payload: { id, content, pose: { x: 300, y: 220, width: 400, height: fontSize * 1.5 } },
      });
      await page.reload();
      const read = async () => ((await workspace.state()) as any).texts.find((value: any) => value.id === id);
      const original = await read();
      const node = page.locator(`[data-id="${original.item.id}"]`);
      const text = node.locator(".canvas-text-content");
      await text.click();
      const origin = (await text.boundingBox())!;
      const scale = origin.width / original.item.pose.width;
      const minimum = 20 * fontSize / 18;
      const handle = (await node.getByRole("button", { name: `调整文字尺寸：${label}`, exact: true }).boundingBox())!;
      try {
        const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + (side === "left" ? 1 : -1) * (origin.width + 60), y, { steps: 5 });
        const preview = (await text.boundingBox())!;
        console.log("font-scaled-width-preview", JSON.stringify({ fontSize, side, origin, preview, minimum }));
        await expect.poll(async () => (await text.boundingBox())!.width).toBeCloseTo(minimum * scale, 1);
        if (side === "left") {
          await expect.poll(async () => { const box = (await text.boundingBox())!; return box.x + box.width; }).toBeCloseTo(origin.x + origin.width, 1);
        } else {
          await expect.poll(async () => (await text.boundingBox())!.x).toBeCloseTo(origin.x, 1);
        }
        await page.mouse.up();
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
        await expect.poll(async () => (await read()).content.width).toBe(minimum);
        await expect.poll(async () => (await read()).item.pose.width).toBeCloseTo(minimum, 1);
        const saved = await read();
        expect(saved.content).toEqual({ ...content, width: minimum });
        if (side === "left") expect(saved.item.pose.x + saved.item.pose.width).toBeCloseTo(original.item.pose.x + original.item.pose.width, 1);
        else expect(saved.item.pose.x).toBeCloseTo(original.item.pose.x, 1);
        await workspace.restart(); await workspace.open(page);
        const reopened = await read();
        expect(reopened.content).toEqual(saved.content);
        expect(reopened.item.pose).toEqual(saved.item.pose);
        expect((await text.boundingBox())!.width).toBeCloseTo(minimum * scale, 1);
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect.poll(async () => (await read()).content.width).toBe(400);
        await expect.poll(async () => (await read()).item.pose.x).toBeCloseTo(original.item.pose.x, 1);
        await expect.poll(async () => (await text.boundingBox())!.width).toBeCloseTo(origin.width, 1);
        expect((await read()).content).toEqual(content);
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
      } finally { await page.mouse.up(); }
    }
  }
});

test("恢复记录写失败阻止文字提交，恢复后未知ACK原键重试并保留后代", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id, id = "durable-text-save";
  const originalContent = { runs: [{ text: "保存前原文" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "auto", width: 320 };
  await workspace.execute(page, { commandId: "durable-text-seed", projectId, type: "text.create", expected: null, payload: { id, content: originalContent, pose: { x: 220, y: 220, width: 140, height: 27 } } });
  await page.reload();
  const read = async () => ((await workspace.state()) as any).texts.find((value: any) => value.id === id);
  const initial = await read();
  await page.locator(`.react-flow__node[data-id="${initial.item.id}"] .canvas-text-content`).dblclick();
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await expect(editor).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    (window as any).__ownedRecoveryFault = { fail: true, attempts: 0 };
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key.startsWith("forkwise:text-recovery:v1:") && (window as any).__ownedRecoveryFault.fail) {
        (window as any).__ownedRecoveryFault.attempts++;
        throw new DOMException("owned recovery storage unavailable", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  const commands: any[] = [];
  let allowMutation = false, lostAck = false;
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command.type !== "text.edit" || command.payload.id !== id) return route.continue();
    commands.push(command);
    if (!allowMutation) return route.abort("failed");
    if (!lostAck) { lostAck = true; await route.fetch(); return route.abort("failed"); }
    return route.continue();
  });
  page.on("dialog", dialog => dialog.accept());
  try {
    await editor.fill("存储失败期间的完整第一代");
    await page.clock.fastForward(400);
    await expect(page.getByRole("status")).toHaveText("文字保存未完成");
    expect(await page.evaluate(() => (window as any).__ownedRecoveryFault.attempts)).toBeGreaterThan(0);
    expect((await read()).content).toEqual(originalContent);
    await expect(editor).toHaveText("存储失败期间的完整第一代");
    console.log("durable-text-save-blocked", JSON.stringify({ commands, backend: (await read()).content, input: await editor.textContent(), storageFailures: await page.evaluate(() => (window as any).__ownedRecoveryFault.attempts) }));
    expect(commands, "恢复记录写入失败时不能发送文字mutation").toEqual([]);
    await page.evaluate(() => { (window as any).__ownedRecoveryFault.fail = false; });
    allowMutation = true;
    await page.getByRole("button", { name: "重试文字保存", exact: true }).click();
    await expect.poll(() => commands.length).toBe(1);
    await expect(page.getByRole("status")).toHaveText("文字保存未完成");
    const original = commands[0];
    expect(original.payload.content.runs).toEqual([{ text: "存储失败期间的完整第一代" }]);
    await expect.poll(async () => (await read()).content.runs).toEqual([{ text: "存储失败期间的完整第一代" }]);
    await editor.fill("原ACK未知后继续输入的完整后代");
    await expect(editor).toHaveText("原ACK未知后继续输入的完整后代");
    await page.reload();
    await expect(page.getByRole("button", { name: "恢复独立文字草稿", exact: true })).toBeVisible();
    expect(commands).toHaveLength(1);
    await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toEqual(original);
    await expect(editor).toHaveText("原ACK未知后继续输入的完整后代");
    await expect(page.getByRole("status")).toHaveText("文字等待保存…");
    await page.clock.fastForward(400);
    await expect.poll(async () => (await read()).content.runs).toEqual([{ text: "原ACK未知后继续输入的完整后代" }]);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(commands).toHaveLength(3);
    expect(commands[2].commandId).not.toBe(original.commandId);
    expect(commands[2].payload.content.runs).toEqual([{ text: "原ACK未知后继续输入的完整后代" }]);
    console.log("durable-text-save-recovered", JSON.stringify({ commands, persisted: (await read()).content }));
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("副本prepare期间外部更新须明确冲突，重载恢复保点击完整快照且不覆盖原件", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id, id = "copy-frozen-snapshot";
  const content = { runs: [{ text: "点击时完整快照", bold: true, color: "#ad343e" }], fontSize: 24, lineHeight: 1.5, align: "right", widthMode: "fixed", width: 400 };
  await workspace.execute(page, { commandId: "copy-frozen-seed", projectId, type: "text.create", expected: null, payload: { id, content, pose: { x: 240, y: 220, width: 400, height: 36 } } });
  await page.reload();
  const read = async () => (await workspace.state()) as any;
  const original = (await read()).texts.find((value: any) => value.id === id);
  const node = page.locator(`.react-flow__node[data-id="${original.item.id}"]`);
  const text = node.locator(".canvas-text-content");
  await expect(text).toHaveText("点击时完整快照");
  await expectTextFontSize(text, 24);
  await expect(text).toHaveCSS("text-align", "right");
  await text.click();
  let hold = true, held = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const copies: any[] = [];
  await page.route("**/api/mapping/projects/*/map?**", async route => {
    if (!hold || new URL(route.request().url()).searchParams.get("view") !== "index") return route.continue();
    hold = false; held = true; await gate; return route.continue();
  });
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command.type === "text.copy") copies.push(command);
    return route.continue();
  });
  page.on("dialog", dialog => dialog.accept());
  const panel = page.getByRole("region", { name: "独立文字保存冲突", exact: true });
  const remote = { ...content, runs: [{ text: "点击后外部完整更新", color: "#217346" }], fontSize: 36, align: "center" };
  try {
    await page.getByRole("button", { name: "生成文字副本", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await workspace.execute(page, { commandId: "copy-frozen-external-edit", projectId, type: "text.edit", expected: original.versionId, payload: { id, content: remote } });
    release();
    await expect.poll(async () => (await read()).texts.length > 1 || await panel.count() > 0).toBe(true);
    console.log("copy-click-snapshot-boundary", JSON.stringify({ original, remote, copies, state: await read(), conflicts: await panel.count() }));
    await expect(panel).toBeVisible();
    expect(copies).toEqual([]);
    expect((await read()).texts).toHaveLength(1);
    expect((await read()).texts.find((value: any) => value.id === id).content).toEqual(remote);
    await expect(panel.getByLabel("我的独立文字", { exact: true })).toHaveValue("点击时完整快照");
    await expect(panel.getByLabel("已保存的独立文字", { exact: true })).toHaveValue("点击后外部完整更新");
    await expect(panel.getByLabel("我的独立文字预览", { exact: true })).toHaveCSS("font-size", "24px");
    await expect(panel.getByLabel("我的独立文字预览", { exact: true })).toHaveCSS("text-align", "right");
    await page.reload();
    await page.getByRole("button", { name: "恢复独立文字草稿", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("我的独立文字", { exact: true })).toHaveValue("点击时完整快照");
    await panel.getByRole("button", { name: "确认保留已保存的文字", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const resolved = await read(), source = resolved.texts.find((value: any) => value.id === id), copy = resolved.texts.find((value: any) => value.id !== id);
    expect(resolved.texts).toHaveLength(2);
    expect(source.content).toEqual(remote);
    expect(source.item.id).toBe(original.item.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.item.id).not.toBe(original.item.id);
    expect(copy.content).toEqual(content);
    expect(copy.item.pose).toMatchObject({ x: original.item.pose.x + 24, y: original.item.pose.y + 24, width: original.item.pose.width });
    console.log("copy-click-snapshot-restored", JSON.stringify({ source, copy }));
    await workspace.restart(); await workspace.open(page);
    const reopened = await read();
    expect(reopened.texts.find((value: any) => value.id === id).content).toEqual(remote);
    expect(reopened.texts.find((value: any) => value.id === copy.id).content).toEqual(content);
    expect(reopened.texts.find((value: any) => value.id === copy.id).item.id).toBe(copy.item.id);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});


test("组合输入中仅一次Esc延后至compositionend，保存最终完整文字并结束编辑回选择", async ({
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
  await expect(editor).toBeFocused();
  const original = ((await workspace.state()) as any).texts[0];
  const final = "组合结束的完整文字\n保留最后一代";
  await page.clock.install();
  try {
    await editor.dispatchEvent("compositionstart");
    await editor.fill("候选输入中");
    await page.clock.fastForward(2500);
    expect(edits).toEqual([]);
    await editor.press("Escape");
    await page.clock.fastForward(2500);
    await expect(editor).toBeFocused();
    expect(edits).toEqual([]);
    await editor.fill(final);
    await editor.dispatchEvent("compositionend", { data: final });
    await page.clock.fastForward(2500);
    await expect
      .poll(async () => ((await workspace.state()) as any).texts.find((value: any) => value.id === original.id).content.runs.map((run: any) => run.text).join(""))
      .toBe(final);
    expect(edits).toHaveLength(1);
    expect(edits[0].payload.id).toBe(original.id);
    expect(edits[0].payload.content.runs.map((run: any) => run.text).join("")).toBe(final);
    console.log("composition-single-escape", JSON.stringify({ textId: original.id, itemId: original.item.id, edits, editorCount: await editor.count() }));
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("button", { name: "选择", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await page.clock.resume();
  }
});


test("长混合文字角点缩放保持逐行分组、字形与完整文字框同比，并保留内容样式", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const content = {
    runs: [
      { text: "Review", bold: true, color: "#ad343e" },
      { text: "\nEvxidence" },
      { text: "NEW alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.", bold: true, color: "#2457ad" },
    ],
    fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 500,
  };
  await workspace.execute(page, { commandId: "long-corner", projectId, type: "text.create", expected: null,
    payload: { id: "long-corner", content, pose: { x: 300, y: 220, width: 500, height: 108 } } });
  await page.reload();
  const text = page.locator(".canvas-text-content"), article = page.locator("article.canvas-text"), node = page.locator(".react-flow__node-canvasText");
  await text.click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const lines = () => text.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const result: { text: string; top: number; height: number }[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let i = 0; i < node.textContent!.length; i++) {
        const char = node.textContent![i]!;
        if (char === "\n") continue;
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        const box = range.getBoundingClientRect();
        let line = result.find(value => Math.abs(value.top - box.top) < 1);
        if (!line) { line = { text: "", top: box.top, height: box.height }; result.push(line); }
        line.text += char;
      }
    }
    return result;
  });
  const before = (await text.boundingBox())!, originalLines = await lines();
  expect(originalLines).toHaveLength(4);
  expect(before.width).toBeCloseTo(500, 1); expect(before.height).toBeCloseTo(108, 1);
  const handle = (await page.getByRole("button", { name: "调整文字尺寸：右下", exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  try { await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + handle.height / 2 + 21.6, { steps: 6 }); }
  finally { await page.mouse.up(); }
  await expect.poll(async () => ((await workspace.state()) as any).texts[0].content.fontSize).toBeCloseTo(21.6, 3);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = ((await workspace.state()) as any).texts[0], after = (await text.boundingBox())!, scaledLines = await lines();
  console.log("long-corner-observed", JSON.stringify({ before, originalLines, after, scaledLines, publicValue: saved }));
  expect(scaledLines.map(line => line.text)).toEqual(originalLines.map(line => line.text));
  expect(after.width).toBeCloseTo(before.width * 1.2, 1);
  expect(after.height).toBeCloseTo(before.height * 1.2, 1);
  expect(scaledLines[0]!.height).toBeCloseTo(originalLines[0]!.height * 1.2, 1);
  expect(after.x).toBeCloseTo(before.x, 1); expect(after.y).toBeCloseTo(before.y, 1);
  const { fontSize, width, ...styles } = saved.content;
  expect(styles).toEqual({ runs: content.runs, lineHeight: 1.5, align: "left", widthMode: "fixed" });
  expect(fontSize).toBeCloseTo(21.6, 3); expect(width).toBeCloseTo(600, 3);
  expect(saved.item.pose.width).toBeCloseTo(after.width, 1); expect(saved.item.pose.height).toBeCloseTo(after.height, 1);
  for (const box of [(await article.boundingBox())!, (await node.boundingBox())!]) {
    expect(box.x).toBeCloseTo(after.x, 1); expect(box.y).toBeCloseTo(after.y, 1);
    expect(box.width).toBeCloseTo(after.width, 1); expect(box.height).toBeCloseTo(after.height, 1);
  }
  const bottomRight = (await page.getByRole("button", { name: "调整文字尺寸：右下", exact: true }).boundingBox())!;
  expect(bottomRight.x + bottomRight.width / 2).toBeCloseTo(after.x + after.width, 1);
  expect(bottomRight.y + bottomRight.height / 2).toBeCloseTo(after.y + after.height, 1);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), { x: bottomRight.x + bottomRight.width / 2, y: bottomRight.y + bottomRight.height / 2 })).toBe("调整文字尺寸：右下");
});


test("左上角缩放预览的父框与可见文字同步，对角固定且编辑重开保持排版", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const content = { runs: [
    { text: "Review", bold: true, color: "#ad343e" }, { text: "\nEvxidence" },
    { text: "NEW alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.", bold: true, color: "#2457ad" },
  ], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 500 };
  await workspace.execute(page, { commandId: "anchored-long-corner", projectId, type: "text.create", expected: null,
    payload: { id: "anchored-long-corner", content, pose: { x: 300, y: 220, width: 500, height: 108 } } });
  await page.reload();
  const text = page.locator(".canvas-text-content"), node = page.locator(".react-flow__node-canvasText");
  await text.click();
  const before = (await text.boundingBox())!;
  const handle = (await page.getByRole("button", { name: "调整文字尺寸：左上", exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(handle.x + handle.width / 2 - 100, handle.y + handle.height / 2 - 21.6, { steps: 6 });
    await expect.poll(async () => (await text.boundingBox())!.width).toBeCloseTo(600, 1);
    const preview = (await text.boundingBox())!, outer = (await node.boundingBox())!;
    console.log("corner-preview-parent", JSON.stringify({ before, preview, outer }));
    expect(outer.width).toBeCloseTo(preview.width, 1); expect(outer.height).toBeCloseTo(preview.height, 1);
    expect(preview.x + preview.width).toBeCloseTo(before.x + before.width, 1);
    expect(preview.y + preview.height).toBeCloseTo(before.y + before.height, 1);
  } finally { await page.mouse.up(); }
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = ((await workspace.state()) as any).texts[0], scaled = (await text.boundingBox())!;
  expect(saved.item.pose.x).toBeCloseTo(200, 1); expect(saved.item.pose.y).toBeCloseTo(198.4, 1);
  await text.dblclick();
  const editor = page.getByRole("textbox", { name: "独立文字", exact: true });
  await expect(editor).toBeFocused();
  const editing = (await editor.boundingBox())!;
  expect(editing.width).toBeCloseTo(scaled.width, 1); expect(editing.height).toBeCloseTo(scaled.height, 1);
  expect(editing.x).toBeCloseTo(scaled.x, 1); expect(editing.y).toBeCloseTo(scaled.y, 1);
  await editor.press("ControlOrMeta+End"); await editor.pressSequentially("!"); await editor.press("Escape");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const changed = ((await workspace.state()) as any).texts[0];
  expect(changed.content).toEqual({ ...saved.content, runs: saved.content.runs.map((run: any, index: number) => index === 2 ? { ...run, text: run.text + "!" } : run) });
  await page.reload();
  await expect(text).toHaveText(content.runs.map(run => run.text).join("") + "!");
  expect((await text.boundingBox())!.height).toBeCloseTo(scaled.height, 1);
  expect(((await workspace.state()) as any).texts[0].content).toEqual(changed.content);
});
