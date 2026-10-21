import { test, expect } from "./writing-board-fixture";

test("形状短文冻结请求真实409后显式保两份，恢复创建丢ACK仍保留后续输入并仅改副本", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整卡片正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "triangle", shortText: "原始形状短文", fill: "#dcfce7", stroke: "#166534", strokeWidth: 3 };
  await execute("shape.create", { id: "text-conflict-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
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
      const body = { code: "UNAVAILABLE", message: "短文提交前503，原请求未送达" };
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
          body: JSON.stringify({ code: "UNAVAILABLE", message: "我的形状已创建但ACK未送达" }) }); return;
      }
    }
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("img", { name: content.shortText, exact: true }).click();
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    const textA = "我先发送的A😀", textB = "我的较新B😀\n保留完整换行", textC = "我的最后C🧭\n恢复后继续输入";
    await editor.fill(textA);
    await page.getByRole("button", { name: "保存形状文字", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "短文提交前503" })).toBeVisible();
    expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
    await expect(editor).toBeEditable(); await editor.fill(textB);
    const peerContent = { ...content, shortText: "对方真实获胜的原件", fill: "#fef3c7", stroke: "#92400e", strokeWidth: 5 };
    await execute("shape.edit", { id: shape.id, content: peerContent }, shape.versionId);
    const peer = await workspace.state() as any, peerHistory = await history();
    await page.getByRole("button", { name: "重试保存形状文字", exact: true }).click();
    await expect.poll(() => edits.length).toBe(2);
    expect(edits[1]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect(edits[1].command).toEqual(edits[0].command);
    expect(edits[0].command).toMatchObject({ projectId, type: "shape.edit", expected: shape.versionId,
      payload: { id: shape.id, content: { ...content, shortText: textA } } });
    expect(await workspace.state()).toEqual(peer); expect(await history()).toEqual(peerHistory);
    const comparison = page.getByRole("region", { name: "形状文字保存冲突", exact: true });
    await expect(comparison, "真实409后必须让用户比较双方并明确保留两份").toBeVisible();
    await expect(comparison.getByRole("textbox", { name: "已保存的形状文字", exact: true })).toHaveValue(peerContent.shortText);
    await expect(comparison.getByRole("textbox", { name: "我的形状文字", exact: true })).toHaveValue(textB);
    await expect(editor).toHaveValue(textB);
    await comparison.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "我的形状已创建但ACK未送达" })).toBeVisible();
    const created = await workspace.state() as any, createdCopy = created.shapes.find((value: any) => value.id !== shape.id);
    expect(createdCopy.content).toEqual({ ...content, shortText: textB }); expect(creates).toHaveLength(1);
    await expect(editor).toBeEditable(); await editor.fill(textC);
    expect(await workspace.state()).toEqual(created);
    await comparison.getByRole("button", { name: "重试恢复我的形状", exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(comparison).toHaveCount(0);
    expect(creates).toHaveLength(2); expect(creates.map(value => value.status)).toEqual([200, 200]);
    expect(creates[1]).toEqual(creates[0]); expect(edits).toHaveLength(3);
    expect(edits[2]).toMatchObject({ status: 200, command: { projectId, type: "shape.edit",
      expected: creates[1].receipt.shapeVersions.shape,
      payload: { id: createdCopy.id, content: { ...content, shortText: textC } } } });
    const saved = await workspace.state() as any, recovered = saved.shapes.find((value: any) => value.id !== shape.id);
    expect(saved.shapes).toHaveLength(2); expect(saved.shapes.find((value: any) => value.id === shape.id)).toEqual(peer.shapes[0]);
    expect(recovered.id).toBe(createdCopy.id); expect(recovered.id).not.toBe(shape.id); expect(recovered.item.id).not.toBe(shape.item.id);
    expect(recovered.content).toEqual({ ...content, shortText: textC }); expect(recovered.item.pose).toEqual(shape.item.pose);
    expect(recovered.versionId).toBe(edits[2].body.shapeVersions.shape);
    expect(creates[0].command).toMatchObject({ projectId, type: "shape.create", expected: null,
      payload: { id: recovered.id, content: { ...content, shortText: textB }, pose: shape.item.pose } });
    expect(saved.project.revision).toBe(peer.project.revision + 2); expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts);
    const savedHistory = await history(); expect(savedHistory.undo).toHaveLength(peerHistory.undo.length + 2);
    expect(savedHistory.undo.slice(0, -2)).toEqual(peerHistory.undo);
    expect(savedHistory.undo.at(-2).label).toBe("shape.create"); expect(savedHistory.undo.at(-1).label).toBe("shape.edit");
    await page.getByRole("button", { name: "保护卡片", exact: true }).click();
    await page.reload(); await expect(page.getByRole("img", { name: textC, exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: peerContent.shortText, exact: true })).toBeVisible();
    expect(await workspace.state()).toEqual(saved);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
