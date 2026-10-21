import { test, expect } from "./writing-board-fixture";

test("真实重开工作台完整收集同快照 Shape 详情后才发布保护卡片文字及只读矩形", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保留正文", x: 650, y: 130 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 650, y: 420, width: 190, height: 27 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload();
  expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const content = { shapeType: "rectangle", shortText: "矩形条件🧠", fill: "#fef3c7", stroke: "#92400e", strokeWidth: 2 };
  const pose = { x: 280, y: 180, width: 220, height: 110 };
  await execute("shape.create", { id: "shape-rectangle", content, pose });
  const original = await workspace.state() as any;
  let root: any, detail: any;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/mapping\/projects\/[^/]+\/map\?/, async route => {
    const view = new URL(route.request().url()).searchParams.get("view");
    const response = await route.fetch();
    if (view === "index") root = await response.json();
    if (view === "shape-detail") {
      detail = await response.json();
      await gate;
    }
    await route.fulfill({ response });
  });
  try {
    await page.reload();
    await expect.poll(async () => Boolean(detail) || Boolean(root &&
      await page.locator(".workspace").getAttribute("data-snapshot") === root.snapshot)).toBe(true);
    expect(detail, "工作台不得在未读取 Shape 详情时发布缺失对象的投影").toBeDefined();
    expect(detail.snapshot).toBe(root.snapshot);
    expect(detail.revision).toBe(root.revision);
    expect(JSON.parse(detail.items.map((item: any) => item.jsonText).join(""))).toEqual({
      id: "shape-rectangle", versionId: original.shapes[0].versionId, content,
    });
    await expect(page.locator(".react-flow__node-thought")).toHaveCount(0);
    await expect(page.locator(".canvas-text-content")).toHaveCount(0);
    await expect(page.getByRole("img", { name: content.shortText, exact: true })).toHaveCount(0);
    release();
    const rectangle = page.getByRole("img", { name: content.shortText, exact: true });
    await expect(rectangle).toBeVisible();
    await expect(rectangle).toHaveText(content.shortText);
    await expect(rectangle).toHaveCSS("background-color", "rgb(254, 243, 199)");
    await expect(rectangle).toHaveCSS("border-color", "rgb(146, 64, 14)");
    await expect(rectangle).toHaveCSS("border-width", "2px");
    const geometry = await page.locator(".react-flow__node-canvasShape").evaluate(element => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      const viewport = new DOMMatrix(getComputedStyle(element.closest(".react-flow__viewport")!).transform);
      const box = element.getBoundingClientRect();
      return { x: matrix.e, y: matrix.f, width: box.width / viewport.a, height: box.height / viewport.d };
    });
    expect(geometry).toEqual(pose);
    await expect(page.getByRole("button", { name: "保护卡片", exact: true })).toBeVisible();
    await expect(page.locator(".canvas-text-content")).toHaveText("保护独立文字");
    await expect(page.locator(".workspace")).toHaveAttribute("data-snapshot", root.snapshot);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(root.revision));
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/map?" +
      new URLSearchParams({ view: "shape-index", snapshot: root.snapshot }));
    expect(response.status()).toBe(200);
    const index = await response.json();
    expect(index.snapshot).toBe(root.snapshot);
    expect(index.revision).toBe(root.revision);
    expect(index.items[0]).toMatchObject({ id: "shape-rectangle", versionId: original.shapes[0].versionId, item: original.shapes[0].item });
    const current = await workspace.state() as any;
    expect(current.shapes).toEqual(original.shapes);
    expect(current.cards[0].id).toBe(original.cards[0].id);
    expect(current.cards[0].body).toEqual(original.cards[0].body);
    expect(current.texts).toEqual(original.texts);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
