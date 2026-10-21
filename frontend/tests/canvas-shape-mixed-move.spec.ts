import { test, expect } from "./writing-board-fixture";

test("Shape起拖混合多选整组预览取消与一次原子移动，未知ACK原样重试且真实409不部分写入", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "moving-card", title: "共同移动卡片", text: "保留完整正文", x: 100, y: 160 });
  await execute("text.create", { id: "moving-text", content: {
    runs: [{ text: "共同移动文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 700, y: 350, width: 190, height: 27 } });
  const content = { shapeType: "ellipse", shortText: "共同移动形状😀", fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 };
  await execute("shape.create", { id: "moving-shape", content, pose: { x: 380, y: 220, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any;
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history(), attempts: { command: any; status: number; body: any }[] = [], writes: any[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/mapping/execute") && request.method() === "POST") {
      const command = request.postDataJSON();
      if (["canvas.move", "shape.move", "text.move", "card.move"].includes(command?.type)) writes.push(command);
    }
  });
  let releaseConflict = () => {}, conflictArrived = () => {};
  const conflictGate = new Promise<void>(resolve => { releaseConflict = resolve; });
  const conflictRequest = new Promise<void>(resolve => { conflictArrived = resolve; });
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "canvas.move") { await route.continue(); return; }
    if (attempts.length === 2) { conflictArrived(); await conflictGate; }
    const response = await route.fetch(), body = await response.json();
    attempts.push({ command, status: response.status(), body });
    if (attempts.length === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message: "整组移动已提交但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  const visual = page.getByRole("img", { name: content.shortText, exact: true });
  const selectAll = async () => {
    await visual.click();
    await page.getByRole("button", { name: "共同移动卡片", exact: true }).click({ modifiers: ["Shift"] });
    await page.getByText("共同移动文字", { exact: true }).click({ modifiers: ["Shift"] });
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
  };
  const members = (state: any) => [...state.cards, ...state.texts, ...state.shapes];
  const position = (id: string) => page.locator('.react-flow__node[data-id="' + id + '"]').evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f };
  });
  const assertContentAndPose = (state: any, before: any, dx: number, dy: number) => {
    for (const origin of members(before)) {
      const actual = members(state).find(value => value.id === origin.id);
      expect(actual).toEqual({ ...origin, item: { ...origin.item, versionId: actual.item.versionId,
        pose: { ...origin.item.pose, x: origin.item.pose.x + dx, y: origin.item.pose.y + dy } } });
      expect(actual.item.versionId).not.toBe(origin.item.versionId);
    }
  };
  try {
    await selectAll();
    const zoom = await page.locator(".react-flow__viewport").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
    expect(zoom).toBe(1);
    const dx = 80, dy = 50, box = (await visual.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
    for (const target of members(original)) {
      await expect.poll(async () => (await position(target.item.id)).x, "Shape起拖必须让整组实际呈现同一世界delta").toBeCloseTo(target.item.pose.x + dx / zoom, 4);
      await expect.poll(async () => (await position(target.item.id)).y).toBeCloseTo(target.item.pose.y + dy / zoom, 4);
    }
    expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory); expect(writes).toEqual([]);
    await page.keyboard.press("Escape");
    for (const target of members(original)) await expect.poll(() => position(target.item.id)).toEqual({ x: target.item.pose.x, y: target.item.pose.y });
    await page.mouse.move(box.x + box.width / 2 + dx + 20, box.y + box.height / 2 + dy + 12); await page.mouse.up();
    for (const target of members(original)) await expect.poll(() => position(target.item.id)).toEqual({ x: target.item.pose.x, y: target.item.pose.y });
    expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory); expect(writes).toEqual([]);
    const next = (await visual.boundingBox())!;
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2); await page.mouse.down();
    await page.mouse.move(next.x + next.width / 2 + dx, next.y + next.height / 2 + dy, { steps: 5 });
    expect(await workspace.state()).toEqual(original); await page.mouse.up();
    await expect(page.locator(".save-state").getByRole("alert").filter({ hasText: "整组移动已提交但ACK未送达" })).toBeVisible();
    expect(attempts).toHaveLength(1); expect(attempts[0].status).toBe(200);
    expect(attempts[0].command).toMatchObject({ projectId, type: "canvas.move",
      expected: Object.fromEntries(members(original).map(value => [value.item.id, value.item.versionId])) });
    expect(attempts[0].command.payload.targets).toEqual([
      { kind: "card", id: "moving-card", itemId: original.cards[0].item.id, x: 180, y: 210 },
      { kind: "text", id: "moving-text", itemId: original.texts[0].item.id, x: 780, y: 400 },
      { kind: "shape", id: "moving-shape", itemId: original.shapes[0].item.id, x: 460, y: 270 },
    ]);
    const moved = await workspace.state() as any; assertContentAndPose(moved, original, dx / zoom, dy / zoom);
    expect(moved.project.revision).toBe(original.project.revision + 1);
    const movedHistory = await history(); expect(movedHistory.undo).toHaveLength(originalHistory.undo.length + 1);
    expect(movedHistory.undo.at(-1).label).toBe("canvas.move");
    await page.getByRole("button", { name: "重试文字保存", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(2); expect(attempts[1]).toEqual(attempts[0]);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(await workspace.state()).toEqual(moved); expect(await history()).toEqual(movedHistory);
    expect(writes).toEqual([attempts[0].command, attempts[0].command]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => members(await workspace.state()).map(value => value.item.pose)).toEqual(members(original).map(value => value.item.pose));
    const undone = await workspace.state() as any; assertContentAndPose(undone, original, 0, 0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => members(await workspace.state()).map(value => value.item.pose)).toEqual(members(moved).map(value => value.item.pose));
    const redone = await workspace.state() as any; assertContentAndPose(redone, original, dx / zoom, dy / zoom);
    await page.reload(); await expect(visual).toBeVisible(); expect(await workspace.state()).toEqual(redone);
    await selectAll();
    const conflictStart = (await visual.boundingBox())!;
    await page.mouse.move(conflictStart.x + conflictStart.width / 2, conflictStart.y + conflictStart.height / 2); await page.mouse.down();
    await page.mouse.move(conflictStart.x + conflictStart.width / 2 + 40, conflictStart.y + conflictStart.height / 2 + 30, { steps: 5 });
    expect(await workspace.state()).toEqual(redone); await page.mouse.up(); await conflictRequest;
    await execute("shape.move", { id: "moving-shape", x: 450, y: 340 }, redone.shapes[0].item.versionId);
    const peer = await workspace.state() as any, peerHistory = await history(); releaseConflict();
    await expect.poll(() => attempts.length).toBe(3);
    expect(attempts[2]).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" }, command: {
      expected: Object.fromEntries(members(redone).map(value => [value.item.id, value.item.versionId])),
    } });
    expect(await workspace.state()).toEqual(peer); expect(await history()).toEqual(peerHistory);
    const comparison = page.getByRole("region", { name: "混合移动保存冲突", exact: true }); await expect(comparison).toBeVisible();
    const shapeRow = comparison.getByRole("row").filter({ hasText: "形状" });
    await expect(shapeRow, "冲突必须明确列出Shape及其真实已保存位置").toContainText("450, 340");
    await expect(shapeRow).not.toContainText("对象已删除"); expect(attempts).toHaveLength(3);
    await comparison.getByRole("button", { name: "放弃本次混合移动，保留已保存位置", exact: true }).click();
    await expect(comparison).toHaveCount(0); expect(await workspace.state()).toEqual(peer); expect(await history()).toEqual(peerHistory);
    await page.reload(); await expect(visual).toBeVisible(); expect(await workspace.state()).toEqual(peer);
    await visual.click(); await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true }); await expect(editor).toHaveValue(content.shortText);
    await editor.press("Escape"); await expect(editor).toHaveCount(0); expect(await workspace.state()).toEqual(peer);
  } finally { releaseConflict(); await page.unrouteAll({ behavior: "wait" }); }
});
