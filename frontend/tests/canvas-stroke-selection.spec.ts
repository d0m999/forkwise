import { test, expect } from "./writing-board-fixture";

test("两种细笔迹可实际命中和键盘选择，单笔删除可撤销重做且混选不部分删除或移动", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const seed = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await seed("thought.create", { id: "protected-card", title: "选择保护卡", text: "完整保护正文", x: 820, y: 110 });
  await seed("text.create", { id: "protected-text", content: {
    runs: [{ text: "选择保护文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 820, y: 430, width: 190, height: 27 } });
  await seed("shape.create", { id: "protected-shape", content: {
    shapeType: "diamond", shortText: "选择保护形状", fill: "#dce8dd", stroke: "#403b36", strokeWidth: 2,
  }, pose: { x: 600, y: 300, width: 150, height: 90 } });
  const fixtures = [
    { id: "thin-pen", label: "普通笔笔迹", content: { penKind: "pen", color: "#403b36", width: 1, opacity: 1,
      path: [{ x: 1, y: 1 }, { x: 181, y: 1 }] }, pose: { x: 180, y: 210, width: 182, height: 2 } },
    { id: "thin-highlighter", label: "荧光笔笔迹", content: { penKind: "highlighter", color: "#f4e9b9", width: 1, opacity: 0.4,
      path: [{ x: 1, y: 1 }, { x: 181, y: 1 }] }, pose: { x: 180, y: 360, width: 182, height: 2 } },
  ];
  for (const { label: _label, ...value } of fixtures) await seed("stroke.create", value);
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  let baseline = await workspace.state() as any;
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(baseline.project.revision));
  await page.locator("button.react-flow__controls-zoomout").click();
  await expect.poll(() => page.locator(".react-flow__viewport").evaluate(element =>
    new DOMMatrix(getComputedStyle(element).transform).a)).not.toBe(1);
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  let initialHistory = await history();
  const writes: any[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/mapping/execute") && request.method() === "POST") writes.push(request.postDataJSON());
  });
  const control = (label: string) => page.getByRole("button", { name: "选择" + label, exact: true });
  const point = (label: string) => page.getByRole("img", { name: label, exact: true }).evaluate(element => {
    const screen = new DOMPoint(91, 1).matrixTransform((element as SVGSVGElement).getScreenCTM()!);
    return { x: screen.x, y: screen.y + 3 };
  });
  const hit = async (label: string) => {
    const target = await point(label); await page.mouse.click(target.x, target.y);
    expect(await control(label).count(), "笔迹必须提供可访问的选择入口").toBe(1);
    await expect(control(label), "细线外三个 CSS 像素仍应实际命中").toHaveAttribute("aria-pressed", "true");
    await expect(control(label)).toHaveCSS("outline-style", "solid");
    await expect(control(label)).toHaveCSS("outline-width", "2px");
    await expect(page.getByRole("button", { name: "删除笔迹", exact: true })).toBeVisible();
  };
  for (const fixture of fixtures) {
    await hit(fixture.label);
    await page.keyboard.press("ArrowRight");
    const start = await point(fixture.label);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 50, start.y + 30, { steps: 4 }); await page.mouse.up();
    await expect(page.getByRole("button", { name: /^调整笔迹尺寸/ })).toHaveCount(0);
    expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(initialHistory); expect(writes).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(initialHistory); expect(writes).toHaveLength(0);
  }
  await hit(fixtures[0].label);
  const outsideStart = await point(fixtures[0].label);
  const toolbar = (await page.getByRole('button', { name: '新建研究', exact: true }).boundingBox())!;
  await page.mouse.move(outsideStart.x, outsideStart.y); await page.mouse.down();
  await page.mouse.move(toolbar.x + toolbar.width / 2, toolbar.y + toolbar.height / 2, { steps: 4 }); await page.mouse.up();
  expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(initialHistory); expect(writes).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node.selected'), '画布外同窗口松开后Esc仍清理普通选择').toHaveCount(0);
  expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(initialHistory); expect(writes).toHaveLength(0);
  await hit(fixtures[0].label);
  await page.getByRole("button", { name: "选择保护卡", exact: true }).click({ modifiers: ["Shift"] });
  await expect(control(fixtures[0].label)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "删除笔迹", exact: true })).toHaveCount(0);
  const cardMove = page.getByRole("button", { name: "移动卡片：方向键调整位置", exact: true });
  await expect(cardMove).toBeDisabled();
  const cardBox = (await cardMove.boundingBox())!;
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2); await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 60, cardBox.y + cardBox.height / 2 + 40, { steps: 4 }); await page.mouse.up();
  expect(await workspace.state()).toEqual(baseline); expect(await history()).toEqual(initialHistory); expect(writes).toHaveLength(0);
  await control(fixtures[0].label).focus(); await page.keyboard.press('Delete');
  await expect.poll(() => writes.filter(command => command.type === 'canvas.delete-selection').length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const atomic = writes.filter(command => command.type === 'canvas.delete-selection')[0];
  const stroke = baseline.strokes.find((value: any) => value.id === fixtures[0].id), card = baseline.cards[0];
  expect(atomic.payload.groupIds).toEqual([]); expect(atomic.payload.directItemIds).toHaveLength(2);
  expect(atomic.payload.directItemIds).toEqual(expect.arrayContaining([stroke.item.id, card.item.id]));
  expect(Object.keys(atomic.expected.items).sort()).toEqual([stroke.item.id, card.item.id].sort());
  expect(writes).toHaveLength(1);
  const atomicDeleted = await workspace.state() as any;
  expect(atomicDeleted).toEqual({ ...baseline, project: { ...baseline.project, revision: baseline.project.revision + 1 },
    cards: [], strokes: baseline.strokes.filter((value: any) => value.id !== stroke.id) });
  const atomicHistory = await history(); expect(atomicHistory.undo).toHaveLength(initialHistory.undo.length + 1);
  expect(atomicHistory.undo.at(-1).label).toBe('canvas.delete-selection');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('img', { name: fixtures[0].label, exact: true })).toBeVisible();
  const atomicRestored = await workspace.state() as any;
  expect(atomicRestored.cards).toHaveLength(1); expect(atomicRestored.cards[0]).toMatchObject({ id: card.id, title: card.title,
    body: { id: card.body.id, blocks: card.body.blocks }, item: { id: card.item.id, pose: card.item.pose } });
  expect(atomicRestored.strokes).toHaveLength(2);
  expect(atomicRestored.strokes.find((value: any) => value.id === stroke.id)).toMatchObject({ id: stroke.id,
    content: stroke.content, item: { id: stroke.item.id, createdOrder: stroke.item.createdOrder, pose: stroke.item.pose } });
  expect(atomicRestored.strokes.find((value: any) => value.id !== stroke.id)).toEqual(baseline.strokes.find((value: any) => value.id !== stroke.id));
  for (const key of ['texts', 'shapes', 'images', 'tags', 'groups', 'containment', 'connectors']) expect(atomicRestored[key]).toEqual(baseline[key]);
  expect(atomicRestored.project.revision).toBe(atomicDeleted.project.revision + 1);
  baseline = atomicRestored; initialHistory = await history();
  const singleDeleteWritesStart = writes.length;
  await page.locator(".react-flow__pane").click({ position: { x: 80, y: 100 } });
  for (const [index, fixture] of fixtures.entries()) {
    if (index === 0) await hit(fixture.label);
    else {
      let reached = false;
      for (let step = 0; step < 60; step++) {
        await page.keyboard.press("Tab");
        if (await control(fixture.label).evaluate(element => document.activeElement === element)) { reached = true; break; }
      }
      expect(reached, "荧光笔必须能通过真实 Tab 到达").toBe(true);
      await page.keyboard.press("Enter");
      await expect(control(fixture.label)).toHaveAttribute("aria-pressed", "true");
      await expect(control(fixture.label)).toHaveCSS("outline-width", "2px");
    }
    const before = await workspace.state() as any, beforeHistory = await history();
    const target = before.strokes.find((value: any) => value.id === fixture.id);
    const beforeDeletes = writes.filter(command => command.type === "stroke.delete").length;
    if (index === 0) await page.keyboard.press("Delete");
    else await page.getByRole("button", { name: "删除笔迹", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).strokes.some((value: any) => value.id === fixture.id)).toBe(false);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const deleted = await workspace.state() as any, deletes = writes.filter(command => command.type === "stroke.delete");
    expect(deletes).toHaveLength(beforeDeletes + 1);
    expect(deletes.at(-1)).toMatchObject({ projectId, expected: { stroke: target.versionId, pose: target.item.versionId }, payload: { id: target.id } });
    expect(deleted.strokes).toEqual(before.strokes.filter((value: any) => value.id !== fixture.id));
    expect((await history()).undo).toHaveLength(beforeHistory.undo.length + 1);
    for (const key of ["cards", "texts", "shapes", "tags"]) expect(deleted[key]).toEqual(baseline[key]);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.getByRole("img", { name: fixture.label, exact: true })).toBeVisible();
    const restored = (await workspace.state() as any).strokes.find((value: any) => value.id === fixture.id);
    expect(restored).toMatchObject({ id: target.id, content: target.content, item: { id: target.item.id, createdOrder: target.item.createdOrder, pose: target.item.pose } });
    expect(restored.versionId).not.toBe(target.versionId); expect(restored.item.versionId).not.toBe(target.item.versionId);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(page.getByRole("img", { name: fixture.label, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.getByRole("img", { name: fixture.label, exact: true })).toBeVisible();
    const final = (await workspace.state() as any).strokes.find((value: any) => value.id === fixture.id);
    expect(final).toMatchObject({ id: target.id, content: target.content, item: { id: target.item.id, createdOrder: target.item.createdOrder, pose: target.item.pose } });
    expect(final.versionId).not.toBe(restored.versionId); expect(final.item.versionId).not.toBe(restored.item.versionId);
  }
  const saved = await workspace.state() as any; expect(saved.strokes).toHaveLength(2);
  expect(writes.slice(singleDeleteWritesStart).filter(command => command.type !== "stroke.delete" && command.type !== "history.undo" && command.type !== "history.redo")).toHaveLength(0);
  await page.reload();
  for (const fixture of fixtures) await expect(page.getByRole("img", { name: fixture.label, exact: true })).toBeVisible();
  expect(await workspace.state()).toEqual(saved);
  for (const key of ["cards", "texts", "shapes", "tags"]) expect(saved[key]).toEqual(baseline[key]);
});
