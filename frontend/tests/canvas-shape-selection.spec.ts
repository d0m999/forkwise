import { test, expect } from "./writing-board-fixture";

test("形状可指针与键盘多选，普通同步保留存活目标且切换保护文字卡片草稿，选择不写领域状态", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保留正文", x: 800, y: 90 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 410, width: 190, height: 27 } });
  for (const [id, type, x] of [["shape-a", "rectangle", 180], ["shape-b", "ellipse", 450]] as const) {
    await execute("shape.create", { id, content: { shapeType: type, shortText: id }, pose: { x, y: 180, width: 180, height: 120 } });
  }
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload();
  expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any;
  const history = async () => (await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history")).json();
  const originalHistory = await history();
  const first = original.shapes.find((shape: any) => shape.id === "shape-a");
  const second = original.shapes.find((shape: any) => shape.id === "shape-b");
  const node = (id: string) => page.locator('.react-flow__node[data-id="' + id + '"]');
  const a = page.getByRole("img", { name: "shape-a", exact: true });
  const b = page.getByRole("img", { name: "shape-b", exact: true });
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();
  const box = (await a.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(node(first.item.id), "点击已显示的形状应选中该对象").toHaveClass(/selected/);
  await b.click({ modifiers: ["Shift"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await expect(node(second.item.id)).toHaveClass(/selected/);
  await expect(page.getByLabel("写字板", { exact: true })).toHaveCount(0);
  await page.locator(".react-flow__pane").click({ position: { x: 100, y: 510 } });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  for (let index = 0; index < 60 && !(await a.evaluate(element => element === document.activeElement)); index++) await page.keyboard.press("Tab");
  await expect(a).toBeFocused();
  await a.press("Space");
  await expect(node(first.item.id)).toHaveClass(/selected/);
  for (let index = 0; index < 60 && !(await b.evaluate(element => element === document.activeElement)); index++) await page.keyboard.press("Tab");
  await expect(b).toBeFocused();
  await b.press("Shift+Enter");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await b.press("ArrowRight");
  expect(await workspace.state()).toEqual(original);
  expect(await history()).toEqual(originalHistory);
  await execute("shape.edit", { id: second.id, content: { ...second.content, shortText: "同步后的椭圆" } }, second.versionId);
  const edited = await workspace.state() as any;
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(edited.project.revision));
  await expect(page.getByRole("img", { name: "同步后的椭圆", exact: true })).toBeVisible();
  await expect(node(first.item.id)).toHaveClass(/selected/);
  await expect(node(second.item.id)).toHaveClass(/selected/);
  const target = edited.shapes.find((shape: any) => shape.id === second.id);
  await execute("shape.delete", { id: target.id }, { shape: target.versionId, pose: target.item.versionId });
  const removed = await workspace.state() as any;
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(removed.project.revision));
  await expect(node(second.item.id)).toHaveCount(0);
  await expect(node(first.item.id)).toHaveClass(/selected/);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  expect(removed.cards).toEqual(original.cards);
  expect(removed.texts).toEqual(original.texts);
  const stableHistory = await history();
  await a.click();
  expect(await workspace.state()).toEqual(removed);
  expect(await history()).toEqual(stableHistory);
  await page.locator(".canvas-text-content").dblclick();
  const textEditor = page.getByRole("textbox", { name: "独立文字", exact: true });
  await textEditor.fill("切向形状仍保留的文字");
  await a.click();
  await expect(textEditor).toHaveCount(0);
  await expect.poll(async () => (await workspace.state() as any).texts[0].content.runs.map((run: any) => run.text).join("")).toBe("切向形状仍保留的文字");
  await expect(node(first.item.id)).toHaveClass(/selected/);
  await page.getByRole("button", { name: "保护卡片", exact: true }).dblclick();
  const title = page.getByRole("textbox", { name: "卡片标题", exact: true });
  await title.fill("切向形状仍保留的标题");
  for (let index = 0; index < 60 && !(await a.evaluate(element => element === document.activeElement)); index++) await page.keyboard.press("Tab");
  await expect(a).toBeFocused();
  await a.press("Enter");
  await expect.poll(async () => (await workspace.state()).cards[0].title).toBe("切向形状仍保留的标题");
  await expect(node(first.item.id)).toHaveClass(/selected/);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const final = await workspace.state() as any;
  expect(final.shapes).toEqual(removed.shapes);
  expect(final.cards[0].body).toEqual(original.cards[0].body);
  await expect(page.getByLabel("写字板", { exact: true })).toHaveCount(0);
});
