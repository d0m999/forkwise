import { test, expect } from "./writing-board-fixture";

test("形状外观真实冲突保留对方原件，完整草稿以新身份恢复且丢ACK重试只创建一次", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "triangle", shortText: "我的完整原文\n😀", fill: "#ffffff", stroke: "#111111", strokeWidth: 1 };
  await execute("shape.create", { id: "conflicted-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  await page.getByRole("img", { name: content.shortText, exact: true }).click();
  await page.getByRole("button", { name: "形状外观", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "形状外观", exact: true });
  await dialog.getByRole("textbox", { name: "填充颜色", exact: true }).fill("#dbeafe");
  await dialog.getByRole("textbox", { name: "轮廓颜色", exact: true }).fill("#1d4ed8");
  await dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true }).fill("3");
  const mine = { ...content, fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 };
  const peerContent = { ...content, shortText: "对方获胜的原件", fill: "#fef3c7", stroke: "#92400e", strokeWidth: 5 };
  await execute("shape.edit", { id: shape.id, content: peerContent }, shape.versionId);
  const peer = await workspace.state() as any, peerShape = peer.shapes[0], peerHistory = await history();
  const edits: { command: any; status: number; body: any }[] = [];
  const creates: { command: any; receipt: any }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (!["shape.edit", "shape.create"].includes(command?.type)) { await route.continue(); return; }
    const response = await route.fetch(), body = await response.json();
    if (command.type === "shape.edit") edits.push({ command, status: response.status(), body });
    else creates.push({ command, receipt: body });
    if (command.type === "shape.create" && creates.length === 1)
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "恢复已提交但确认丢失" }) });
    else await route.fulfill({ response });
  });
  try {
    await dialog.getByRole("button", { name: "保存形状外观", exact: true }).click();
    await expect.poll(() => edits.length).toBe(1);
    expect(edits[0]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" },
      command: { type: "shape.edit", expected: shape.versionId, payload: { id: shape.id, content: mine } } });
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(await workspace.state()).toEqual(peer); expect(await history()).toEqual(peerHistory);
    const recover = dialog.getByRole("button", { name: "保留对方并恢复我的形状", exact: true });
    expect(await recover.count(), "真实409后须可明确保留原件并恢复完整草稿").toBe(1);
    await expect(dialog.getByRole("textbox", { name: "已保存的形状内容", exact: true })).toHaveValue(JSON.stringify(peerContent, null, 2));
    await expect(dialog.getByRole("textbox", { name: "我的形状内容", exact: true })).toHaveValue(JSON.stringify(mine, null, 2));
    expect(JSON.parse(await dialog.getByRole("textbox", { name: "我的形状位置", exact: true }).inputValue())).toEqual(shape.item.pose);
    await recover.click();
    await expect(dialog.getByRole("alert")).toContainText("恢复已提交但确认丢失");
    await expect(dialog.getByRole("textbox", { name: "我的形状内容", exact: true })).toHaveValue(JSON.stringify(mine, null, 2));
    const committed = await workspace.state() as any;
    expect(committed.shapes).toHaveLength(2); expect(creates).toHaveLength(1);
    const recovered = committed.shapes.find((value: any) => value.id !== shape.id);
    expect(recovered.id).not.toBe(shape.id); expect(recovered.item.id).not.toBe(shape.item.id);
    expect(recovered.content).toEqual(mine); expect(recovered.item.pose).toEqual(shape.item.pose);
    expect(committed.shapes.find((value: any) => value.id === shape.id)).toEqual(peerShape);
    expect(committed.project.revision).toBe(peer.project.revision + 1);
    expect(creates[0].command).toMatchObject({ projectId, type: "shape.create", expected: null,
      payload: { id: recovered.id, content: mine, pose: shape.item.pose } });
    await dialog.getByRole("button", { name: "重试恢复我的形状", exact: true }).click();
    await expect(dialog).toHaveCount(0); expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual(creates[0]); expect(edits).toHaveLength(1);
    expect(await workspace.state()).toEqual(committed);
    const restoredHistory = await history();
    expect(restoredHistory.undo).toHaveLength(peerHistory.undo.length + 1);
    expect(restoredHistory.undo.slice(0, -1)).toEqual(peerHistory.undo);
    expect(restoredHistory.undo.at(-1).label).toBe("shape.create");
    await page.getByRole("button", { name: "保护卡片", exact: true }).click();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes).toEqual([peerShape]);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes.length).toBe(2);
    const redone = await workspace.state() as any, restored = redone.shapes.find((value: any) => value.id === recovered.id);
    expect(restored.content).toEqual(mine); expect(restored.item).toMatchObject({ id: recovered.item.id, pose: shape.item.pose });
    expect(restored.versionId).not.toBe(recovered.versionId); expect(restored.item.versionId).not.toBe(recovered.item.versionId);
    expect(redone.shapes.find((value: any) => value.id === shape.id)).toEqual(peerShape);
    await page.reload(); await expect(page.getByRole("img", { name: peerContent.shortText, exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: mine.shortText, exact: true })).toBeVisible();
    const reopened = await workspace.state() as any;
    expect(reopened.shapes).toEqual(redone.shapes); expect(reopened.cards).toEqual(original.cards); expect(reopened.texts).toEqual(original.texts);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
