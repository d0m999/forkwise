import { test, expect } from "./writing-board-fixture";

test("工作台经真实同步完整收集同快照笔迹再一次发布，全部路径样式及单点在重载和同库服务重开保持", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const create = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await create("thought.create", { id: "protected-card", title: "笔迹保护卡", text: "完整正文保留", x: 650, y: 130 });
  await create("text.create", { id: "protected-text", content: {
    runs: [{ text: "笔迹保护文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 650, y: 420, width: 190, height: 27 } });
  await create("shape.create", { id: "protected-shape", content: {
    shapeType: "diamond", shortText: "笔迹保护形状", fill: "#dce8dd", stroke: "#403b36", strokeWidth: 2,
  }, pose: { x: 280, y: 180, width: 180, height: 100 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload();
  expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const baseline = await workspace.state() as any;
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(baseline.project.revision));
  const beforeSnapshot = await page.locator(".workspace").getAttribute("data-snapshot");
  const fixtures = [
    { id: "stroke-pen", content: { penKind: "pen", path: Array.from({ length: 4097 }, (_, index) => ({ x: 1 + index / 32, y: 1 + index % 12 })),
      color: "#123456", width: 2, opacity: 1 }, pose: { x: -100.5, y: 240.25, width: 130, height: 14 } },
    { id: "stroke-highlighter", content: { penKind: "highlighter", path: [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 75, y: 25 }],
      color: "#ffe08a", width: 10, opacity: 0.45 }, pose: { x: 100, y: 380, width: 80, height: 30 } },
    { id: "stroke-dot", content: { penKind: "pen", path: [{ x: 3, y: 3 }], color: "#923456", width: 6, opacity: 0.8 },
      pose: { x: 550, y: 410, width: 6, height: 6 } },
  ];
  let expected: any, observed: any, held: any;
  const maps: { query: URLSearchParams; body: any }[] = [];
  let releaseSeed!: () => void, releaseDetail!: () => void;
  const seeded = new Promise<void>(resolve => { releaseSeed = resolve; });
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  await page.route(/\/api\/mapping\/projects\/[^/]+\/changes\?/, async route => {
    await seeded;
    const response = await route.fetch();
    const body = await response.json();
    if (body.revision === expected.project.revision) observed = body;
    await route.fulfill({ response });
  });
  await page.route(/\/api\/mapping\/projects\/[^/]+\/map\?/, async route => {
    const query = new URL(route.request().url()).searchParams;
    const response = await route.fetch();
    const body = await response.json();
    maps.push({ query, body });
    if (query.get("view") === "stroke-detail" && query.get("strokeId") === "stroke-pen" && !query.has("cursor")) {
      held = body;
      await detailGate;
    }
    await route.fulfill({ response });
  });
  try {
    for (const fixture of fixtures) await create("stroke.create", fixture);
    expected = await workspace.state();
    for (const key of ["cards", "texts", "shapes", "tags"]) expect(expected[key]).toEqual(baseline[key]);
    releaseSeed();
    await expect.poll(async () => Boolean(held) || await page.locator(".workspace").getAttribute("data-revision") === String(expected.project.revision)).toBe(true);
    expect(observed, "必须通过真实变化读取取得新地图的固定终点").toBeDefined();
    expect(held, "读取完整 Stroke 详情前不能发布省略笔迹的地图").toBeDefined();
    expect(held.snapshot).toBe(observed.snapshot);
    expect(held.revision).toBe(expected.project.revision);
    await expect(page.locator(".workspace")).toHaveAttribute("data-snapshot", beforeSnapshot!);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(baseline.project.revision));
    await expect(page.locator(".react-flow__node-canvasStroke")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "笔迹保护卡", exact: true })).toBeVisible();
    await expect(page.locator(".canvas-text-content")).toHaveText("笔迹保护文字");
    await expect(page.getByRole("img", { name: "笔迹保护形状", exact: true })).toBeVisible();
    releaseDetail();
    await expect(page.locator(".react-flow__node-canvasStroke")).toHaveCount(3);
    await expect(page.locator(".workspace")).toHaveAttribute("data-snapshot", observed.snapshot);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(expected.project.revision));
    const indexPages = maps.filter(record => record.query.get("view") === "stroke-index").map(record => record.body);
    expect(indexPages).toHaveLength(1);
    expect(indexPages[0].items).toHaveLength(3);
    const checkPage = (body: any) => {
      expect(body.snapshot).toBe(observed.snapshot);
      expect(body.revision).toBe(expected.project.revision);
      expect(body.budgetUnit).toBe("utf8_bytes");
      expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(body.bytes);
      expect(body.bytes).toBeLessThanOrEqual(131072);
    };
    checkPage(indexPages[0]);
    for (const stroke of expected.strokes) {
      const index = indexPages[0].items.find((value: any) => value.id === stroke.id);
      expect(index).toMatchObject({ type: "stroke", id: stroke.id, versionId: stroke.versionId, item: stroke.item,
        content: { penKind: stroke.content.penKind, color: stroke.content.color, width: stroke.content.width,
          opacity: stroke.content.opacity, pointCount: stroke.content.path.length, availability: "not_fetched" } });
      const pages = maps.filter(record => record.query.get("view") === "stroke-detail" && record.query.get("strokeId") === stroke.id)
        .map(record => record.body).sort((a, b) => a.coverage.start - b.coverage.start);
      expect(pages.length).toBeGreaterThan(0);
      const chunks: any[] = [];
      for (const body of pages) {
        checkPage(body);
        expect(body.target).toEqual({ strokeId: stroke.id, versionId: stroke.versionId });
        expect(body.coverage).toEqual({ start: chunks.length, end: chunks.length + body.items.length, complete: body.nextCursor === null });
        for (const chunk of body.items) {
          expect(chunk).toMatchObject({ id: stroke.id, chunkIndex: chunks.length, chunkCount: body.totalItems });
          chunks.push(chunk);
        }
      }
      expect(chunks).toHaveLength(pages[0].totalItems);
      expect(JSON.parse(chunks.map(value => value.jsonText).join(""))).toEqual({ id: stroke.id, versionId: stroke.versionId, content: stroke.content });
      if (stroke.id === "stroke-pen") expect(pages.length).toBeGreaterThan(1);
    }
    await page.unrouteAll({ behavior: "wait" });
    const assertRendered = async () => {
      await expect(page.locator(".react-flow__node-canvasStroke")).toHaveCount(3);
      for (const stroke of expected.strokes) {
        const node = page.locator(`.react-flow__node-canvasStroke[data-id="${stroke.item.id}"]`);
        await expect(node).toBeVisible();
        await expect(node).not.toHaveClass(/draggable/);
        const rendered = await node.evaluate(element => {
          const svg = element.querySelector("svg")!;
          const graphic = svg.querySelector("path,circle")!;
          const matrix = new DOMMatrix(getComputedStyle(element).transform);
          const viewport = new DOMMatrix(getComputedStyle(element.closest(".react-flow__viewport")!).transform);
          const box = element.getBoundingClientRect();
          const screen = svg.getScreenCTM()!;
          const local = graphic.tagName === "circle"
            ? [{ x: Number(graphic.getAttribute("cx")), y: Number(graphic.getAttribute("cy")) }]
            : [...graphic.getAttribute("d")!.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
          const world = local.map(point => {
            const visible = new DOMPoint(point.x, point.y).matrixTransform(screen);
            return { x: matrix.e + (visible.x - box.left) / viewport.a, y: matrix.f + (visible.y - box.top) / viewport.d };
          });
          const style = getComputedStyle(graphic);
          return { pose: { x: matrix.e, y: matrix.f, width: box.width / viewport.a, height: box.height / viewport.d }, local, world,
            tag: graphic.tagName, color: graphic.getAttribute(graphic.tagName === "circle" ? "fill" : "stroke"),
            width: graphic.tagName === "circle" ? Number(graphic.getAttribute("r")) * 2 : Number.parseFloat(style.strokeWidth),
            opacity: Number(style.opacity), svgOpacity: Number(getComputedStyle(svg).opacity),
            visibleBox: { width: graphic.getBoundingClientRect().width, height: graphic.getBoundingClientRect().height } };
        });
        for (const field of ["x", "y", "width", "height"] as const) expect(rendered.pose[field]).toBeCloseTo(stroke.item.pose[field], 4);
        expect(rendered.local).toEqual(stroke.content.path);
        for (const [index, point] of rendered.world.entries()) {
          expect(point.x).toBeCloseTo(stroke.item.pose.x + stroke.content.path[index].x, 4);
          expect(point.y).toBeCloseTo(stroke.item.pose.y + stroke.content.path[index].y, 4);
        }
        expect(rendered.color).toBe(stroke.content.color);
        expect(rendered.width).toBe(stroke.content.width);
        expect(rendered.opacity).toBe(stroke.content.opacity);
        expect(rendered.svgOpacity).toBe(1);
        if (stroke.content.path.length === 1) {
          expect(rendered.tag).toBe("circle");
          expect(rendered.visibleBox.width).toBeGreaterThan(0);
          expect(rendered.visibleBox.height).toBeGreaterThan(0);
        } else expect(rendered.tag).toBe("path");
      }
      await expect(page.getByRole("button", { name: "笔迹保护卡", exact: true })).toBeVisible();
      await expect(page.locator(".canvas-text-content")).toHaveText("笔迹保护文字");
      await expect(page.getByRole("img", { name: "笔迹保护形状", exact: true })).toBeVisible();
      expect(await workspace.state()).toEqual(expected);
    };
    await assertRendered();
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await assertRendered();
    await workspace.restart();
    await workspace.open(page);
    await assertRendered();
  } finally {
    releaseSeed();
    releaseDetail();
    await page.unrouteAll({ behavior: "wait" });
  }
});
