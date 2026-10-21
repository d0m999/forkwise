import { test, expect } from "./writing-board-fixture";

test("形状位置未知请求原样重试到真实409，明确比较确认后重申位置且丢ACK仍幂等可继续工作", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整保护正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "ellipse", shortText: "原始形状内容", fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 };
  await execute("shape.create", { id: "conflicting-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
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
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "shape.move") { await route.continue(); return; }
    if (attempts.length === 0) {
      const body = { code: "UNAVAILABLE", message: "位置提交前503，原请求未送达" };
      attempts.push({ command, status: 503, body });
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(body) }); return;
    }
    const response = await route.fetch(), body = await response.json();
    attempts.push({ command, status: response.status(), body });
    if (attempts.length === 3) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message: "确认的位置已提交但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    const scale = await page.locator(".react-flow__viewport").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
    expect(scale).toBe(1);
    const visual = page.getByRole("img", { name: content.shortText, exact: true }); await visual.click();
    const box = (await visual.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2 + 64, { steps: 5 }); await page.mouse.up();
    await expect(page.getByRole("alert").filter({ hasText: "位置提交前503" })).toBeVisible();
    expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
    const peerContent = { ...content, shortText: "对方更新的完整内容😀", fill: "#dcfce7", strokeWidth: 5 };
    await execute("shape.edit", { id: shape.id, content: peerContent }, shape.versionId);
    await execute("shape.move", { id: shape.id, x: 120, y: 330 }, shape.item.versionId);
    const peer = await workspace.state() as any, peerHistory = await history();
    await page.getByRole("button", { name: "重试保存形状位置", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1].command).toEqual(attempts[0].command);
    expect(attempts[0].command).toMatchObject({ projectId, type: "shape.move", expected: shape.item.versionId,
      payload: { id: shape.id, x: 346, y: 254 } });
    expect(attempts[1]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect(await workspace.state()).toEqual(peer); expect(await history()).toEqual(peerHistory);
    const comparison = page.getByRole("region", { name: "形状位置保存冲突", exact: true });
    await expect(comparison, "真实位置409后必须让用户看见双方位置并明确确认").toBeVisible();
    await expect(comparison.getByText("本次位置：346, 254", { exact: true })).toBeVisible();
    await expect(comparison.getByText("已保存位置：120, 330", { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2);
    await comparison.getByRole("button", { name: "确认保留本次位置", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "确认的位置已提交但ACK未送达" })).toBeVisible();
    expect(attempts).toHaveLength(3); expect(attempts[2].status).toBe(200);
    expect(attempts[2].command.commandId).not.toBe(attempts[0].command.commandId);
    expect(attempts[2].command).toMatchObject({ projectId, type: "shape.move", expected: peer.shapes[0].item.versionId,
      payload: { id: shape.id, x: 346, y: 254 } });
    const committed = await workspace.state() as any;
    expect(committed.project.revision).toBe(peer.project.revision + 1);
    expect(committed.shapes[0]).toMatchObject({ id: shape.id, versionId: peer.shapes[0].versionId, content: peerContent,
      item: { id: shape.item.id, pose: { x: 346, y: 254, width: 240, height: 130 } } });
    await page.getByRole("button", { name: "重试保存形状位置", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(4); expect(attempts[3]).toEqual(attempts[2]);
    await expect(comparison).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重试保存形状位置", exact: true })).toHaveCount(0);
    expect(await workspace.state()).toEqual(committed);
    const savedHistory = await history(); expect(savedHistory.undo).toHaveLength(peerHistory.undo.length + 1);
    expect(savedHistory.undo.slice(0, -1)).toEqual(peerHistory.undo); expect(savedHistory.undo.at(-1).label).toBe("shape.move");
    expect(committed.cards).toEqual(original.cards); expect(committed.texts).toEqual(original.texts);
    const savedVisual = page.getByRole("img", { name: peerContent.shortText, exact: true }); await savedVisual.click();
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true }); await expect(editor).toHaveValue(peerContent.shortText);
    await editor.press("Escape"); await expect(editor).toHaveCount(0); expect(await workspace.state()).toEqual(committed);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes[0].item.pose).toEqual(peer.shapes[0].item.pose);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes[0].item.pose).toEqual(committed.shapes[0].item.pose);
    const redone = await workspace.state() as any;
    expect(redone.shapes[0]).toMatchObject({ id: shape.id, versionId: peer.shapes[0].versionId, content: peerContent, item: { id: shape.item.id } });
    await page.reload(); await expect(savedVisual).toBeVisible(); expect(await workspace.state()).toEqual(redone);
    expect(redone.cards).toEqual(original.cards); expect(redone.texts).toEqual(original.texts);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
