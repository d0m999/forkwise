import { test, expect } from "./writing-board-fixture";

test("附着到卡片后拖动跟随，解除留在原地，Esc 取消附着，中文输入不触发附着", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 180, y: 160 } });
  await page.getByLabel("卡片标题", { exact: true }).fill("目标卡");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 420, y: 220 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.pressSequentially("批注");
  await editor.press("Escape");
  await expect(page.getByRole("button", { name: "附着到卡片" })).toBeVisible();
  const attach = page.getByRole("toolbar", { name: "独立文字样式" }).getByRole("button", { name: "附着到卡片" });
  await attach.click();
  await expect(page.getByText("点击要附着的卡片")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("点击要附着的卡片")).toHaveCount(0);
  await expect(attach).toBeFocused();
  await attach.click();
  await page.keyboard.insertText("注");
  await expect(page.getByText("点击要附着的卡片")).toBeVisible();
  const before = await workspace.state();
  const card = before.cards[0]!;
  await page.getByRole("button", { name: "目标卡", exact: true }).click();
  await expect.poll(async () => (await workspace.state()).attachments?.length ?? 0).toBe(1);
  const attached = await workspace.state();
  const textBefore = attached.texts![0]!.item.pose;
  const cardBefore = attached.cards[0]!.item.pose;
  const node = page.locator(".react-flow__node").filter({ has: page.locator(".title-button") });
  await node.click();
  await page.getByRole("button", { name: "移动卡片：方向键调整位置" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBeGreaterThan(cardBefore.x);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const moved = await workspace.state();
  expect(moved.texts![0]!.item.pose.x - textBefore.x).toBe(moved.cards[0]!.item.pose.x - cardBefore.x);
  expect(moved.texts![0]!.item.pose.y).toBe(textBefore.y);
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 16);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBeGreaterThan(moved.cards[0]!.item.pose.x);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const dragged = await workspace.state();
  expect(dragged.texts![0]!.item.pose.x - moved.texts![0]!.item.pose.x).toBe(dragged.cards[0]!.item.pose.x - moved.cards[0]!.item.pose.x);
  expect(dragged.texts![0]!.item.pose.y - moved.texts![0]!.item.pose.y).toBe(dragged.cards[0]!.item.pose.y - moved.cards[0]!.item.pose.y);
  expect(dragged.attachments?.[0]?.target?.itemId).toBe(card.item.id);
  await page.locator(".canvas-text-content").click();
  await page.getByRole("button", { name: "解除附着" }).click();
  await expect.poll(async () => (await workspace.state()).attachments ?? []).toEqual([]);
  const freed = (await workspace.state()).texts![0]!.item.pose;
  expect(freed).toEqual(dragged.texts![0]!.item.pose);
  await node.click();
  await page.getByRole("button", { name: "移动卡片：方向键调整位置" }).press("ArrowRight");
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBeGreaterThan(dragged.cards[0]!.item.pose.x);
  const movedWithoutAnnotation = await workspace.state();
  expect(movedWithoutAnnotation.texts![0]!.item.pose).toEqual(freed);
  expect(movedWithoutAnnotation.attachments ?? []).toEqual([]);
  const undo = page.getByRole("button", { name: "撤销", exact: true });
  await undo.click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual(dragged.cards[0]!.item.pose);
  expect((await workspace.state()).attachments ?? []).toEqual([]);
  await undo.click();
  await expect.poll(async () => (await workspace.state()).attachments?.[0]?.target?.itemId).toBe(card.item.id);
  const restored = await workspace.state();
  expect(restored.cards[0]!.item.pose).toEqual(dragged.cards[0]!.item.pose);
  expect(restored.texts![0]!.item.pose).toEqual(freed);
  expect(restored.containment ?? []).toEqual(dragged.containment ?? []);
});

