import { test, expect } from "./writing-board-fixture";

test("形状移动与尺寸已提交丢ACK后被对方删除，原冻结请求仍可重取回执并解除保存屏障", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  const read = async (suffix = "") => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + suffix);
    expect(response.status()).toBe(200); return response.json();
  };
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整保护正文", x: 900, y: 100 });
  await execute("tag.create", { id: "protected-tag", name: "保护标签" });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 900, y: 420, width: 190, height: 27 } });
  for (const [id, shapeType, x, y] of [["move-target", "ellipse", 220, 180], ["size-target", "diamond", 540, 220],
    ["protected-shape", "rectangle", 220, 450]] as const) {
    await execute("shape.create", { id, content: { shapeType, shortText: id + "完整内容😀", fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 },
      pose: { x, y, width: 200, height: 120 } });
  }
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await read(), protectedShape = original.shapes.find((value: any) => value.id === "protected-shape");
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect.poll(() => page.getByRole("tab", { selected: true }).getAttribute("title")).not.toBe(projectId);
  const otherId = (await page.getByRole("tab", { selected: true }).getAttribute("title"))!;
  const tab = (id: string) => page.locator('[role="tab"][title="' + id + '"]');
  await tab(projectId).click(); await expect(tab(projectId)).toHaveAttribute("aria-selected", "true");
  let active: { type: string; id: string; attempts: any[] } | null = null;
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON(), current = active;
    if (!current || command?.type !== current.type || command?.payload?.id !== current.id) { await route.continue(); return; }
    const response = await route.fetch(), body = await response.json();
    current.attempts.push({ command, status: response.status(), body });
    if (current.attempts.length === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "UNAVAILABLE", message: "形状几何已提交但ACK未送达" }) });
    else await route.fulfill({ response });
  });
  try {
    for (const [id, type] of [["move-target", "shape.move"], ["size-target", "shape.transform"]]) {
      const before = await read(), beforeHistory = await read("/history"), shape = before.shapes.find((value: any) => value.id === id);
      const current = { type, id, attempts: [] as any[] }; active = current;
      const visual = page.getByRole("img", { name: shape.content.shortText, exact: true }); await visual.click();
      expect(await page.locator(".react-flow__viewport").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)).toBe(1);
      const moving = type === "shape.move", handle = moving ? visual : page.getByRole("button", { name: "调整形状尺寸：左上", exact: true });
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + (moving ? 48 : -24), box.y + box.height / 2 + (moving ? 32 : -16), { steps: 5 });
      await page.mouse.up();
      await expect(page.locator(".save-state").getByRole("alert").filter({ hasText: "形状几何已提交但ACK未送达" })).toBeVisible();
      expect(current.attempts).toHaveLength(1);
      const first = current.attempts[0], committed = await read(), committedHistory = await read("/history");
      const saved = committed.shapes.find((value: any) => value.id === id);
      const expectedPose = moving ? { ...shape.item.pose, x: shape.item.pose.x + 48, y: shape.item.pose.y + 32 }
        : { x: shape.item.pose.x - 24, y: shape.item.pose.y - 16, width: shape.item.pose.width + 24, height: shape.item.pose.height + 16 };
      expect(first.status).toBe(200);
      expect(first.command).toMatchObject({ projectId, type, expected: shape.item.versionId, payload: { id } });
      expect(saved).toEqual({ ...shape, item: { ...shape.item, versionId: first.body.shapeVersions.pose, pose: expectedPose } });
      expect(first.body).toMatchObject({ commandId: first.command.commandId, projectId, revision: before.project.revision + 1 });
      expect(committed.project.revision).toBe(before.project.revision + 1);
      expect(committedHistory.undo.slice(0, -1)).toEqual(beforeHistory.undo);
      expect(committedHistory.undo.at(-1).label).toBe(type);
      await execute("shape.delete", { id }, { shape: saved.versionId, pose: saved.item.versionId });
      const deleted = await read(), deletedHistory = await read("/history");
      expect(deleted.project.revision).toBe(committed.project.revision + 1);
      expect(deleted.shapes.some((value: any) => value.id === id)).toBe(false);
      await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(deleted.project.revision));
      await expect(page.locator('.react-flow__node[data-id="' + shape.item.id + '"]')).toHaveCount(0);
      if (!moving) { await workspace.restart(); expect(await read()).toEqual(deleted); }
      const retry = page.getByRole("button", { name: moving ? "重试保存形状位置" : "重试保存形状尺寸", exact: true });
      await retry.click();
      await expect.poll(() => current.attempts.length, { message: "目标已从正常同步地图移除后，仍须发送原冻结请求重取真实回执" }).toBe(2);
      expect(current.attempts[1]).toEqual(first);
      await expect(page.getByRole("status"), "已确认原几何回执必须释放保存屏障").toHaveText("已保存到本机");
      await expect(retry).toHaveCount(0);
      expect(await read()).toEqual(deleted); expect(await read("/history")).toEqual(deletedHistory);
      await tab(otherId).click(); await expect(tab(otherId)).toHaveAttribute("aria-selected", "true");
      await tab(projectId).click(); await expect(tab(projectId)).toHaveAttribute("aria-selected", "true");
      const protectedVisual = page.getByRole("img", { name: protectedShape.content.shortText, exact: true }); await protectedVisual.click();
      await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
      await expect(editor).toHaveValue(protectedShape.content.shortText); await editor.press("Escape"); await expect(editor).toHaveCount(0);
      const after = await read(); expect(after).toEqual(deleted); expect(await read("/history")).toEqual(deletedHistory);
      expect(after.cards).toEqual(original.cards); expect(after.texts).toEqual(original.texts); expect(after.tags).toEqual(original.tags);
      expect(after.shapes.find((value: any) => value.id === protectedShape.id)).toEqual(protectedShape);
      expect(current.attempts).toHaveLength(2); active = null;
    }
    const final = await read(), finalHistory = await read("/history");
    await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect(await read()).toEqual(final); expect(await read("/history")).toEqual(finalHistory);
    await expect(page.getByRole("button", { name: /重试保存形状位置|重试保存形状尺寸/ })).toHaveCount(0);
    expect(final.shapes).toEqual([protectedShape]);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
