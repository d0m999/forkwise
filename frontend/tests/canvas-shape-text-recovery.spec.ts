import { test, expect } from "./writing-board-fixture";

test("形状短文丢ACK后刷新明确恢复冻结请求及较新输入，仅用自己确认版本保存全文", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整保护正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "diamond", shortText: "原始完整短文", fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 };
  await execute("shape.create", { id: "text-journal-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any, shape = original.shapes[0];
  const attempts: { command: any; receipt: any; status: number }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "shape.edit") { await route.continue(); return; }
    const response = await route.fetch();
    attempts.push({ command, receipt: await response.json(), status: response.status() });
    if (attempts.length === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message: "短文已提交但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    await page.getByRole("img", { name: content.shortText, exact: true }).click();
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    const sent = "已发送A😀\n保留换行", later = "刷新前继续B🧭\n不能被旧ACK清掉";
    await editor.fill(sent);
    await page.getByRole("button", { name: "保存形状文字", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "短文已提交但ACK未送达" })).toBeVisible();
    const committed = await workspace.state() as any;
    expect(committed.shapes[0]).toMatchObject({ id: shape.id, item: shape.item, content: { ...content, shortText: sent } });
    expect(committed.project.revision).toBe(original.project.revision + 1);
    await expect(editor).toBeEditable(); await editor.fill(later);
    expect(attempts).toHaveLength(1); expect(await workspace.state()).toEqual(committed);
    page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload();
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(committed.project.revision));
    const recover = page.getByRole("button", { name: "恢复形状文字草稿", exact: true });
    expect(await recover.count(), "刷新后应明确提供当前授权项目的短文字草稿恢复入口").toBe(1);
    expect(attempts).toHaveLength(1); await expect(editor).toHaveCount(0);
    await recover.click(); await expect(editor).toHaveValue(later); await expect(editor).toBeEditable();
    expect(attempts).toHaveLength(1); expect(await workspace.state()).toEqual(committed);
    await page.getByRole("button", { name: "重试保存形状文字", exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(recover).toHaveCount(0);
    expect(attempts).toHaveLength(3); expect(attempts.map(value => value.status)).toEqual([200, 200, 200]);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0].command).toMatchObject({ projectId, type: "shape.edit", expected: shape.versionId,
      payload: { id: shape.id, content: { ...content, shortText: sent } } });
    expect(attempts[2].command.commandId).not.toBe(attempts[0].command.commandId);
    expect(attempts[2].command).toMatchObject({ projectId, type: "shape.edit", expected: attempts[1].receipt.shapeVersions.shape,
      payload: { id: shape.id, content: { ...content, shortText: later } } });
    const saved = await workspace.state() as any;
    expect(saved.shapes).toHaveLength(1);
    expect(saved.shapes[0]).toMatchObject({ id: shape.id, item: shape.item, content: { ...content, shortText: later } });
    expect(saved.shapes[0].versionId).toBe(attempts[2].receipt.shapeVersions.shape);
    expect(saved.project.revision).toBe(original.project.revision + 2);
    expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts);
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200);
    expect((await response.json()).undo.filter((action: any) => action.label === "shape.edit")).toHaveLength(2);
    await page.getByRole("button", { name: "保护卡片", exact: true }).click();
    await page.reload(); await expect(page.getByRole("img", { name: later, exact: true })).toBeVisible();
    await expect(recover).toHaveCount(0); expect(await workspace.state()).toEqual(saved);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
