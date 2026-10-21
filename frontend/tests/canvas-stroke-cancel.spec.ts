import { test, expect } from "./writing-board-fixture";

test("画笔采点后 Esc 取消立即清除预览，晚到抬起不写入并可重新绘制保存", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const seed = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await seed("thought.create", { id: "protected-card", title: "取消保护卡", text: "完整保护正文", x: 820, y: 100 });
  await seed("text.create", { id: "protected-text", content: {
    runs: [{ text: "取消保护文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 820, y: 430, width: 190, height: 27 } });
  await seed("shape.create", { id: "protected-shape", content: {
    shapeType: "triangle", shortText: "取消保护形状", fill: "#dce8dd", stroke: "#403b36", strokeWidth: 2,
  }, pose: { x: 600, y: 280, width: 150, height: 90 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const baseline = await workspace.state() as any;
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(baseline.project.revision));
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const beforeHistory = await history(), creates: any[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/mapping/execute") && request.method() === "POST") {
      const command = request.postDataJSON(); if (command?.type === "stroke.create") creates.push(command);
    }
  });
  const choosePen = async () => {
    await page.getByRole("button", { name: "画笔", exact: true }).click();
    await page.getByRole("menuitem", { name: "普通笔", exact: true }).click();
    await expect(page.getByRole("button", { name: "画笔", exact: true })).toHaveAttribute("aria-pressed", "true");
  };
  await choosePen();
  const flow = (await page.locator(".react-flow").boundingBox())!;
  await page.mouse.move(flow.x + 180, flow.y + 220); await page.mouse.down();
  await page.mouse.move(flow.x + 210, flow.y + 240); await page.mouse.move(flow.x + 245, flow.y + 225);
  const preview = page.getByRole("img", { name: "笔迹预览", exact: true });
  await expect(preview).toBeVisible(); await expect(preview.locator("path")).toHaveAttribute("d", /^M.+ L.+ L/);
  expect(creates).toHaveLength(0); expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(beforeHistory);
  await page.keyboard.press("Escape");
  await expect(preview, "Esc 必须同步取消本次采点并移除预览").toHaveCount(0);
  expect(creates).toHaveLength(0); expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(beforeHistory);
  await page.mouse.move(flow.x + 280, flow.y + 255); await page.mouse.up();
  await expect(preview).toHaveCount(0); expect(creates).toHaveLength(0);
  expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(beforeHistory);
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(baseline.project.revision));
  await expect(page.locator(".react-flow__node-canvasStroke")).toHaveCount(0);
  await choosePen();
  await page.mouse.move(flow.x + 320, flow.y + 340); await page.mouse.down();
  await page.mouse.move(flow.x + 355, flow.y + 365); await page.mouse.move(flow.x + 390, flow.y + 345);
  await expect(preview).toBeVisible(); expect(creates).toHaveLength(0); expect(await workspace.state()).toEqual(baseline);
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state() as any).strokes.length).toBe(1);
  await expect(page.getByRole("status")).toHaveText("已保存到本机"); await expect(preview).toHaveCount(0);
  expect(creates).toHaveLength(1); const saved = await workspace.state() as any;
  expect(saved.project.revision).toBe(baseline.project.revision + 1);
  expect(saved.strokes[0].content).toMatchObject({ penKind: "pen", color: "#403b36", width: 2, opacity: 1 });
  expect(saved.strokes[0].content.path).toHaveLength(3);
  expect(creates[0]).toMatchObject({ projectId, type: "stroke.create", expected: null,
    payload: { id: saved.strokes[0].id, content: saved.strokes[0].content, pose: saved.strokes[0].item.pose } });
  const afterHistory = await history(); expect(afterHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
  expect(afterHistory.undo.at(-1)).toMatchObject({ id: creates[0].commandId, label: "stroke.create" });
  for (const key of ["cards", "texts", "shapes", "tags"]) expect(saved[key]).toEqual(baseline[key]);
  await expect(page.locator(".react-flow__node-canvasStroke")).toHaveCount(1);
});