test("开始附着退出原放置工具，Escape 只关闭当前工具条或子菜单", async ({ page, workspace }) => {
  const tool = (name: string) => page.getByRole("button", { name, exact: true });
  const pane = page.locator(".react-flow__pane");
  await tool("卡片").click(); await pane.click({ position: { x: 155, y: 155 } });
  const title = page.getByRole("textbox", { name: "卡片标题", exact: true });
  await title.fill("批注目标"); await title.press("Enter");
  await tool("文字").click(); await pane.click({ position: { x: 480, y: 290 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("附着时可继续浏览工具"); await editor.press("Escape");
  const attach = tool("附着到卡片"), shape = tool("形状");
  const pick = page.getByText("点击要附着的卡片", { exact: true });
  await expect(attach).toBeVisible();
  await shape.click(); await page.getByRole("menuitem", { name: "矩形", exact: true }).click();
  await expect(shape).toHaveAttribute("aria-pressed", "true");
  await attach.click();
  await expect(shape).toHaveAttribute("aria-pressed", "false");
  await expect(pick).toBeVisible();
  await attach.press("Tab");
  await expect(tool("层级")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pick).toHaveCount(0);
  await expect(attach).toBeFocused();

  await attach.press("Enter");
  const color = tool("文字颜色"), firstSwatch = tool("默认文字");
  for (let step = 0; step < 10 && !(await color.evaluate(element => element === document.activeElement)); step++)
    await page.keyboard.press("Tab");
  await expect(color).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(firstSwatch).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(firstSwatch).toHaveCount(0);
  await expect(pick).toBeVisible({ timeout: 3000 });
  await expect(color).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pick).toHaveCount(0);
  await expect(attach).toBeFocused();

  await attach.press("Enter");
  for (let step = 0; step < 45 && !(await shape.evaluate(element => element === document.activeElement)); step++)
    await page.keyboard.press("Tab");
  await expect(shape).toBeFocused();
  await page.keyboard.press("Enter");
  const presets = page.getByRole("menu", { name: "形状预设" });
  await expect(presets).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(presets).toHaveCount(0); await expect(shape).toBeFocused();
  await expect(pick).toBeVisible();
  await tool("批注目标").click();
  await expect.poll(async () => (await workspace.state()).attachments?.length).toBe(1);
  await expect(pick).toHaveCount(0);
  expect((await workspace.state()).shapes ?? []).toHaveLength(0);
});

test("附着目标真实409后回读并允许重新选择，未知回执重试同一命令", async ({ page, workspace }) => {
  const { project } = await workspace.state();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: project.id,
    type: "thought.create", expected: null, payload: { id: "changed-attachment-target", title: "变动目标", text: "", x: 150, y: 130 } });
  await page.reload();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 475, y: 295 } });
  const editor = page.getByRole("textbox", { name: "独立文字" });
  await editor.fill("测试旧版本"); await editor.press("Escape");
  const attach = page.getByRole("button", { name: "附着到卡片", exact: true });
  const target = page.getByRole("button", { name: "变动目标", exact: true });
  await expect(attach).toBeVisible();
  const attempts: { id: string; status: number }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "attachment.attach") return route.continue();
    if (attempts.length === 0) {
      const card = (await workspace.state()).cards[0]!;
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: project.id, type: "pose.move",
        expected: card.item.versionId, payload: { id: card.id, x: card.item.pose.x + 24, y: card.item.pose.y } });
    }
    const response = await route.fetch();
    attempts.push({ id: command.commandId, status: response.status() });
    if (attempts.length === 2) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await attach.click(); await target.click();
  await expect(page.getByRole("alert")).toHaveText("附着目标已更新，请重新读取");
  expect(attempts.map(attempt => attempt.status)).toEqual([409]);
  expect((await workspace.state()).attachments ?? []).toEqual([]);
  await attach.click(); await target.click();
  const retry = page.getByRole("button", { name: "重试保存", exact: true });
  await expect(retry).toBeEnabled();
  const saved = (await workspace.state()).attachments;
  expect(saved).toHaveLength(1);
  await retry.click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect(attempts.map(attempt => attempt.status)).toEqual([409, 200, 200]);
  expect(attempts[0]?.id).not.toBe(attempts[1]?.id);
  expect(attempts[1]?.id).toBe(attempts[2]?.id);
  expect((await workspace.state()).attachments).toEqual(saved);
});

test("另一个窗口删掉目标卡，附着的明确400回读画布后可选择另一张卡", async ({ page, workspace, browser }) => {
  const { project } = await workspace.state();
  for (const [id, title, y] of [["deleted-target", "将被删除的目标", 145], ["live-target", "仍可附着的目标", 390]] as const) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: project.id, type: "thought.create",
      expected: null, payload: { id, title, text: "", x: 155, y } });
  }
  await page.reload();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 530, y: 265 } });
  const editor = page.getByRole("textbox", { name: "独立文字", exact: true });
  await editor.fill("需要换一个附着目标"); await editor.press("Escape");
  const attach = page.getByRole("button", { name: "附着到卡片", exact: true });
  const deleted = page.getByRole("button", { name: "将被删除的目标", exact: true });
  await attach.click();

  let releaseChanges!: () => void;
  const changes = new Promise<void>(resolve => { releaseChanges = resolve; });
  await page.route(url => url.pathname === `/api/mapping/projects/${project.id}/changes`, async route => {
    await changes;
    await route.continue();
  });
  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    await workspace.open(peer);
    const peerCard = peer.locator(".react-flow__node-thought").filter({ has: peer.getByRole("button", { name: "将被删除的目标", exact: true }) });
    await peerCard.click();
    await peer.getByRole("button", { name: "更多", exact: true }).click();
    await peer.getByRole("button", { name: "删除卡片", exact: true }).click();
    await expect(peerCard).toHaveCount(0);
    await page.bringToFront();
    await expect(deleted).toBeVisible();
    const rejected = page.waitForResponse(response => response.request().postDataJSON()?.type === "attachment.attach");
    await deleted.click();
    const response = await rejected;
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_COMMAND" });
    await expect(deleted).toHaveCount(0, { timeout: 3500 });
    await expect(attach).toBeEnabled();
    expect((await workspace.state()).attachments ?? []).toEqual([]);
    await attach.click();
    await page.getByRole("button", { name: "仍可附着的目标", exact: true }).click();
    await expect.poll(async () => {
      const state = await workspace.state(), card = state.cards.find(item => item.id === "live-target");
      return card && state.attachments?.[0]?.target?.itemId === card.item.id;
    }).toBe(true);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
  } finally { releaseChanges(); await peerContext.close(); }
});
