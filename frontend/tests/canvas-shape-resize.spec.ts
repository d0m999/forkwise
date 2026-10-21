import { test, expect } from "./writing-board-fixture";

test("单形状缩放平移下NW角缩放统一投影并可取消，Pose独立提交撤销重开且同角点键盘按世界单位", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保护完整正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "diamond", shortText: "完整菱形😀\n独立内容", fill: "#dcfce7", stroke: "#166534", strokeWidth: 3 };
  await execute("shape.create", { id: "resizing-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history(), transforms: any[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/mapping/execute") && request.method() === "POST") {
      const command = request.postDataJSON(); if (command?.type === "shape.transform") transforms.push(command);
    }
  });
  const viewport = () => page.locator(".react-flow__viewport").evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  await page.locator("button.react-flow__controls-zoomout").click();
  await expect.poll(async () => (await viewport()).zoom).not.toBe(1);
  await page.getByRole("button", { name: "移动", exact: true }).click();
  const pane = (await page.locator(".react-flow__pane").boundingBox())!, beforePan = await viewport();
  await page.mouse.move(pane.x + 120, pane.y + pane.height - 100); await page.mouse.down();
  await page.mouse.move(pane.x + 190, pane.y + pane.height - 55, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await viewport()).x).not.toBe(beforePan.x);
  await page.getByRole("button", { name: "选择", exact: true }).click();
  const visual = page.getByRole("img", { name: content.shortText, exact: true }); await visual.click();
  const handle = page.getByRole("button", { name: "调整形状尺寸：左上", exact: true });
  await expect(handle, "单选Shape须提供可访问的具名NW缩放角点").toBeVisible();
  const node = page.locator('.react-flow__node[data-id="' + shape.item.id + '"]');
  const geometry = () => node.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    const zoom = new DOMMatrix(getComputedStyle(element.closest(".react-flow__viewport")!).transform).a;
    const box = element.getBoundingClientRect(), image = element.querySelector('[role="img"]')!.getBoundingClientRect();
    const svg = element.querySelector("svg")!.getBoundingClientRect();
    return { x: matrix.e, y: matrix.f, width: box.width / zoom, height: box.height / zoom,
      imageWidth: image.width / zoom, imageHeight: image.height / zoom, svgWidth: svg.width / zoom, svgHeight: svg.height / zoom };
  });
  const zoom = (await viewport()).zoom, dx = -80, dy = -40;
  const expectedPose = { x: 250 + dx / zoom, y: 190 + dy / zoom, width: 240 - dx / zoom, height: 130 - dy / zoom };
  const begin = async () => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
  };
  await begin();
  await expect.poll(async () => (await geometry()).x).toBeCloseTo(expectedPose.x, 3);
  const preview = await geometry();
  for (const key of ["x", "y", "width", "height"] as const) expect(preview[key]).toBeCloseTo(expectedPose[key], 3);
  expect(preview.x + preview.width).toBeCloseTo(490, 3); expect(preview.y + preview.height).toBeCloseTo(320, 3);
  expect(preview.imageWidth).toBeCloseTo(expectedPose.width, 2); expect(preview.svgWidth).toBeCloseTo(expectedPose.width, 2);
  expect(preview.imageHeight).toBeCloseTo(expectedPose.height, 2); expect(preview.svgHeight).toBeCloseTo(expectedPose.height, 2);
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory); expect(transforms).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await geometry()).x).toBe(250);
  await page.mouse.move(pane.x + 30, pane.y + 100); await page.mouse.up();
  const cancelled = await geometry(); expect(cancelled.x).toBe(250); expect(cancelled.y).toBe(190);
  expect(cancelled.width).toBeCloseTo(240, 2); expect(cancelled.height).toBeCloseTo(130, 2);
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory); expect(transforms).toHaveLength(0);
  await begin(); expect(await workspace.state()).toEqual(original); await page.mouse.up();
  await expect.poll(async () => (await workspace.state() as any).project.revision).toBe(original.project.revision + 1);
  const saved = await workspace.state() as any, value = saved.shapes[0]; expect(transforms).toHaveLength(1);
  expect(transforms[0]).toMatchObject({ projectId, type: "shape.transform", expected: shape.item.versionId, payload: { id: shape.id } });
  for (const key of ["x", "y", "width", "height"] as const) expect(value.item.pose[key]).toBeCloseTo(expectedPose[key], 3);
  expect(value).toMatchObject({ id: shape.id, versionId: shape.versionId, content, item: { id: shape.item.id } });
  expect(value.item.versionId).not.toBe(shape.item.versionId); expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts);
  expect((await history()).undo).toHaveLength(originalHistory.undo.length + 1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await workspace.state() as any).shapes[0].item.pose).toEqual(shape.item.pose);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect.poll(async () => (await workspace.state() as any).shapes[0].item.pose).toEqual(value.item.pose);
  await page.reload(); await expect(visual).toBeVisible(); await visual.click(); await expect(handle).toBeVisible();
  const beforeKeys = await workspace.state() as any;
  await handle.dispatchEvent("keydown", { key: "ArrowRight", code: "ArrowRight", isComposing: true, keyCode: 229 });
  expect(await workspace.state()).toEqual(beforeKeys); expect(transforms).toHaveLength(1);
  await handle.focus(); await handle.press("ArrowLeft");
  await expect.poll(async () => (await workspace.state() as any).project.revision).toBe(beforeKeys.project.revision + 1);
  const keyed = await workspace.state() as any;
  expect(keyed.shapes[0].item.pose).toEqual({ ...value.item.pose, x: value.item.pose.x - 1, width: value.item.pose.width + 1 });
  await handle.press("Shift+ArrowUp");
  await expect.poll(async () => (await workspace.state() as any).project.revision).toBe(beforeKeys.project.revision + 2);
  const final = await workspace.state() as any;
  expect(final.shapes[0].item.pose).toEqual({ ...keyed.shapes[0].item.pose, y: keyed.shapes[0].item.pose.y - 10, height: keyed.shapes[0].item.pose.height + 10 });
  expect(final.shapes[0]).toMatchObject({ id: shape.id, versionId: shape.versionId, content, item: { id: shape.item.id } });
  expect(transforms).toHaveLength(3); expect(transforms[2].expected).toBe(keyed.shapes[0].item.versionId);
  expect(final.cards).toEqual(original.cards); expect(final.texts).toEqual(original.texts);
  await page.reload(); await expect(visual).toBeVisible(); expect(await workspace.state()).toEqual(final);
});
