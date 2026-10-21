import { test, expect } from "./writing-board-fixture";

test("外观冻结请求重试409仍保留非法raw供修正，再保留对方原件并完整恢复独立形状", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "roundedRectangle", shortText: "我的完整原文😀\n不覆盖", fill: "#ffffff", stroke: "#111111", strokeWidth: 1 };
  await execute("shape.create", { id: "invalid-conflict-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
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
  const edits: { command: any; status: number; body: any }[] = [], creates: any[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type === "shape.edit" && edits.length === 0) {
      const body = { code: "UNAVAILABLE", message: "提交前503，原请求未送达服务" };
      edits.push({ command, status: 503, body });
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(body) }); return;
    }
    if (!["shape.edit", "shape.create"].includes(command?.type)) { await route.continue(); return; }
    const response = await route.fetch(), body = await response.json();
    if (command.type === "shape.edit") edits.push({ command, status: response.status(), body });
    else {
      creates.push({ command, receipt: body, status: response.status() });
      if (creates.length === 1) {
        await route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ code: "UNAVAILABLE", message: "恢复副本已创建但ACK未送达" }) }); return;
      }
    }
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("img", { name: content.shortText, exact: true }).click();
    await page.getByRole("button", { name: "形状外观", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "形状外观", exact: true });
    const fill = dialog.getByRole("textbox", { name: "填充颜色", exact: true });
    await fill.fill("#dbeafe");
    await dialog.getByRole("textbox", { name: "轮廓颜色", exact: true }).fill("#1d4ed8");
    await dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true }).fill("3");
    await dialog.getByRole("button", { name: "保存形状外观", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("提交前503");
    expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
    await fill.fill("#12"); await expect(fill).toHaveValue("#12");
    const peerContent = { ...content, shortText: "对方真实获胜原件", fill: "#fef3c7", stroke: "#92400e", strokeWidth: 5 };
    await execute("shape.edit", { id: shape.id, content: peerContent }, shape.versionId);
    const peer = await workspace.state() as any, peerHistory = await history();
    await dialog.getByRole("button", { name: "重试保存形状外观", exact: true }).click();
    await expect.poll(() => edits.length).toBe(2);
    expect(edits[0].status).toBe(503); expect(edits[1]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect(edits[1].command).toEqual(edits[0].command);
    expect(edits[0].command).toMatchObject({ projectId, type: "shape.edit", expected: shape.versionId,
      payload: { id: shape.id, content: { ...content, fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 } } });
    expect(await workspace.state()).toEqual(peer); expect(await history()).toEqual(peerHistory);
    await expect(fill, "409后非法原始字段必须留在可修正的表单中").toBeVisible();
    await expect(fill).toHaveValue("#12"); await expect(fill).toBeEditable();
    await expect(dialog.getByRole("textbox", { name: "已保存的形状内容", exact: true })).toHaveValue(JSON.stringify(peerContent, null, 2));
    await fill.fill("#dcfce7");
    const mine = { ...content, fill: "#dcfce7", stroke: "#1d4ed8", strokeWidth: 3 };
    await expect(dialog.getByRole("textbox", { name: "我的形状内容", exact: true })).toHaveValue(JSON.stringify(mine, null, 2));
    await dialog.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("恢复副本已创建但ACK未送达");
    const created = await workspace.state() as any;
    const createdCopy = created.shapes.find((value: any) => value.id !== shape.id);
    expect(createdCopy.content).toEqual(mine); expect(creates).toHaveLength(1); expect(edits).toHaveLength(2);
    await expect(fill).toBeEditable(); await fill.fill("#ede9fe");
    await dialog.getByRole("textbox", { name: "轮廓颜色", exact: true }).fill("#6d28d9");
    await dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true }).fill("7");
    const later = { ...content, fill: "#ede9fe", stroke: "#6d28d9", strokeWidth: 7 };
    expect(await workspace.state()).toEqual(created);
    await dialog.getByRole("button", { name: "重试恢复我的形状", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(edits).toHaveLength(3); expect(creates).toHaveLength(2);
    expect(creates.map(value => value.status)).toEqual([200, 200]); expect(creates[1]).toEqual(creates[0]);
    expect(edits[2]).toMatchObject({ status: 200, command: { projectId, type: "shape.edit",
      expected: creates[1].receipt.shapeVersions.shape, payload: { id: createdCopy.id, content: later } } });
    const saved = await workspace.state() as any;
    expect(saved.shapes).toHaveLength(2);
    expect(saved.shapes.find((value: any) => value.id === shape.id)).toEqual(peer.shapes[0]);
    const recovered = saved.shapes.find((value: any) => value.id !== shape.id);
    expect(recovered.id).not.toBe(shape.id); expect(recovered.item.id).not.toBe(shape.item.id);
    expect(recovered.id).toBe(createdCopy.id); expect(recovered.content).toEqual(later); expect(recovered.item.pose).toEqual(shape.item.pose);
    expect(recovered.versionId).toBe(edits[2].body.shapeVersions.shape);
    expect(creates[0].command).toMatchObject({ projectId, type: "shape.create", expected: null,
      payload: { id: recovered.id, content: mine, pose: shape.item.pose } });
    expect(saved.project.revision).toBe(peer.project.revision + 2);
    expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts);
    const recoveredHistory = await history();
    expect(recoveredHistory.undo).toHaveLength(peerHistory.undo.length + 2);
    expect(recoveredHistory.undo.slice(0, -2)).toEqual(peerHistory.undo);
    expect(recoveredHistory.undo.at(-2).label).toBe("shape.create");
    expect(recoveredHistory.undo.at(-1).label).toBe("shape.edit");
    await page.getByRole("button", { name: "保护卡片", exact: true }).click();
    await page.reload(); await expect(page.getByRole("img", { name: mine.shortText, exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: peerContent.shortText, exact: true })).toBeVisible();
    expect(await workspace.state()).toEqual(saved);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
