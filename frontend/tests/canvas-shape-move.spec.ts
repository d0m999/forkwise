import { test, expect } from "./writing-board-fixture";

test("单形状在缩放平移后拖动仅预览，Esc及晚到up不写，完整移动只提交一次并可撤销重开", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整保护正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "roundedRectangle", shortText: "完整形状😀\n世界位置", fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 };
  await execute("shape.create", { id: "moving-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history(), moves: any[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/mapping/execute") && request.method() === "POST") {
      const command = request.postDataJSON(); if (command?.type === "shape.move") moves.push(command);
    }
  });
  const viewport = () => page.locator(".react-flow__viewport").evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  const initialViewport = await viewport();
  await page.locator("button.react-flow__controls-zoomout").click();
  await expect.poll(async () => (await viewport()).zoom).not.toBe(initialViewport.zoom);
  await page.getByRole("button", { name: "移动", exact: true }).click();
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const beforePan = await viewport();
  await page.mouse.move(pane.x + 120, pane.y + pane.height - 100); await page.mouse.down();
  await page.mouse.move(pane.x + 190, pane.y + pane.height - 55, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await viewport()).x).not.toBe(beforePan.x);
  await page.getByRole("button", { name: "选择", exact: true }).click();
  const view = await viewport(); expect(view.zoom).not.toBe(1); expect(view.y).not.toBe(initialViewport.y);
  const visual = page.getByRole("img", { name: content.shortText, exact: true }); await visual.click();
  const node = page.locator('.react-flow__node[data-id="' + shape.item.id + '"]');
  const position = () => node.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f };
  });
  const start = (await visual.boundingBox())!, dx = 96, dy = 64;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + dx, start.y + start.height / 2 + dy, { steps: 5 });
  await expect.poll(async () => (await position()).x, "按住指针时形状必须实际呈现世界坐标预览").toBeCloseTo(shape.item.pose.x + dx / view.zoom, 4);
  await expect.poll(async () => (await position()).y).toBeCloseTo(shape.item.pose.y + dy / view.zoom, 4);
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory); expect(moves).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect.poll(position).toEqual({ x: shape.item.pose.x, y: shape.item.pose.y });
  await page.mouse.move(start.x + start.width / 2 + dx + 18, start.y + start.height / 2 + dy + 12); await page.mouse.up();
  await expect.poll(position).toEqual({ x: shape.item.pose.x, y: shape.item.pose.y });
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory); expect(moves).toHaveLength(0);
  const nextStart = (await visual.boundingBox())!;
  await page.mouse.move(nextStart.x + nextStart.width / 2, nextStart.y + nextStart.height / 2); await page.mouse.down();
  await page.mouse.move(nextStart.x + nextStart.width / 2 + dx, nextStart.y + nextStart.height / 2 + dy, { steps: 5 });
  expect(await workspace.state()).toEqual(original); expect(moves).toHaveLength(0); await page.mouse.up();
  await expect.poll(async () => (await workspace.state() as any).project.revision).toBe(original.project.revision + 1);
  const moved = await workspace.state() as any, value = moved.shapes[0]; expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({ projectId, type: "shape.move", expected: shape.item.versionId, payload: { id: shape.id } });
  expect(value).toMatchObject({ id: shape.id, versionId: shape.versionId, content, item: { id: shape.item.id } });
  expect(value.item.pose.x).toBeCloseTo(shape.item.pose.x + dx / view.zoom, 4);
  expect(value.item.pose.y).toBeCloseTo(shape.item.pose.y + dy / view.zoom, 4);
  expect(value.item.pose.width).toBe(240); expect(value.item.pose.height).toBe(130);
  expect(value.item.versionId).not.toBe(shape.item.versionId);
  expect(moved.cards).toEqual(original.cards); expect(moved.texts).toEqual(original.texts);
  const movedHistory = await history(); expect(movedHistory.undo).toHaveLength(originalHistory.undo.length + 1);
  expect(movedHistory.undo.at(-1).label).toBe("shape.move");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await workspace.state() as any).shapes[0].item.pose).toEqual(shape.item.pose);
  const undone = await workspace.state() as any; expect(undone.shapes[0].content).toEqual(content);
  expect(undone.shapes[0].versionId).toBe(shape.versionId); expect(undone.shapes[0].item.versionId).not.toBe(value.item.versionId);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect.poll(async () => (await workspace.state() as any).shapes[0].item.pose).toEqual(value.item.pose);
  const redone = await workspace.state() as any;
  expect(redone.shapes[0]).toMatchObject({ id: shape.id, versionId: shape.versionId, content, item: { id: shape.item.id } });
  expect(redone.shapes[0].item.versionId).not.toBe(undone.shapes[0].item.versionId);
  expect(redone.cards).toEqual(original.cards); expect(redone.texts).toEqual(original.texts);
  await page.reload(); await expect(visual).toBeVisible(); expect(await workspace.state()).toEqual(redone);
});
