import { test, expect } from "./writing-board-fixture";

test("短文恢复副本再次真实409后完整比较并耐久保留全文，重开明确新建后代不覆盖两份原件", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保护完整正文", x: 850, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 850, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "triangle", shortText: "我方原始形状", fill: "#dcfce7", stroke: "#166534", strokeWidth: 3 };
  const pose = { x: 180, y: 70, width: 280, height: 120 };
  await execute("shape.create", { id: "original-shape", content, pose });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, source = original.shapes[0];
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history(), attempts: { command: any; status: number; body: any }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (!["shape.create", "shape.edit"].includes(command?.type)) { await route.continue(); return; }
    const response = await route.fetch(), body = await response.json();
    attempts.push({ command, status: response.status(), body });
    if (command.type === "shape.create" && attempts.filter(value => value.command.type === "shape.create").length === 1)
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "短文第一副本已创建但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    await page.getByRole("img", { name: content.shortText, exact: true }).click();
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    const textA = "我方首次A😀\n原始完整样式和位置", textB = "继续输入B🧭\n完整后续内容不得丢失\n保留空行与引号：\"我的副本\"\n\n最后一段😀";
    await editor.fill(textA);
    const peerSourceContent = { shapeType: "diamond", shortText: "S对方原件", fill: "#fef3c7", stroke: "#92400e", strokeWidth: 4 };
    await execute("shape.edit", { id: source.id, content: peerSourceContent }, source.versionId);
    const peerSource = (await workspace.state() as any).shapes[0];
    await page.getByRole("button", { name: "保存形状文字", exact: true }).click();
    const comparison = page.getByRole("region", { name: "形状文字保存冲突", exact: true });
    await expect(comparison.getByRole("textbox", { name: "已保存的形状文字", exact: true })).toHaveValue(peerSourceContent.shortText);
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    await comparison.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "短文第一副本已创建但ACK未送达" })).toBeVisible();
    const firstCreate = attempts[1]; expect(firstCreate.status).toBe(200);
    expect(firstCreate.command).toMatchObject({ projectId, type: "shape.create", expected: null,
      payload: { content: { ...content, shortText: textA }, pose } });
    const firstCopy = (await workspace.state() as any).shapes.find((value: any) => value.id === firstCreate.command.payload.id);
    expect(firstCopy.id).not.toBe(source.id); expect(firstCopy.item.id).not.toBe(source.item.id);
    await expect(editor).toBeEditable(); await editor.fill(textB);
    const peerCopyContent = { shapeType: "ellipse", shortText: "C1对方完整副本😀", fill: "#fce7f3", stroke: "#9d174d", strokeWidth: 6 };
    const peerCopyPose = { x: 560, y: 360, width: 300, height: 180 };
    await execute("shape.edit", { id: firstCopy.id, content: peerCopyContent }, firstCopy.versionId);
    await execute("shape.transform", { id: firstCopy.id, pose: peerCopyPose }, firstCopy.item.versionId);
    const peerState = await workspace.state() as any, peerHistory = await history();
    const peerCopy = peerState.shapes.find((value: any) => value.id === firstCopy.id), localContent = { ...content, shortText: textB };
    await comparison.getByRole("button", { name: "重试恢复我的形状", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(4);
    expect(attempts[2]).toEqual(firstCreate);
    expect(attempts[3]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" },
      command: { projectId, type: "shape.edit", expected: firstCreate.body.shapeVersions.shape,
        payload: { id: firstCopy.id, content: localContent } } });
    expect(await workspace.state()).toEqual(peerState); expect(await history()).toEqual(peerHistory);
    expect(peerHistory.undo).toHaveLength(originalHistory.undo.length + 4);
    await expect(comparison.getByRole("textbox", { name: "已保存的形状文字", exact: true }),
      "副本真实409必须转为C1双方比较，不能永远重试旧S恢复阶段").toHaveValue(peerCopyContent.shortText);
    await expect(editor).toHaveValue(textB); await expect(editor).toBeEditable();
    await expect(comparison.getByRole("textbox", { name: "我的形状文字", exact: true })).toHaveValue(textB);
    await expect(comparison.getByRole("button", { name: "保留对方并恢复我的形状", exact: true })).toBeEnabled();
    expect(attempts).toHaveLength(4);
    await workspace.restart();
    page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload(); await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(peerState.project.revision));
    const restore = page.getByRole("button", { name: "恢复形状文字草稿", exact: true });
    await expect(restore).toHaveCount(1); await expect(editor).toHaveCount(0); expect(attempts).toHaveLength(4);
    await restore.click(); await expect(editor).toHaveValue(textB); await expect(editor).toBeEditable();
    await expect(comparison.getByRole("textbox", { name: "已保存的形状文字", exact: true })).toHaveValue(peerCopyContent.shortText);
    await expect(comparison.getByRole("textbox", { name: "我的形状文字", exact: true })).toHaveValue(textB);
    expect(attempts).toHaveLength(4); expect(await workspace.state()).toEqual(peerState); expect(await history()).toEqual(peerHistory);
    await comparison.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(comparison).toHaveCount(0); expect(attempts).toHaveLength(5);
    const secondCreate = attempts[4]; expect(secondCreate.status).toBe(200);
    expect(secondCreate.command.commandId).not.toBe(firstCreate.command.commandId);
    expect([source.id, firstCopy.id]).not.toContain(secondCreate.command.payload.id);
    expect(secondCreate.command).toMatchObject({ projectId, type: "shape.create", expected: null,
      payload: { content: localContent, pose } });
    const saved = await workspace.state() as any, secondCopy = saved.shapes.find((value: any) => value.id === secondCreate.command.payload.id);
    expect(saved.project.revision).toBe(peerState.project.revision + 1); expect(saved.shapes).toHaveLength(3);
    expect(secondCopy).toMatchObject({ content: localContent, item: { pose } });
    expect([source.item.id, firstCopy.item.id]).not.toContain(secondCopy.item.id);
    expect(saved.shapes.find((value: any) => value.id === source.id)).toEqual(peerSource);
    expect(saved.shapes.find((value: any) => value.id === firstCopy.id)).toEqual(peerCopy);
    expect((await history()).undo).toHaveLength(peerHistory.undo.length + 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes.length).toBe(2);
    const undone = await workspace.state() as any;
    expect(undone.shapes.find((value: any) => value.id === source.id)).toEqual(peerSource);
    expect(undone.shapes.find((value: any) => value.id === firstCopy.id)).toEqual(peerCopy);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes.length).toBe(3);
    const final = await workspace.state() as any, redone = final.shapes.find((value: any) => value.id === secondCopy.id);
    expect(redone).toMatchObject({ id: secondCopy.id, content: localContent, item: { id: secondCopy.item.id, pose, createdOrder: secondCopy.item.createdOrder } });
    expect(redone.versionId).not.toBe(secondCopy.versionId); expect(redone.item.versionId).not.toBe(secondCopy.item.versionId);
    expect(final.shapes.find((value: any) => value.id === source.id)).toEqual(peerSource);
    expect(final.shapes.find((value: any) => value.id === firstCopy.id)).toEqual(peerCopy);
    expect(final.cards).toEqual(original.cards); expect(final.texts).toEqual(original.texts); expect(final.tags).toEqual(original.tags);
    await page.reload(); await expect(restore).toHaveCount(0); await expect(editor).toHaveCount(0); await expect(comparison).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机"); expect(await workspace.state()).toEqual(final); expect(attempts).toHaveLength(5);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
