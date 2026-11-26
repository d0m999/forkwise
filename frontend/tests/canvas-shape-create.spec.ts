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
    await expect(node).toHaveClass(/\bselected\b/);
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

test("放置回执在途时退出预设再点选卡片，回执只保存旧形状", async ({ page, workspace }) => {
  const { project } = await workspace.state();
  await workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: project.id, type: "thought.create", expected: null,
    payload: { id: "new-intent-card", title: "后来选中的卡片", text: "", x: 220, y: 130 },
  });
  await page.reload();
  const card = page.locator(".react-flow__node-thought");
  await expect(card).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");

  let received = false, release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/mapping/execute", async route => {
    if (route.request().postDataJSON()?.type !== "shape.create") return route.continue();
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    received = true;
    await response;
    await route.fulfill({ response: committed });
  });
  const draw = page.getByRole("button", { name: "形状", exact: true });
  const select = page.getByRole("button", { name: "选择", exact: true });
  try {
    await draw.click();
    await page.getByRole("menuitem", { name: "矩形", exact: true }).press("Enter");
    await expect(draw).toBeFocused();
    await page.locator(".react-flow__pane").click({ position: { x: 660, y: 380 } });
    await expect.poll(() => received).toBe(true);
    await select.click();
    await card.click();
    await expect(card).toHaveClass(/\bselected\b/);
    release();
    await expect(page.getByRole("img", { name: "矩形", exact: true })).toBeVisible();
    await expect(card).toHaveClass(/\bselected\b/);
    await expect(page.locator(".react-flow__node-canvasShape")).not.toHaveClass(/\bselected\b/);
    await expect(select).toHaveAttribute("aria-pressed", "true");
  } finally { release(); }
});

