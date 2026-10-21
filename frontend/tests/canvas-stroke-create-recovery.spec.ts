import { test, expect } from "./writing-board-fixture";

test("笔迹创建丢 ACK 后原请求重试与同库重开明确恢复不重复创建并保留撤销身份", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const seed = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await seed("thought.create", { id: "protected-card", title: "恢复保护卡", text: "完整保护正文", x: 820, y: 110 });
  await seed("text.create", { id: "protected-text", content: {
    runs: [{ text: "恢复保护文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 820, y: 430, width: 190, height: 27 } });
  await seed("shape.create", { id: "protected-shape", content: {
    shapeType: "diamond", shortText: "恢复保护形状", fill: "#dce8dd", stroke: "#403b36", strokeWidth: 2,
  }, pose: { x: 600, y: 300, width: 150, height: 90 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const baseline = await workspace.state() as any;
  await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(baseline.project.revision));
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const beforeHistory = await history();
  const attempts: { command: any; receipt: any; status: number }[] = [];
  const message = "笔迹已提交但 ACK 未送达";
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "stroke.create") { await route.continue(); return; }
    const response = await route.fetch();
    attempts.push({ command, receipt: await response.json(), status: response.status() });
    if (attempts.length <= 2) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message }) });
    else await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "画笔", exact: true }).click();
    await page.getByRole("menuitem", { name: "普通笔", exact: true }).click();
    await expect(page.getByRole("button", { name: "画笔", exact: true })).toHaveAttribute("aria-pressed", "true");
    const box = (await page.locator(".react-flow").boundingBox())!;
    await page.mouse.move(box.x + 180, box.y + 220); await page.mouse.down();
    await page.mouse.move(box.x + 210, box.y + 240); await page.mouse.move(box.x + 240, box.y + 225);
    await page.mouse.move(box.x + 270, box.y + 250);
    const preview = page.getByRole("img", { name: "笔迹预览", exact: true });
    await expect(preview).toBeVisible(); expect(attempts).toHaveLength(0); await page.mouse.up();
    const retry = page.getByRole("button", { name: "重试保存", exact: true });
    await expect(page.locator(".save-state").getByRole("alert").filter({ hasText: message })).toBeVisible();
    await expect(retry).toBeEnabled(); expect(attempts).toHaveLength(1); expect(attempts[0].status).toBe(200);
    const committed = await workspace.state() as any, committedHistory = await history();
    expect(committed.strokes).toHaveLength(1); const stroke = committed.strokes[0];
    expect(committed.project.revision).toBe(baseline.project.revision + 1);
    expect(attempts[0].command).toMatchObject({ projectId, type: "stroke.create", expected: null,
      payload: { id: stroke.id, content: stroke.content, pose: stroke.item.pose } });
    expect(stroke.content.path).toHaveLength(4);
    expect(stroke.content).toMatchObject({ penKind: "pen", color: "#403b36", width: 2, opacity: 1 });
    expect(attempts[0].receipt.strokeVersions).toEqual({ stroke: stroke.versionId, pose: stroke.item.versionId });
    expect(committedHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
    expect(committedHistory.undo.at(-1)).toMatchObject({ id: attempts[0].command.commandId, label: "stroke.create" });
    for (const key of ["cards", "texts", "shapes", "tags"]) expect(committed[key]).toEqual(baseline[key]);
    await expect(preview).toBeVisible(); await retry.click();
    await expect.poll(() => attempts.length).toBe(2); await expect(retry).toBeEnabled();
    expect(attempts[1]).toEqual(attempts[0]);
    expect(await workspace.state()).toEqual(committed); expect(await history()).toEqual(committedHistory);
    await expect(preview).toBeVisible();
    await workspace.restart();
    page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload();
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(committed.project.revision));
    await expect(page.getByRole("img", { name: "普通笔笔迹", exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2); expect(await workspace.state()).toEqual(committed); expect(await history()).toEqual(committedHistory);
    const recover = page.getByRole("button", { name: "恢复未确认笔迹", exact: true });
    expect(await recover.count(), "同库重开后必须明确恢复当前项目的未确认笔迹，不能自动发请求").toBe(1);
    await expect(preview).toHaveCount(0); await recover.click();
    await expect.poll(() => attempts.length).toBe(3);
    await expect(recover).toHaveCount(0); await expect(preview).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("已保存到本机"); await expect(retry).toHaveCount(0);
    expect(attempts.map(value => value.status)).toEqual([200, 200, 200]);
    expect(attempts[2]).toEqual(attempts[0]);
    expect(await workspace.state()).toEqual(committed); expect(await history()).toEqual(committedHistory);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state() as any).strokes).toEqual([]);
    await expect(page.getByRole("img", { name: "普通笔笔迹", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect(page.getByRole("img", { name: "普通笔笔迹", exact: true })).toBeVisible();
    const saved = await workspace.state() as any, restored = saved.strokes[0];
    expect(saved.strokes).toHaveLength(1);
    expect(restored).toMatchObject({ id: stroke.id, content: stroke.content, item: { id: stroke.item.id, createdOrder: stroke.item.createdOrder, pose: stroke.item.pose } });
    expect(restored.versionId).not.toBe(stroke.versionId); expect(restored.item.versionId).not.toBe(stroke.item.versionId);
    for (const key of ["cards", "texts", "shapes", "tags"]) expect(saved[key]).toEqual(baseline[key]);
    expect((await history()).undo.filter((action: any) => action.label === "stroke.create")).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole("img", { name: "普通笔笔迹", exact: true })).toBeVisible();
    await expect(recover).toHaveCount(0); await expect(preview).toHaveCount(0); expect(attempts).toHaveLength(3);
    expect(await workspace.state()).toEqual(saved);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
