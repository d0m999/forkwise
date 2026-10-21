import { test, expect } from "./writing-board-fixture";

test("形状已提交但ACK丢失后仍能继续输入，冻结命令幂等重试并仅以自己ACK版本保存后来全文", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保留正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "diamond", shortText: "原始短文", fill: "#dcfce7", stroke: "#166534", strokeWidth: 3 };
  await execute("shape.create", { id: "edited-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload();
  expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const attempts: { command: any; receipt: any; status: number }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "shape.edit") { await route.continue(); return; }
    const response = await route.fetch();
    attempts.push({ command, receipt: await response.json(), status: response.status() });
    if (attempts.length === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message: "已提交但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    await page.getByRole("img", { name: content.shortText, exact: true }).click();
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    const sentText = "首段已发出😀";
    await editor.fill(sentText);
    await page.getByRole("button", { name: "保护卡片", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "已提交但ACK未送达" })).toBeVisible();
    await expect(editor, "保存失败后原形状文字仍须允许继续输入").toBeEditable();
    const committed = await workspace.state() as any;
    expect(committed.shapes[0]).toMatchObject({ id: shape.id, content: { ...content, shortText: sentText }, item: shape.item });
    expect(committed.project.revision).toBe(original.project.revision + 1);
    await editor.press("End");
    await editor.press("Enter");
    await editor.pressSequentially("继续输入B");
    const finalText = sentText + "\n继续输入B";
    await expect(editor).toHaveValue(finalText);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(200);
    expect(attempts[0].command).toMatchObject({ projectId, type: "shape.edit", expected: shape.versionId,
      payload: { id: shape.id, content: { ...content, shortText: sentText } } });
    expect(attempts[0].receipt.shapeVersions).toEqual({ shape: committed.shapes[0].versionId, pose: shape.item.versionId });
    await page.getByRole("button", { name: "重试保存形状文字", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(() => attempts.length).toBe(3);
    expect(attempts.map(attempt => attempt.status)).toEqual([200, 200, 200]);
    expect(attempts[1].command).toEqual(attempts[0].command);
    expect(attempts[1].receipt).toEqual(attempts[0].receipt);
    expect(attempts[2].command.commandId).not.toBe(attempts[0].command.commandId);
    expect(attempts[2].command).toMatchObject({ projectId, type: "shape.edit", expected: attempts[1].receipt.shapeVersions.shape,
      payload: { id: shape.id, content: { ...content, shortText: finalText } } });
    const saved = await workspace.state() as any;
    expect(saved.project.revision).toBe(original.project.revision + 2);
    expect(saved.shapes[0]).toMatchObject({ id: shape.id, content: { ...content, shortText: finalText }, item: shape.item });
    expect(saved.shapes[0].versionId).toBe(attempts[2].receipt.shapeVersions.shape);
    expect(saved.shapes[0].versionId).not.toBe(committed.shapes[0].versionId);
    expect(saved.cards).toEqual(original.cards);
    expect(saved.texts).toEqual(original.texts);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(saved.project.revision));
    const historyResponse = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(historyResponse.status()).toBe(200);
    expect((await historyResponse.json()).undo.filter((action: any) => action.label === "shape.edit")).toHaveLength(2);
    await page.reload();
    await expect(page.getByRole("img", { name: finalText, exact: true })).toBeVisible();
    const reopened = await workspace.state() as any;
    expect(reopened.shapes).toEqual(saved.shapes);
    expect(reopened.cards).toEqual(original.cards);
    expect(reopened.texts).toEqual(original.texts);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