for (const leave of [false, true]) {
  test(`形状提交丢ACK后同命令确认，${leave ? "保留后来切换的移动工具" : "原放置仍拥有选择"}`, async ({ page, workspace }) => {
    const attempts: string[] = [];
    await page.route("**/api/mapping/execute", async route => {
      const command = route.request().postDataJSON();
      if (command?.type !== "shape.create") return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      attempts.push(command.commandId);
      if (attempts.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    const tool = (name: string) => page.getByRole("button", { name, exact: true });
    await tool("形状").click();
    await page.getByRole("menuitem", { name: "矩形", exact: true }).click();
    await page.locator(".react-flow__pane").click({ position: { x: 280, y: 360 } });
    await expect(tool("重试保存")).toBeEnabled();
    const created = (await workspace.state()).shapes;
    expect(created).toHaveLength(1);
    if (leave) await tool("移动").click();
    await tool("重试保存").click();
    await expect(page.getByRole("img", { name: "矩形", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    expect((await workspace.state()).shapes).toEqual(created);
    const node = page.locator(".react-flow__node-canvasShape");
    if (leave) {
      await expect(tool("移动")).toHaveAttribute("aria-pressed", "true");
      await expect(node).not.toHaveClass(/\bselected\b/);
    } else {
      await expect(tool("选择")).toHaveAttribute("aria-pressed", "true");
      await expect(node).toHaveClass(/\bselected\b/);
    }
  });
}

for (const flow of ["before", "after", "retry", "retry-edit", "retry-title"] as const) {
  const switchFirst = flow !== "before", retryOldProject = flow.startsWith("retry");
  const expected = { before: "旧放置在发出前让位", after: "已发送的旧项目回执不反切",
    retry: "旧项目丢ACK后显式重试只结清自己的状态", "retry-edit": "旧项目丢ACK后真实点击重试保留新项目的文字编辑",
    "retry-title": "旧项目丢ACK后普通重试只处理新项目卡片标题" }[flow];
  test(`项目切换与形状共享文字保存时，${expected}`, async ({ page, workspace }) => {
    const { project: source } = await workspace.state(), destinationId = crypto.randomUUID();
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: destinationId,
      type: "project.create", expected: null, payload: { name: "切换目标项目" } });
    if (retryOldProject) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      type: "project.create", expected: null, payload: { name: "后续普通切换项目" } });
    if (flow === "retry-title") await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: destinationId,
      type: "thought.create", expected: null, payload: { id: "new-project-title", title: "新项目原卡片", text: "", x: 110, y: 115 } });
    await page.reload();
    const destinationTab = page.getByRole("tab", { name: "切换目标项目", exact: true });
    const tool = (name: string) => page.getByRole("button", { name, exact: true });
    const canvas = page.locator(".react-flow__pane");
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("title", source.id);
    await tool("文字").click(); await canvas.click({ position: { x: 275, y: 230 } });
    const editor = page.getByRole("textbox", { name: "独立文字", exact: true });
    await expect(editor).toBeFocused();

    let releaseText!: () => void, releaseDestination!: () => void, releaseShape!: () => void;
    const textGate = new Promise<void>(resolve => { releaseText = resolve; });
    const destinationGate = new Promise<void>(resolve => { releaseDestination = resolve; });
    const shapeGate = new Promise<void>(resolve => { releaseShape = resolve; });
    let textSent = false, destinationRead = false;
    const shapeCommands: string[] = [], destinationTextEdits: string[] = [], destinationTitles: string[] = [];
    await page.route("**/api/mapping/execute", async route => {
      const command = route.request().postDataJSON(), type = command?.type;
      if (type === "thought.title" && command.projectId === destinationId) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        destinationTitles.push(command.commandId);
        if (destinationTitles.length === 1) return route.abort("failed");
        return route.fulfill({ response });
      }
      if (type === "text.edit" && command.projectId === destinationId) {
        destinationTextEdits.push(command.commandId);
        return route.continue();
      }
      if (type !== "text.edit" && type !== "shape.create") return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      if (type === "text.edit") { textSent = true; await textGate; }
      else {
        shapeCommands.push(route.request().postDataJSON().commandId);
        if (shapeCommands.length === 1) {
          await shapeGate;
          if (retryOldProject) return route.abort("failed");
        }
      }
      await route.fulfill({ response });
    });
    await page.route(url => url.pathname === `/api/mapping/projects/${destinationId}/map` && url.searchParams.get("view") === "index", async route => {
      destinationRead = true;
      await destinationGate;
      await route.continue();
    });
    const placeShape = async () => {
      await tool("形状").click();
      await page.getByRole("menuitem", { name: "矩形", exact: true }).click();
      await canvas.click({ position: { x: 565, y: 385 } });
    };
    try {
      await editor.fill("共享保存门");
      if (switchFirst) await destinationTab.click(); else await placeShape();
      await expect.poll(() => textSent).toBe(true);
      if (switchFirst) await placeShape(); else await destinationTab.click();
      releaseText();
      await expect.poll(() => destinationRead).toBe(true);
      if (switchFirst) await expect.poll(() => shapeCommands.length).toBe(1);
      releaseDestination();
      await expect(destinationTab).toHaveAttribute("aria-selected", "true");
      if (retryOldProject) {
        const retry = tool("重试上一项目保存");
        releaseShape();
        await expect(retry).toBeEnabled();
        await page.getByRole("tab", { name: "后续普通切换项目", exact: true }).click();
        await expect(destinationTab).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
        if (flow === "retry") {
          await placeShape();
          await expect(page.getByRole("status")).toHaveText("已保存到本机", { timeout: 3500 });
          await expect(page.locator(".react-flow__node-canvasShape")).toHaveCount(0);
          expect(shapeCommands).toHaveLength(1);
        }
        await expect(retry).toBeEnabled();
        if (flow === "retry-title") {
          await tool("新项目原卡片").dblclick();
          const title = page.getByRole("textbox", { name: "卡片标题", exact: true });
          await title.fill("新项目标题已经改变");
          await title.press("Enter");
          const retryTitle = tool("重试保存");
          await expect(retryTitle).toBeEnabled();
          await expect(retry).toBeEnabled();
          await retryTitle.click();
          await expect(retryTitle).toHaveCount(0, { timeout: 3500 });
          expect(shapeCommands).toHaveLength(1);
          expect(destinationTitles).toEqual([destinationTitles[0], destinationTitles[0]]);
          await expect(retry).toBeEnabled();
          const saved = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${destinationId}`)).json();
          expect(saved.cards[0].title).toBe("新项目标题已经改变");
          await expect(page.getByRole("status")).toHaveText("已保存到本机");
        }
        await tool("文字").click();
        await expect(tool("文字")).toHaveAttribute("aria-pressed", "true");
        let draftStatus = "";
        if (flow === "retry-edit") {
          await canvas.click({ position: { x: 350, y: 270 } });
          await expect(editor).toBeFocused();
          const now = Date.now();
          await page.clock.install({ time: now });
          await page.clock.pauseAt(now + 200);
          await editor.fill("新项目仍在编辑自己的草稿");
          draftStatus = await page.getByRole("status").innerText();
        }
        await retry.click();
        await expect.poll(() => shapeCommands.length).toBe(2);
        expect(shapeCommands[1]).toBe(shapeCommands[0]);
        await expect(retry).toHaveCount(0, { timeout: 3500 });
        if (flow === "retry-edit") {
          await expect(editor).toBeFocused({ timeout: 3500 });
          await expect(editor).toHaveText("新项目仍在编辑自己的草稿");
          expect(destinationTextEdits).toEqual([]);
          await expect(page.getByRole("status")).toHaveText(draftStatus);
          await editor.press("Escape");
          await expect(page.locator(".canvas-text-content")).toHaveText("新项目仍在编辑自己的草稿");
          expect(destinationTextEdits).toHaveLength(1);
          const saved = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${destinationId}`)).json();
          expect(saved.texts[0].content.runs).toEqual([{ text: "新项目仍在编辑自己的草稿" }]);
        } else await expect(tool("文字")).toHaveAttribute("aria-pressed", "true");
        await expect(tool("导出")).toBeEnabled();
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
      } else if (switchFirst) {
        const ack = page.waitForResponse(response => response.request().postDataJSON()?.type === "shape.create");
        releaseShape();
        expect((await ack).ok()).toBe(true);
        await expect(tool("形状")).toBeEnabled();
      }
      await expect(destinationTab).toHaveAttribute("aria-selected", "true");
      expect(new URL(page.url()).searchParams.get("project")).toBe(destinationId);
      await expect(page.locator(".react-flow__node-canvasShape")).toHaveCount(0);
      const oldProject = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${source.id}`)).json();
      expect(oldProject.shapes ?? []).toHaveLength(switchFirst ? 1 : 0);
      expect(shapeCommands).toHaveLength(retryOldProject ? 2 : switchFirst ? 1 : 0);
      if (retryOldProject) {
        await placeShape();
        await expect(page.locator(".react-flow__node-canvasShape")).toHaveClass(/\bselected\b/);
        await expect.poll(() => shapeCommands.length).toBe(3);
        expect(shapeCommands[2]).not.toBe(shapeCommands[0]);
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
        const next = page.getByRole("tab", { name: "后续普通切换项目", exact: true });
        await next.click();
        await expect(next).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("status")).toHaveText("已保存到本机");
      }
    } finally { releaseText(); releaseDestination(); releaseShape(); }
  });
}
