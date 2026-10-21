import { test, expect } from "./writing-board-fixture";

test("两份外观草稿并发恢复只接管第一选择，另一原记录仍完整且可独立恢复", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保留正文", x: 900, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 900, y: 420, width: 190, height: 27 } });
  const firstContent = { shapeType: "rectangle", shortText: "第一份完整短文😀" };
  const secondContent = { shapeType: "diamond", shortText: "第二份完整短文\n保持原样", fill: "#ffffff", strokeWidth: 1 };
  await execute("shape.create", { id: "first-shape", content: firstContent, pose: { x: 230, y: 210, width: 200, height: 120 } });
  await execute("shape.create", { id: "second-shape", content: secondContent, pose: { x: 550, y: 210, width: 200, height: 120 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any;
  const first = original.shapes.find((value: any) => value.id === "first-shape");
  const second = original.shapes.find((value: any) => value.id === "second-shape");
  const dialog = page.getByRole("dialog", { name: "形状外观", exact: true });
  const fill = dialog.getByRole("textbox", { name: "填充颜色", exact: true });
  const stroke = dialog.getByRole("textbox", { name: "轮廓颜色", exact: true });
  const width = dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true });
  const restore = page.getByRole("button", { name: "恢复形状外观草稿", exact: true });
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history();
  await page.getByRole("img", { name: firstContent.shortText, exact: true }).click();
  await page.getByRole("button", { name: "形状外观", exact: true }).click();
  await fill.fill("#dbeafe"); await stroke.fill("#1d4ed8"); await width.fill("3");
  page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
  await page.reload(); await expect(restore).toHaveCount(1);
  await page.getByRole("img", { name: secondContent.shortText, exact: true }).click();
  await page.getByRole("button", { name: "形状外观", exact: true }).click();
  await fill.fill("#dcfce7"); await stroke.fill("#166534"); await width.fill("5");
  page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
  await page.reload(); await expect(restore).toHaveCount(2);
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let held = false;
  await page.route("**/api/mapping/projects/" + projectId + "/map?**", async route => {
    const url = new URL(route.request().url());
    if (!held && url.searchParams.get("view") === "index" && !url.searchParams.has("snapshot")) {
      held = true; const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await restore.nth(0).click(); await started;
    await restore.nth(1).click();
    expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
    await expect(dialog, "第一恢复授权读取未放行时，另一恢复不得抢占编辑器").toHaveCount(0);
    release(); await expect(dialog).toBeVisible();
    const drafts = [
      { value: first, fill: "#dbeafe", stroke: "#1d4ed8", width: "3", content: { ...firstContent, fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 } },
      { value: second, fill: "#dcfce7", stroke: "#166534", width: "5", content: { ...secondContent, fill: "#dcfce7", stroke: "#166534", strokeWidth: 5 } },
    ];
    const visibleFill = await fill.inputValue();
    const selected = drafts.find(draft => draft.fill === visibleFill);
    expect(selected, "恢复内容须是实际输入的一份完整草稿").toBeDefined();
    const remaining = drafts.find(draft => draft.value.id !== selected!.value.id)!;
    await expect(stroke).toHaveValue(selected!.stroke); await expect(width).toHaveValue(selected!.width);
    await dialog.getByRole("button", { name: "重试保存形状外观", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const firstSaved = await workspace.state() as any;
    expect(firstSaved.shapes.find((value: any) => value.id === selected!.value.id)).toMatchObject({ id: selected!.value.id,
      item: selected!.value.item, content: selected!.content });
    expect(firstSaved.shapes.find((value: any) => value.id === remaining.value.id)).toEqual(remaining.value);
    await expect(restore, "另一份原草稿必须仍有明确恢复入口").toHaveCount(1);
    await restore.click(); await expect(dialog).toBeVisible();
    await expect(fill).toHaveValue(remaining.fill); await expect(stroke).toHaveValue(remaining.stroke); await expect(width).toHaveValue(remaining.width);
    await dialog.getByRole("button", { name: "重试保存形状外观", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = await workspace.state() as any;
    expect(saved.shapes).toHaveLength(2);
    expect(saved.shapes.find((value: any) => value.id === selected!.value.id)).toEqual(firstSaved.shapes.find((value: any) => value.id === selected!.value.id));
    expect(saved.shapes.find((value: any) => value.id === remaining.value.id)).toMatchObject({ id: remaining.value.id,
      item: remaining.value.item, content: remaining.content });
    expect(saved.project.revision).toBe(original.project.revision + 2);
    expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts);
    expect((await history()).undo.filter((action: any) => action.label === "shape.edit")).toHaveLength(2);
    await page.reload(); await expect(restore).toHaveCount(0);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(saved.project.revision));
    expect(await workspace.state()).toEqual(saved);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});
