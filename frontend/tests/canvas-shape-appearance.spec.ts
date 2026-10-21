import { test, expect } from "./writing-board-fixture";

test("形状外观面板不写默认值，先确认原短文再保存基础外观并统一撤销重做", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保留正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "roundedRectangle", shortText: "原短文" };
  await execute("shape.create", { id: "styled-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload();
  expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const beforeHistory = await history();
  await page.getByRole("img", { name: content.shortText, exact: true }).click();
  const trigger = page.getByRole("button", { name: "形状外观", exact: true });
  expect(await trigger.count(), "选中形状应提供可访问的基础外观入口").toBe(1);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "形状外观", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "填充颜色", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("textbox", { name: "轮廓颜色", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.press("Enter"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭形状外观", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(beforeHistory);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const attempts: { command: any; receipt: any }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "shape.edit") { await route.continue(); return; }
    const response = await route.fetch();
    attempts.push({ command, receipt: await response.json() });
    if (attempts.length === 1) await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    const shortText = "后来短文😀\n原样保留";
    await editor.fill(shortText);
    await page.getByRole("button", { name: "形状外观", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(1);
    await expect(dialog).toHaveCount(0); await expect(editor).toHaveValue(shortText);
    release(); await expect(dialog).toBeVisible(); await expect(editor).toHaveCount(0);
    const edited = await workspace.state() as any;
    expect(edited.shapes[0]).toMatchObject({ id: shape.id, item: shape.item, content: { ...content, shortText } });
    expect(edited.shapes[0].versionId).toBe(attempts[0].receipt.shapeVersions.shape);
    await dialog.getByRole("textbox", { name: "填充颜色", exact: true }).fill("#dbeafe");
    await dialog.getByRole("textbox", { name: "轮廓颜色", exact: true }).fill("#1d4ed8");
    const width = dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true });
    await width.fill("3"); await width.fill("");
    expect(attempts).toHaveLength(1); expect(await workspace.state()).toEqual(edited);
    await width.fill("3");
    await dialog.getByRole("button", { name: "保存形状外观", exact: true }).press("Enter");
    await expect(dialog).toHaveCount(0); await expect.poll(() => attempts.length).toBe(2);
    const styled = { ...content, shortText, fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 };
    expect(attempts[1].command).toMatchObject({ projectId, type: "shape.edit", expected: edited.shapes[0].versionId,
      payload: { id: shape.id, content: styled } });
    const saved = await workspace.state() as any;
    expect(saved.shapes[0]).toMatchObject({ id: shape.id, item: shape.item, content: styled });
    expect(saved.project.revision).toBe(original.project.revision + 2);
    expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes[0].content).toEqual({ ...content, shortText });
    const undone = await workspace.state() as any;
    expect(undone.shapes[0].item).toEqual(shape.item);
    expect(undone.shapes[0].versionId).not.toBe(edited.shapes[0].versionId);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).shapes[0].content).toEqual(styled);
    const redone = await workspace.state() as any;
    expect(redone.shapes[0].item).toEqual(shape.item);
    expect(redone.shapes[0].versionId).not.toBe(saved.shapes[0].versionId);
    await page.reload();
    const rendered = page.getByRole("img", { name: shortText, exact: true });
    await expect(rendered).toBeVisible();
    await expect(rendered).toHaveCSS("background-color", "rgb(219, 234, 254)");
    await expect(rendered).toHaveCSS("border-top-color", "rgb(29, 78, 216)");
    await expect(rendered).toHaveCSS("border-top-width", "3px");
    const reopened = await workspace.state() as any;
    expect(reopened.shapes).toEqual(redone.shapes);
    expect(reopened.cards).toEqual(original.cards); expect(reopened.texts).toEqual(original.texts);
    await expect(page.getByRole("complementary", { name: "写字板", exact: true })).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
});
