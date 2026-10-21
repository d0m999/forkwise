import { test, expect } from "./writing-board-fixture";

test("外观原请求与恢复副本遇真实404后耐久保留草稿，重开明确新建完整后代", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  const read = async (suffix = "") => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + suffix);
    expect(response.status()).toBe(200); return response.json();
  };
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保护完整正文", x: 850, y: 100 });
  await execute("tag.create", { id: "protected-tag", name: "保护标签" });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 850, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "roundedRectangle", shortText: "完整原文😀\n两次删除后仍保留", fill: "#ffffff", stroke: "#111111", strokeWidth: 1 };
  const pose = { x: 250, y: 190, width: 240, height: 130 };
  await execute("shape.create", { id: "original-shape", content, pose });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") && response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200); await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await read(), source = original.shapes[0], originalHistory = await read("/history");
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
      const body = { code: "UNAVAILABLE", message: "原外观请求提交前503" }; attempts.push({ command, status: 503, body });
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(body) }); return;
    }
    const response = await route.fetch(), body = await response.json(); attempts.push({ command, status: response.status(), body });
    if (command.type === "shape.edit" && command.payload.id === source.id && attempts.length === 2) failRead = true;
    if (command.type === "shape.create" && attempts.filter(value => value.command.type === "shape.create").length === 1)
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "恢复副本已创建但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    await page.getByRole("img", { name: content.shortText, exact: true }).click(); await page.getByRole("button", { name: "形状外观", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "形状外观", exact: true });
    const fill = dialog.getByRole("textbox", { name: "填充颜色", exact: true });
    const stroke = dialog.getByRole("textbox", { name: "轮廓颜色", exact: true });
    const width = dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true });
    await fill.fill("#dbeafe"); await stroke.fill("#1d4ed8"); await width.fill("3");
    await dialog.getByRole("button", { name: "保存形状外观", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("原外观请求提交前503");
    expect(await read()).toEqual(original); expect(await read("/history")).toEqual(originalHistory);
    await fill.fill("#dcfce7"); await stroke.fill(""); await width.fill("5");
    const localB = { shapeType: content.shapeType, shortText: content.shortText, fill: "#dcfce7", strokeWidth: 5 };
    await execute("shape.delete", { id: source.id }, { shape: source.versionId, pose: source.item.versionId });
    const sourceDeleted = await read(), sourceDeletedHistory = await read("/history"); expect(sourceDeleted.shapes).toEqual([]);
    const retry = dialog.getByRole("button", { name: "重试保存形状外观", exact: true });
    await retry.click(); await expect.poll(() => attempts.length).toBe(2); await expect(retry).toBeEnabled();
    expect(attempts[1]).toMatchObject({ command: attempts[0].command, status: 404, body: { code: "NOT_FOUND" } });
    await expect(fill).toHaveValue("#dcfce7"); await expect(stroke).toHaveValue(""); await expect(width).toHaveValue("5");
    await expect(dialog.getByRole("button", { name: "保留对方并恢复我的形状", exact: true })).toHaveCount(0);
    expect(await read()).toEqual(sourceDeleted); expect(await read("/history")).toEqual(sourceDeletedHistory);
    await retry.click(); await expect.poll(() => attempts.length).toBe(3); expect(attempts[2]).toEqual(attempts[1]);
    const missing = dialog.getByRole("textbox", { name: "已保存的形状内容", exact: true });
    await expect(missing, "确定404且完整公开读确认删除后，必须进入remote:null显式恢复").toHaveValue("原形状已删除");
    expect(failedReads).toBe(1);
    await expect(dialog.getByRole("textbox", { name: "我的形状内容", exact: true })).toHaveValue(JSON.stringify(localB, null, 2));
    await expect(dialog.getByRole("textbox", { name: "我的形状位置", exact: true })).toHaveValue(JSON.stringify(pose, null, 2));
    await workspace.restart(); page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload(); await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(sourceDeleted.project.revision));
    const pickup = page.getByRole("button", { name: "恢复形状外观草稿", exact: true }); await expect(pickup).toHaveCount(1);
    expect(attempts).toHaveLength(3); await pickup.click(); await expect(dialog).toBeVisible(); await expect(missing).toHaveValue("原形状已删除");
    await expect(fill).toHaveValue("#dcfce7"); await expect(stroke).toHaveValue(""); await expect(width).toHaveValue("5");
    expect(await read()).toEqual(sourceDeleted); expect(await read("/history")).toEqual(sourceDeletedHistory); expect(attempts).toHaveLength(3);
    await dialog.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("恢复副本已创建但ACK未送达");
    const firstCreate = attempts[3]; expect(firstCreate.status).toBe(200);
    expect(firstCreate.command).toMatchObject({ projectId, type: "shape.create", expected: null, payload: { content: localB, pose } });
    const firstCopy = (await read()).shapes.find((value: any) => value.id === firstCreate.command.payload.id);
    expect(firstCopy.id).not.toBe(source.id); expect(firstCopy.item.id).not.toBe(source.item.id);
    await fill.fill("#ede9fe"); await stroke.fill("#6d28d9"); await width.fill("7");
    const localC = { ...content, fill: "#ede9fe", stroke: "#6d28d9", strokeWidth: 7 };
    await execute("shape.delete", { id: firstCopy.id }, { shape: firstCopy.versionId, pose: firstCopy.item.versionId });
    const bothDeleted = await read(), bothDeletedHistory = await read("/history"); expect(bothDeleted.shapes).toEqual([]);
    await dialog.getByRole("button", { name: "重试恢复我的形状", exact: true }).click();
    await expect.poll(() => attempts.length).toBe(6); expect(attempts[4]).toEqual(firstCreate);
    expect(attempts[5]).toMatchObject({ status: 404, body: { code: "NOT_FOUND" }, command: { projectId, type: "shape.edit",
      expected: firstCreate.body.shapeVersions.shape, payload: { id: firstCopy.id, content: localC } } });
    await expect(dialog.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }), "C1删除后应完成耐久目标交接，不能永远重试已拒绝的旧副本编辑").toBeEnabled();
    await expect(missing).toHaveValue("原形状已删除");
    await expect.poll(async () => JSON.parse(await dialog.getByRole("textbox", { name: "我的形状内容", exact: true }).inputValue())).toEqual(localC);
    await expect(dialog.getByRole("textbox", { name: "我的形状位置", exact: true })).toHaveValue(JSON.stringify(pose, null, 2));
    const itemRead = versionReads.find(value => new URL(value.url).pathname.endsWith("/versions/pose/" + firstCopy.item.id + "/" + firstCreate.body.shapeVersions.pose));
    expect(itemRead, "真实C1 Item必须来自自己的create回执和公开不可变Pose版本").toEqual({ url: workspace.origin + "/api/mapping/projects/" + projectId + "/versions/pose/" + firstCopy.item.id + "/" + firstCreate.body.shapeVersions.pose,
      status: 200, body: firstCopy.item });
    expect(await read()).toEqual(bothDeleted); expect(await read("/history")).toEqual(bothDeletedHistory); expect(bothDeletedHistory.undo).toHaveLength(originalHistory.undo.length + 3);
    await workspace.restart(); page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload(); await expect(pickup).toHaveCount(1); expect(attempts).toHaveLength(6);
    await pickup.click(); await expect(dialog).toBeVisible(); await expect(missing).toHaveValue("原形状已删除");
    await expect(fill).toHaveValue("#ede9fe"); await expect(stroke).toHaveValue("#6d28d9"); await expect(width).toHaveValue("7");
    await expect.poll(async () => JSON.parse(await dialog.getByRole("textbox", { name: "我的形状内容", exact: true }).inputValue())).toEqual(localC);
    expect(await read()).toEqual(bothDeleted); expect(await read("/history")).toEqual(bothDeletedHistory); expect(attempts).toHaveLength(6);
    await dialog.getByRole("button", { name: "保留对方并恢复我的形状", exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect(attempts).toHaveLength(7); const secondCreate = attempts[6]; expect(secondCreate.status).toBe(200);
    expect(secondCreate.command.commandId).not.toBe(firstCreate.command.commandId); expect([source.id, firstCopy.id]).not.toContain(secondCreate.command.payload.id);
    expect(secondCreate.command).toMatchObject({ projectId, type: "shape.create", expected: null, payload: { content: localC, pose } });
    const saved = await read(), secondCopy = saved.shapes[0]; expect(saved.shapes).toHaveLength(1);
    expect(secondCopy).toMatchObject({ id: secondCreate.command.payload.id, content: localC, item: { pose } });
    expect([source.item.id, firstCopy.item.id]).not.toContain(secondCopy.item.id); expect(saved.project.revision).toBe(bothDeleted.project.revision + 1);
    expect((await read("/history")).undo).toHaveLength(bothDeletedHistory.undo.length + 1);
    await page.getByRole("button", { name: "撤销", exact: true }).click(); await expect.poll(async () => (await read()).shapes).toEqual([]);
    const undone = await read(); expect(undone.cards).toEqual(original.cards); expect(undone.texts).toEqual(original.texts); expect(undone.tags).toEqual(original.tags);
    await page.getByRole("button", { name: "重做", exact: true }).click(); await expect.poll(async () => (await read()).shapes.length).toBe(1);
    const final = await read(); expect(final.shapes[0]).toMatchObject({ id: secondCopy.id, content: localC, item: { id: secondCopy.item.id, createdOrder: secondCopy.item.createdOrder, pose } });
    expect(final.cards).toEqual(original.cards); expect(final.texts).toEqual(original.texts); expect(final.tags).toEqual(original.tags);
    await page.reload(); await expect(pickup).toHaveCount(0); await expect(dialog).toHaveCount(0); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(await read()).toEqual(final); expect(attempts).toHaveLength(7);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
