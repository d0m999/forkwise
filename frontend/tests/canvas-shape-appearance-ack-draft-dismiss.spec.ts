import { test, expect } from "./writing-board-fixture";

test("外观旧请求确认后关闭与Esc保留较新非法草稿，重开修正只用自己的确认版本保存", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保护正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "ellipse", shortText: "完整短文😀\n保持原样", fill: "#ffffff", stroke: "#111111", strokeWidth: 2 };
  await execute("shape.create", { id: "ack-draft-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history();
  const dialog = page.getByRole("dialog", { name: "形状外观", exact: true });
  const fill = dialog.getByRole("textbox", { name: "填充颜色", exact: true });
  const stroke = dialog.getByRole("textbox", { name: "轮廓颜色", exact: true });
  const width = dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true });
  const restore = page.getByRole("button", { name: "恢复形状外观草稿", exact: true });
  await page.getByRole("img", { name: content.shortText, exact: true }).click();
  const trigger = page.getByRole("button", { name: "形状外观", exact: true });
  await trigger.click(); await fill.fill("#aaaaaa");
  await dialog.getByRole("button", { name: "关闭形状外观", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await fill.fill("#bbbbbb"); await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await expect(restore).toHaveCount(0);
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
  const attempts: { command: any; receipt: any }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "shape.edit") { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, receipt: await response.json() });
    if (attempts.length === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message: "A已提交但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    await trigger.click(); await fill.fill("#dbeafe"); await stroke.fill("#1d4ed8"); await width.fill("3");
    await dialog.getByRole("button", { name: "保存形状外观", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("A已提交但ACK未送达");
    const committed = await workspace.state() as any, committedHistory = await history();
    expect(committed.shapes[0]).toMatchObject({ id: shape.id, item: shape.item,
      content: { ...content, fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 } });
    await fill.fill("#12"); await stroke.fill(""); await width.fill("");
    await dialog.getByRole("button", { name: "重试保存形状外观", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("较新输入尚需修正后保存");
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    await expect(fill).toHaveValue("#12"); await expect(stroke).toHaveValue(""); await expect(width).toHaveValue("");
    const close = (await dialog.getByRole("button", { name: "关闭形状外观", exact: true }).boundingBox())!;
    await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
    await expect(dialog, "旧ACK只确认A，关闭不得删除较新非法B的唯一恢复记录").toBeVisible();
    await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
    await expect(fill).toHaveValue("#12"); await expect(stroke).toHaveValue(""); await expect(width).toHaveValue("");
    expect(attempts).toHaveLength(2); expect(await workspace.state()).toEqual(committed);
    expect(await history()).toEqual(committedHistory);
    await workspace.restart();
    page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload();
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(committed.project.revision));
    await expect(restore).toHaveCount(1); expect(attempts).toHaveLength(2);
    expect(await workspace.state()).toEqual(committed); expect(await history()).toEqual(committedHistory);
    await restore.click(); await expect(dialog).toBeVisible();
    await expect(fill).toHaveValue("#12"); await expect(stroke).toHaveValue(""); await expect(width).toHaveValue("");
    expect(attempts).toHaveLength(2);
    await fill.fill("#dcfce7"); await width.fill("5");
    await dialog.getByRole("button", { name: "重试保存形状外观", exact: true }).click();
    await expect(dialog).toHaveCount(0); expect(attempts).toHaveLength(3);
    const finalContent = { shapeType: "ellipse", shortText: content.shortText, fill: "#dcfce7", strokeWidth: 5 };
    expect(attempts[2].command).toMatchObject({ projectId, type: "shape.edit", expected: attempts[0].receipt.shapeVersions.shape,
      payload: { id: shape.id, content: finalContent } });
    expect(attempts[2].command.payload.content).toEqual(finalContent);
    expect(attempts[2].command.commandId).not.toBe(attempts[0].command.commandId);
    const saved = await workspace.state() as any;
    expect(saved.shapes).toHaveLength(1); expect(saved.shapes[0]).toMatchObject({ id: shape.id, item: shape.item, content: finalContent });
    expect(saved.shapes[0].versionId).toBe(attempts[2].receipt.shapeVersions.shape);
    expect(saved.project.revision).toBe(original.project.revision + 2);
    expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts);
    expect(saved.tags).toEqual(original.tags);
    expect((await history()).undo.filter((action: any) => action.label === "shape.edit")).toHaveLength(2);
    await page.reload(); await expect(restore).toHaveCount(0);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(saved.project.revision));
    expect(await workspace.state()).toEqual(saved);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
