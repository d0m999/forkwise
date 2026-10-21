import { test, expect } from "./writing-board-fixture";

test("形状短文字原生撤销及合成输入不提前提交，保存失败保原目标，重试后切换仅更新该短文并重开一致", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保留正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "roundedRectangle", shortText: "原始短文", fill: "#fef3c7", stroke: "#92400e", strokeWidth: 2 };
  await execute("shape.create", { id: "edited-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload();
  expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const writes: any[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/mapping/execute") && request.postDataJSON()?.type === "shape.edit") writes.push(request.postDataJSON());
  });
  await page.getByRole("img", { name: content.shortText, exact: true }).click();
  const edit = page.getByRole("button", { name: "编辑形状文字", exact: true });
  expect(await edit.count(), "选中形状应提供独立短文字编辑入口").toBe(1);
  await edit.click();
  const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(content.shortText);
  await editor.press("End");
  await editor.pressSequentially("A");
  await expect(editor).toHaveValue(content.shortText + "A");
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue(content.shortText);
  expect(await workspace.state()).toEqual(original);
  expect(writes).toEqual([]);
  // Synthetic DOM composition checks headless routing; it is not evidence of OS IME.
  await editor.dispatchEvent("compositionstart");
  await editor.fill("合成中的半成品");
  for (const key of ["Enter", "Escape"]) await editor.dispatchEvent("keydown", { key, code: key, isComposing: true, keyCode: 229 });
  await expect(editor).toBeFocused();
  expect(writes).toEqual([]);
  expect(await workspace.state()).toEqual(original);
  const finalText = '第一行😀\n第二行 "条件" 与 🧠';
  await editor.fill(finalText);
  await editor.dispatchEvent("compositionend", { data: finalText });
  let failOnce = true;
  await page.route("**/api/mapping/execute", async route => {
    if (route.request().postDataJSON()?.type === "shape.edit" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "测试暂不可用" }) });
    } else await route.continue();
  });
  try {
    await page.getByRole("button", { name: "保护卡片", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "测试暂不可用" })).toBeVisible();
    await expect(editor).toHaveValue(finalText);
    await expect(page.locator('.react-flow__node[data-id="' + shape.item.id + '"]')).toHaveClass(/selected/);
    expect(await workspace.state()).toEqual(original);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ projectId, type: "shape.edit", expected: shape.versionId,
      payload: { id: shape.id, content: { ...content, shortText: finalText } } });
    await page.getByRole("button", { name: "重试保存形状文字", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(async () => (await workspace.state() as any).shapes[0].content.shortText).toBe(finalText);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    await page.getByRole("button", { name: "保护卡片", exact: true }).click();
    const saved = await workspace.state() as any;
    expect(saved.shapes[0]).toMatchObject({ id: shape.id, content: { ...content, shortText: finalText }, item: shape.item });
    expect(saved.shapes[0].versionId).not.toBe(shape.versionId);
    expect(saved.cards).toEqual(original.cards);
    expect(saved.texts).toEqual(original.texts);
    await expect(page.getByRole("complementary", { name: "写字板", exact: true })).toHaveCount(0);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(saved.project.revision));
    await page.reload();
    await expect(page.getByRole("img", { name: finalText, exact: true })).toBeVisible();
    const reopened = await workspace.state() as any;
    expect(reopened.shapes).toEqual(saved.shapes);
    expect(reopened.cards).toEqual(original.cards);
    expect(reopened.texts).toEqual(original.texts);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
