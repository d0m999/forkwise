import { test, expect } from "./writing-board-fixture";

test("形状短文原件及首个恢复副本相继删除，完整读失败仍保留冻结请求与全文，重开明确接管后仅新建并撤销C2", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  const read = async (suffix = "") => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + suffix);
    expect(response.status()).toBe(200); return response.json();
  };
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保护完整正文", x: 850, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 850, y: 420, width: 190, height: 27 } });
  await execute("shape.create", { id: "protected-shape", content: { shapeType: "ellipse", shortText: "保护另一形状", fill: "#fef3c7" },
    pose: { x: 850, y: 650, width: 180, height: 100 } });
  const content = { shapeType: "triangle", shortText: "原件完整短文", fill: "#dcfce7", stroke: "#166534", strokeWidth: 3 };
  const pose = { x: 250, y: 190, width: 280, height: 130 };
  await execute("shape.create", { id: "original-shape", content, pose });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") && response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200); await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await read(), source = original.shapes.find((value: any) => value.id === "original-shape");
  const protectedShape = original.shapes.find((value: any) => value.id === "protected-shape"), originalHistory = await read("/history");
  const attempts: { command: any; status: number; body: any }[] = [], versionReads: { url: string; status: number; body: any }[] = [];
  let failRead = false, failedReads = 0;
  await page.route("**/api/mapping/projects/" + projectId + "/map?**", async route => {
    const url = new URL(route.request().url());
    if (failRead && url.searchParams.get("view") === "index" && !url.searchParams.has("snapshot")) {
      failRead = false; const response = await route.fetch(); expect(response.status()).toBe(200); failedReads++;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "完整删除确认读取失败" }) });
    } else await route.continue();
  });
  await page.route("**/api/mapping/projects/" + projectId + "/versions/pose/**", async route => {
    const response = await route.fetch(); versionReads.push({ url: route.request().url(), status: response.status(), body: await response.json() });
    await route.fulfill({ response });
  });
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (!["shape.create", "shape.edit"].includes(command?.type)) { await route.continue(); return; }
    if (attempts.length === 0) {
      const body = { code: "UNAVAILABLE", message: "短文原请求提交前503" }; attempts.push({ command, status: 503, body });
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(body) }); return;
    }
    const response = await route.fetch(), body = await response.json(); attempts.push({ command, status: response.status(), body });
    if (command.type === "shape.edit" && command.payload.id === source.id && attempts.length === 2) failRead = true;
    if (command.type === "shape.create" && attempts.filter(value => value.command.type === "shape.create").length === 1)
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "短文首个副本已创建但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    await page.getByRole("img", { name: content.shortText, exact: true }).click();
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    const textA = "首次A😀\n原请求保留", textB = "较新全文B🧭\n换行和空行\n\n最后「保留」😀", textC = "副本后续全文C😀\n原样保留引号：\"我的文字\"\n\n最后🧭";
    await editor.fill(textA); await page.getByRole("button", { name: "保存形状文字", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "短文原请求提交前503" })).toBeVisible();
    expect(await read()).toEqual(original); expect(await read("/history")).toEqual(originalHistory);
    await expect(editor).toBeEditable(); await editor.fill(textB);
    await execute("shape.delete", { id: source.id }, { shape: source.versionId, pose: source.item.versionId });
    const sourceDeleted = await read(), sourceDeletedHistory = await read("/history"); expect(sourceDeleted.shapes).toEqual([protectedShape]);
    const retry = page.getByRole("button", { name: "重试保存形状文字", exact: true });
    await retry.click(); await expect.poll(() => attempts.length).toBe(2); await expect(retry).toBeEnabled();
    expect(attempts[1]).toMatchObject({ command: attempts[0].command, status: 404, body: { code: "NOT_FOUND" } });
    await expect(editor).toHaveValue(textB); await expect(editor).toBeEditable();
    const comparison = page.getByRole("region", { name: "形状文字保存冲突", exact: true }); await expect(comparison).toHaveCount(0);
    expect(await read()).toEqual(sourceDeleted); expect(await read("/history")).toEqual(sourceDeletedHistory);
    await retry.click(); await expect.poll(() => attempts.length).toBe(3); expect(attempts[2]).toEqual(attempts[1]);
    const missing = comparison.getByRole("textbox", { name: "已保存的形状文字", exact: true });
    await expect(missing, "确定404且完整公开读确认删除后，应保留全文并提供明确恢复").toHaveValue("原形状已删除");
    expect(failedReads).toBe(1); await expect(comparison.getByRole("textbox", { name: "我的形状文字", exact: true })).toHaveValue(textB);
    await workspace.restart(); page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload(); await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(sourceDeleted.project.revision));
    const pickup = page.getByRole("button", { name: "恢复形状文字草稿", exact: true }); await expect(pickup).toHaveCount(1);
    await expect(editor).toHaveCount(0); expect(attempts).toHaveLength(3); await pickup.click();
    await expect(editor).toHaveValue(textB); await expect(editor).toBeEditable(); await expect(missing).toHaveValue("原形状已删除");
    expect(await read()).toEqual(sourceDeleted); expect(await read("/history")).toEqual(sourceDeletedHistory); expect(attempts).toHaveLength(3);
    await comparison.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "短文首个副本已创建但ACK未送达" })).toBeVisible();
    const firstCreate = attempts[3]; expect(firstCreate.status).toBe(200);
    expect(firstCreate.command).toMatchObject({ projectId, type: "shape.create", expected: null, payload: { content: { ...content, shortText: textB }, pose } });
    const firstCopy = (await read()).shapes.find((value: any) => value.id === firstCreate.command.payload.id);
    expect(firstCopy.id).not.toBe(source.id); expect(firstCopy.item.id).not.toBe(source.item.id);
    await expect(editor).toBeEditable(); await editor.fill(textC);
    await execute("shape.delete", { id: firstCopy.id }, { shape: firstCopy.versionId, pose: firstCopy.item.versionId });
    const bothDeleted = await read(), bothDeletedHistory = await read("/history"); expect(bothDeleted.shapes).toEqual([protectedShape]);
    await comparison.getByRole("button", { name: "重试恢复我的形状", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(6); expect(attempts[4]).toEqual(firstCreate);
    const localC = { ...content, shortText: textC };
    expect(attempts[5]).toMatchObject({ status: 404, body: { code: "NOT_FOUND" }, command: { projectId, type: "shape.edit",
      expected: firstCreate.body.shapeVersions.shape, payload: { id: firstCopy.id, content: localC } } });
    await expect(comparison.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }), "C1删除后应耐久接管C1目标，保留全文而非永远重试旧编辑").toBeEnabled();
    await expect(missing).toHaveValue("原形状已删除"); await expect(editor).toHaveValue(textC); await expect(editor).toBeEditable();
    await expect(comparison.getByRole("textbox", { name: "我的形状文字", exact: true })).toHaveValue(textC);
    const itemURL = workspace.origin + "/api/mapping/projects/" + projectId + "/versions/pose/" + firstCopy.item.id + "/" + firstCreate.body.shapeVersions.pose;
    expect(versionReads.find(value => value.url === itemURL), "C1 Item来自自己的回执和公开不可变Pose版本").toEqual({ url: itemURL, status: 200, body: firstCopy.item });
    expect(await read()).toEqual(bothDeleted); expect(await read("/history")).toEqual(bothDeletedHistory); expect(bothDeletedHistory.undo).toHaveLength(originalHistory.undo.length + 3);
    await workspace.restart(); page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload(); await expect(pickup).toHaveCount(1); await expect(editor).toHaveCount(0); expect(attempts).toHaveLength(6);
    await pickup.click(); await expect(editor).toHaveValue(textC); await expect(missing).toHaveValue("原形状已删除");
    expect(await read()).toEqual(bothDeleted); expect(await read("/history")).toEqual(bothDeletedHistory); expect(attempts).toHaveLength(6);
    await comparison.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click();
    await expect(editor).toHaveCount(0); await expect(comparison).toHaveCount(0); expect(attempts).toHaveLength(7);
    const secondCreate = attempts[6]; expect(secondCreate.status).toBe(200); expect(secondCreate.command.commandId).not.toBe(firstCreate.command.commandId);
    expect([source.id, firstCopy.id]).not.toContain(secondCreate.command.payload.id);
    expect(secondCreate.command).toMatchObject({ projectId, type: "shape.create", expected: null, payload: { content: localC, pose } });
    const saved = await read(), secondCopy = saved.shapes.find((value: any) => value.id === secondCreate.command.payload.id);
    expect(saved.shapes).toHaveLength(2); expect(secondCopy).toMatchObject({ content: localC, item: { pose } });
    expect([source.item.id, firstCopy.item.id]).not.toContain(secondCopy.item.id); expect(saved.project.revision).toBe(bothDeleted.project.revision + 1);
    expect((await read("/history")).undo).toHaveLength(bothDeletedHistory.undo.length + 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click(); await expect.poll(async () => (await read()).shapes).toEqual([protectedShape]);
    const undone = await read(); expect(undone.cards).toEqual(original.cards); expect(undone.texts).toEqual(original.texts); expect(undone.tags).toEqual(original.tags);
    await page.getByRole("button", { name: "重做", exact: true }).click(); await expect.poll(async () => (await read()).shapes.length).toBe(2);
    const final = await read(), redone = final.shapes.find((value: any) => value.id === secondCopy.id);
    expect(redone).toMatchObject({ id: secondCopy.id, content: localC, item: { id: secondCopy.item.id, createdOrder: secondCopy.item.createdOrder, pose } });
    expect(redone.versionId).not.toBe(secondCopy.versionId); expect(redone.item.versionId).not.toBe(secondCopy.item.versionId);
    expect(final.shapes.find((value: any) => value.id === protectedShape.id)).toEqual(protectedShape);
    expect(final.cards).toEqual(original.cards); expect(final.texts).toEqual(original.texts); expect(final.tags).toEqual(original.tags);
    await page.reload(); await expect(pickup).toHaveCount(0); await expect(editor).toHaveCount(0); await expect(comparison).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机"); expect(await read()).toEqual(final); expect(attempts).toHaveLength(7);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
