import { test, expect } from "./writing-board-fixture";

test("形状工具以五个预设点击创建真实几何，一次撤销重做保持身份和保护对象，服务重开后仍可见", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保留正文", x: 930, y: 90 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 930, y: 410, width: 190, height: 27 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload();
  expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const protectedState = await workspace.state() as any;
  const presets = [
    { type: "rectangle", label: "矩形", x: 160, y: 170 },
    { type: "roundedRectangle", label: "圆角矩形", x: 410, y: 170 },
    { type: "ellipse", label: "椭圆", x: 660, y: 170 },
    { type: "diamond", label: "菱形", x: 160, y: 390 },
    { type: "triangle", label: "三角形", x: 410, y: 390 },
  ];
  for (const [index, preset] of presets.entries()) {
    const prior = (await workspace.state() as any).shapes;
    const tools = page.getByRole("button", { name: "形状", exact: true });
    expect(await tools.count(), "工作台应提供可打开五预设的形状工具").toBe(1);
    await tools.click();
    await page.getByRole("menuitem", { name: preset.label, exact: true }).click();
    const pane = page.locator(".react-flow__pane");
    const viewport = await page.locator(".react-flow__viewport").evaluate(element => {
      const value = new DOMMatrix(getComputedStyle(element).transform);
      return { x: value.e, y: value.f, zoom: value.a };
    });
    const expectedPoint = { x: (preset.x - viewport.x) / viewport.zoom, y: (preset.y - viewport.y) / viewport.zoom };
    await pane.click({ position: { x: preset.x, y: preset.y } });
    await expect.poll(async () => (await workspace.state() as any).shapes.length).toBe(index + 1);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const current = await workspace.state() as any;
    const created = current.shapes.find((shape: any) => shape.content.shapeType === preset.type);
    expect(created).toBeDefined();
    expect(created.id).toEqual(expect.any(String));
    expect(created.item.id).toEqual(expect.any(String));
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.item.id.length).toBeGreaterThan(0);
    expect(created.content).toMatchObject({ shapeType: preset.type, shortText: "" });
    expect(created.item.pose.x).toBeCloseTo(expectedPoint.x, 5);
    expect(created.item.pose.y).toBeCloseTo(expectedPoint.y, 5);
    expect(created.item.pose.width).toBeGreaterThan(0);
    expect(created.item.pose.height).toBeGreaterThan(0);
    const visual = page.getByRole("img", { name: preset.label, exact: true });
    await expect(visual).toBeVisible();
    const node = page.locator('.react-flow__node[data-id="' + created.item.id + '"]');
    const geometry = await node.evaluate(element => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      const scale = new DOMMatrix(getComputedStyle(element.closest(".react-flow__viewport")!).transform).a;
      const box = element.getBoundingClientRect();
      return { x: matrix.e, y: matrix.f, width: box.width / scale, height: box.height / scale };
    });
    expect(geometry).toEqual(created.item.pose);
    if (preset.type === "rectangle") await expect(visual).toHaveCSS("border-radius", "0px");
    if (preset.type === "roundedRectangle") expect(parseFloat(await visual.evaluate(element => getComputedStyle(element).borderRadius))).toBeGreaterThan(0);
    if (preset.type === "ellipse") await expect(visual).toHaveCSS("border-radius", "50%");
    if (preset.type === "diamond" || preset.type === "triangle") {
      const coverage = await visual.locator("svg").evaluate(element => {
        const svg = element as SVGSVGElement, bounds = svg.viewBox.baseVal;
        const contour = svg.querySelector("polygon")!;
        return [[0.5, 0.1], [0.1, 0.5], [0.9, 0.9]].map(([x, y]) =>
          contour.isPointInFill(new DOMPoint(bounds.x + x * bounds.width, bounds.y + y * bounds.height)));
      });
      expect(coverage).toEqual(preset.type === "diamond" ? [true, true, false] : [true, false, true]);
    }
    await expect(page.getByRole("button", { name: "选择", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(current.cards).toEqual(protectedState.cards);
    expect(current.texts).toEqual(protectedState.texts);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes).toEqual(prior);
    await expect(visual).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(visual).toBeVisible();
    const restored = await workspace.state() as any;
    const same = restored.shapes.find((shape: any) => shape.id === created.id);
    expect(same).toMatchObject({ id: created.id, content: created.content, item: { id: created.item.id, pose: created.item.pose } });
    expect(same.versionId).not.toBe(created.versionId);
    expect(same.item.versionId).not.toBe(created.item.versionId);
    expect(restored.cards).toEqual(protectedState.cards);
    expect(restored.texts).toEqual(protectedState.texts);
  }
  const saved = await workspace.state() as any;
  expect(new Set(saved.shapes.map((shape: any) => shape.id)).size).toBe(5);
  expect(new Set(saved.shapes.map((shape: any) => shape.item.id)).size).toBe(5);
  await workspace.restart();
  await page.reload();
  for (const preset of presets) await expect(page.getByRole("img", { name: preset.label, exact: true })).toBeVisible();
  const reopened = await workspace.state() as any;
  expect(reopened.shapes).toEqual(saved.shapes);
  expect(reopened.cards).toEqual(protectedState.cards);
  expect(reopened.texts).toEqual(protectedState.texts);
});
