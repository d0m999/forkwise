import { test, expect } from "./writing-board-fixture";

test("画笔子菜单以普通笔和荧光笔采点预览，抬起各提交一笔且撤销重做和同库重开保持完整世界笔迹", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const seed = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await seed("thought.create", { id: "protected-card", title: "绘制保护卡", text: "保护完整正文", x: 850, y: 110 });
  await seed("text.create", { id: "protected-text", content: {
    runs: [{ text: "绘制保护文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 850, y: 430, width: 190, height: 27 } });
  await seed("shape.create", { id: "protected-shape", content: {
    shapeType: "diamond", shortText: "绘制保护形状", fill: "#dce8dd", stroke: "#403b36", strokeWidth: 2,
  }, pose: { x: 650, y: 290, width: 150, height: 90 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const protectedState = await workspace.state() as any;
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(protectedState.project.revision));
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const viewport = () => page.locator(".react-flow__viewport").evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  const initialView = await viewport();
  await page.locator("button.react-flow__controls-zoomout").click();
  await expect.poll(async () => (await viewport()).zoom).not.toBe(initialView.zoom);
  await page.getByRole("button", { name: "移动", exact: true }).click();
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const beforePan = await viewport();
  await page.mouse.move(pane.x + 110, pane.y + pane.height - 100); await page.mouse.down();
  await page.mouse.move(pane.x + 160, pane.y + pane.height - 65, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await viewport()).x).not.toBe(beforePan.x);
  await page.getByRole("button", { name: "选择", exact: true }).click();
  const creates: any[] = [], receipts: any[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/mapping/execute") && request.method() === "POST") {
      const command = request.postDataJSON(); if (command?.type === "stroke.create") creates.push(command);
    }
  });
  page.on("response", async response => {
    if (response.url().endsWith("/api/mapping/execute") && response.request().postDataJSON()?.type === "stroke.create") {
      receipts.push({ status: response.status(), body: await response.json() });
    }
  });
  // These are engineering initial styles, not adoption of the D405 research defaults.
  const pens = [
    { label: "普通笔", penKind: "pen", color: "#403b36", width: 2, opacity: 1, samples: [[180, 220], [205, 240], [230, 225], [260, 250]] },
    { label: "荧光笔", penKind: "highlighter", color: "#f4e9b9", width: 10, opacity: 0.4, samples: [[320, 350], [360, 355], [400, 340], [440, 365]] },
  ];
  for (const [index, pen] of pens.entries()) {
    const before = await workspace.state() as any, beforeHistory = await history();
    const brush = page.getByRole("button", { name: "画笔", exact: true });
    expect(await brush.count(), "工作台必须提供普通笔与荧光笔共用的画笔子菜单").toBe(1);
    if (index === 0) {
      await brush.focus(); await page.keyboard.press("Enter");
      await expect(page.getByRole("menu", { name: "画笔类型", exact: true })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("menuitem", { name: pen.label, exact: true })).toBeFocused();
      await page.keyboard.press("Enter"); await expect(brush).toBeFocused();
    } else {
      await brush.click(); await page.getByRole("menuitem", { name: pen.label, exact: true }).click();
    }
    await expect(brush).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("menu", { name: "画笔类型", exact: true })).toHaveCount(0);
    const geometry = await page.locator(".react-flow").evaluate(element => {
      const box = element.getBoundingClientRect();
      const renderer = element.querySelector(".react-flow__renderer")!.getBoundingClientRect();
      const viewport = element.querySelector(".react-flow__viewport")!.getBoundingClientRect();
      return { left: box.left, top: box.top, a: viewport.width / renderer.width, d: viewport.height / renderer.height,
        x: viewport.left - box.left, y: viewport.top - box.top };
    });
    expect(geometry.a).not.toBe(1);
    const screen = pen.samples.map(([x, y]) => ({ x: geometry.left + x, y: geometry.top + y }));
    const world = screen.map(point => ({ x: (point.x - geometry.left - geometry.x) / geometry.a,
      y: (point.y - geometry.top - geometry.y) / geometry.d }));
    await page.mouse.move(screen[0].x, screen[0].y); await page.mouse.down();
    for (const point of screen.slice(1)) await page.mouse.move(point.x, point.y);
    const preview = page.getByRole("img", { name: "笔迹预览", exact: true });
    await expect(preview).toBeVisible();
    const renderedPreview = await preview.evaluate(element => {
      const svg = element as SVGSVGElement, path = svg.querySelector("path")!, matrix = svg.getScreenCTM()!;
      const points = [...path.getAttribute("d")!.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/g)]
        .map(match => new DOMPoint(Number(match[1]), Number(match[2])).matrixTransform(matrix));
      return { points: points.map(point => ({ x: point.x, y: point.y })), color: path.getAttribute("stroke"),
        width: Number(path.getAttribute("stroke-width")), opacity: Number(path.getAttribute("opacity")) };
    });
    expect(renderedPreview.points).toHaveLength(4);
    for (const [pointIndex, point] of renderedPreview.points.entries()) {
      expect(point.x).toBeCloseTo(screen[pointIndex].x, 4); expect(point.y).toBeCloseTo(screen[pointIndex].y, 4);
    }
    expect(renderedPreview).toMatchObject({ color: pen.color, width: pen.width, opacity: pen.opacity });
    expect(creates).toHaveLength(index); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);
    await page.mouse.up();
    await expect.poll(async () => (await workspace.state() as any).strokes.length).toBe(index + 1);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(preview).toHaveCount(0); expect(creates).toHaveLength(index + 1);
    await expect.poll(() => receipts.length).toBe(index + 1); expect(receipts[index].status).toBe(200);
    const current = await workspace.state() as any;
    const stroke = current.strokes.find((value: any) => !before.strokes.some((old: any) => old.id === value.id));
    const command = creates[index];
    expect(command).toMatchObject({ projectId, type: "stroke.create", expected: null, payload: { id: stroke.id, content: stroke.content, pose: stroke.item.pose } });
    expect(stroke.id).toEqual(expect.any(String)); expect(stroke.item.id).toEqual(expect.any(String));
    expect(stroke.id).not.toBe(stroke.item.id); expect(stroke.versionId).not.toBe(stroke.item.versionId);
    expect(receipts[index].body.strokeVersions).toEqual({ stroke: stroke.versionId, pose: stroke.item.versionId });
    expect(stroke.content).toMatchObject({ penKind: pen.penKind, color: pen.color, width: pen.width, opacity: pen.opacity });
    expect(stroke.content.path).toHaveLength(4);
    for (const [pointIndex, point] of stroke.content.path.entries()) {
      expect(stroke.item.pose.x + point.x).toBeCloseTo(world[pointIndex].x, 4);
      expect(stroke.item.pose.y + point.y).toBeCloseTo(world[pointIndex].y, 4);
    }
    expect(stroke.item.pose.x).toBeCloseTo(Math.min(...world.map(point => point.x)) - pen.width / 2, 4);
    expect(stroke.item.pose.y).toBeCloseTo(Math.min(...world.map(point => point.y)) - pen.width / 2, 4);
    expect(stroke.item.pose.width).toBeCloseTo(Math.max(...world.map(point => point.x)) - Math.min(...world.map(point => point.x)) + pen.width, 4);
    expect(stroke.item.pose.height).toBeCloseTo(Math.max(...world.map(point => point.y)) - Math.min(...world.map(point => point.y)) + pen.width, 4);
    for (const key of ["cards", "texts", "shapes", "tags"]) expect(current[key]).toEqual(protectedState[key]);
    expect(current.strokes.filter((value: any) => value.id !== stroke.id)).toEqual(before.strokes);
    const writtenHistory = await history(); expect(writtenHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
    expect(writtenHistory.undo.at(-1)).toMatchObject({ id: command.commandId, label: "stroke.create" });
    const visual = page.locator(`.react-flow__node-canvasStroke[data-id="${stroke.item.id}"]`);
    await expect(visual).toBeVisible();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).strokes).toEqual(before.strokes);
    await expect(visual).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click(); await expect(visual).toBeVisible();
    const restored = (await workspace.state() as any).strokes.find((value: any) => value.id === stroke.id);
    expect(restored).toMatchObject({ id: stroke.id, content: stroke.content, item: { id: stroke.item.id, createdOrder: stroke.item.createdOrder, pose: stroke.item.pose } });
    expect(restored.versionId).not.toBe(stroke.versionId); expect(restored.item.versionId).not.toBe(stroke.item.versionId);
  }
  const saved = await workspace.state() as any; expect(saved.strokes).toHaveLength(2);
  expect(new Set(saved.strokes.map((value: any) => value.id)).size).toBe(2);
  expect(new Set(saved.strokes.map((value: any) => value.item.id)).size).toBe(2);
  const checkSaved = async () => {
    await expect(page.locator(".react-flow__node-canvasStroke")).toHaveCount(2);
    await expect(page.getByRole("img", { name: "普通笔笔迹", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "荧光笔笔迹", exact: true })).toBeVisible();
    expect(await workspace.state()).toEqual(saved);
    for (const key of ["cards", "texts", "shapes", "tags"]) expect(saved[key]).toEqual(protectedState[key]);
  };
  await page.reload(); await checkSaved(); await workspace.restart(); await workspace.open(page); await checkSaved();
});
