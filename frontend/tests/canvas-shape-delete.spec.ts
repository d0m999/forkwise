import { test, expect } from "./writing-board-fixture";

test("单形状Delete与具名删除保输入及混选，未知结果原样重试，真实409后仅再次明确删除新版并可撤销重开", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整保护正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "diamond", shortText: "待删除的完整形状😀", fill: "#fef3c7", stroke: "#92400e", strokeWidth: 3 };
  await execute("shape.create", { id: "deleted-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history(), attempts: { command: any; status: number; body: any }[] = [];
  let releaseNamed = () => {}, namedArrived = () => {};
  const namedGate = new Promise<void>(resolve => { releaseNamed = resolve; });
  const namedRequest = new Promise<void>(resolve => { namedArrived = resolve; });
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "shape.delete") { await route.continue(); return; }
    if (attempts.length === 2) { namedArrived(); await namedGate; }
    const response = await route.fetch(), body = await response.json();
    attempts.push({ command, status: response.status(), body });
    if (attempts.length === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message: "形状删除已提交但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    const visual = page.getByRole("img", { name: content.shortText, exact: true }); await visual.click();
    // DOM composition covers headless dispatch only, not native OS IME.
    await visual.dispatchEvent("keydown", { key: "Delete", code: "Delete", isComposing: true, keyCode: 229 });
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    await editor.fill(content.shortText);
    expect(await editor.evaluate(element => { const input = element as HTMLTextAreaElement; return [input.selectionStart, input.selectionEnd]; })).toEqual([content.shortText.length, content.shortText.length]);
    await editor.press("Delete");
    await expect(editor).toHaveValue(content.shortText); await editor.press("Escape"); await expect(editor).toHaveCount(0);
    await visual.click(); await page.getByRole("button", { name: "保护卡片", exact: true }).click({ modifiers: ["Shift"] });
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    await visual.press("Delete");
    expect(attempts).toEqual([]); expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
    await page.locator(".react-flow__pane").click({ position: { x: 100, y: 510 } }); await visual.click();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
    await visual.press("Delete");
    await expect.poll(() => attempts.length, "聚焦的单一形状Delete应发出真实shape.delete").toBe(1);
    await expect(page.getByRole("alert").filter({ hasText: "形状删除已提交但ACK未送达" })).toBeVisible();
    expect(attempts[0]).toMatchObject({ status: 200, command: { projectId, type: "shape.delete",
      expected: { shape: shape.versionId, pose: shape.item.versionId }, payload: { id: shape.id } } });
    const deleted = await workspace.state() as any;
    expect(deleted.shapes).toEqual([]); expect(deleted.project.revision).toBe(original.project.revision + 1);
    const deletedHistory = await history(); expect(deletedHistory.undo).toHaveLength(originalHistory.undo.length + 1);
    expect(deletedHistory.undo.at(-1).label).toBe("shape.delete");
    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(2); expect(attempts[1]).toEqual(attempts[0]);
    await expect(visual).toHaveCount(0); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(await workspace.state()).toEqual(deleted); expect(await history()).toEqual(deletedHistory);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(visual).toBeVisible();
    const undone = await workspace.state() as any;
    expect(undone.shapes[0]).toMatchObject({ id: shape.id, content, item: { id: shape.item.id, pose: shape.item.pose } });
    expect(undone.shapes[0].versionId).not.toBe(shape.versionId); expect(undone.shapes[0].item.versionId).not.toBe(shape.item.versionId);
    await page.getByRole("button", { name: "重做", exact: true }).click(); await expect(visual).toHaveCount(0);
    expect((await workspace.state() as any).shapes).toEqual([]);
    await page.getByRole("button", { name: "撤销", exact: true }).click(); await expect(visual).toBeVisible();
    const restored = await workspace.state() as any, captured = restored.shapes[0];
    expect(captured).toMatchObject({ id: shape.id, content, item: { id: shape.item.id, pose: shape.item.pose } });
    await visual.click(); await page.getByRole("button", { name: "删除形状", exact: true }).click(); await namedRequest;
    const peerContent = { ...content, shortText: "对方保留的完整形状", fill: "#dcfce7", strokeWidth: 5 };
    const peerPose = { x: 160, y: 330, width: 280, height: 150 };
    await execute("shape.edit", { id: shape.id, content: peerContent }, captured.versionId);
    await execute("shape.transform", { id: shape.id, pose: peerPose }, captured.item.versionId);
    const peer = await workspace.state() as any, peerHistory = await history(); releaseNamed();
    await expect.poll(() => attempts.length).toBe(3);
    expect(attempts[2]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" }, command: {
      projectId, type: "shape.delete", expected: { shape: captured.versionId, pose: captured.item.versionId }, payload: { id: shape.id },
    } });
    expect(await workspace.state()).toEqual(peer); expect(await history()).toEqual(peerHistory);
    const peerVisual = page.getByRole("img", { name: peerContent.shortText, exact: true }); await expect(peerVisual).toBeVisible();
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(peer.project.revision));
    expect(attempts).toHaveLength(3);
    await peerVisual.click(); await page.getByRole("button", { name: "删除形状", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(4); expect(attempts[3].status).toBe(200);
    expect(attempts[3].command.commandId).not.toBe(attempts[2].command.commandId);
    expect(attempts[3].command).toMatchObject({ projectId, type: "shape.delete",
      expected: { shape: peer.shapes[0].versionId, pose: peer.shapes[0].item.versionId }, payload: { id: shape.id } });
    await expect(peerVisual).toHaveCount(0); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const finalDeleted = await workspace.state() as any;
    expect(finalDeleted.shapes).toEqual([]); expect(finalDeleted.project.revision).toBe(peer.project.revision + 1);
    expect((await history()).undo).toHaveLength(peerHistory.undo.length + 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click(); await expect(peerVisual).toBeVisible();
    const recovered = await workspace.state() as any;
    expect(recovered.shapes[0]).toMatchObject({ id: shape.id, content: peerContent, item: { id: shape.item.id, pose: peerPose } });
    expect(recovered.cards).toEqual(original.cards); expect(recovered.texts).toEqual(original.texts);
    await page.reload(); await expect(peerVisual).toBeVisible(); expect(await workspace.state()).toEqual(recovered);
    await peerVisual.click(); await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    await expect(editor).toHaveValue(peerContent.shortText); await editor.press("Escape"); await expect(editor).toHaveCount(0);
    expect(await workspace.state()).toEqual(recovered);
  } finally { releaseNamed(); await page.unrouteAll({ behavior: "wait" }); }
});
