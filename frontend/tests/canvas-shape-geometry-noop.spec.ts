import { test, expect } from "./writing-board-fixture";

test("形状移动与尺寸真实409确认同一目标的no-op回执释放保存，可切研究编辑并撤销真实动作", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "完整保护正文", x: 800, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 800, y: 420, width: 190, height: 27 } });
  const content = { shapeType: "rectangle", shortText: "同目标完整形状😀", fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 };
  await execute("shape.create", { id: "same-target-shape", content, pose: { x: 250, y: 190, width: 240, height: 130 } });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const read = async (suffix = "") => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + suffix);
    expect(response.status()).toBe(200); return response.json();
  };
  const original = await read(), shape = original.shapes[0];
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect.poll(() => page.getByRole("tab", { selected: true }).getAttribute("title")).not.toBe(projectId);
  const otherId = await page.getByRole("tab", { selected: true }).getAttribute("title");
  expect(otherId).not.toBe(projectId);
  const tab = (id: string) => page.locator('[role="tab"][title="' + id + '"]');
  await tab(projectId).click(); await expect(tab(projectId)).toHaveAttribute("aria-selected", "true");
  const visual = page.getByRole("img", { name: content.shortText, exact: true });
  await expect(visual).toBeVisible();
  let active: { type: string; before: any; attempts: any[]; peer: any; peerHistory: any } | null = null;
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON(), current = active;
    if (!current || command?.type !== current.type) { await route.continue(); return; }
    if (current.attempts.length === 0) {
      // The local request is held before forwarding; a real peer wins the same complete target first.
      const peer = await execute(command.type, command.payload, current.before.item.versionId);
      expect(peer.changedIds.length).toBeGreaterThan(0);
      current.peer = await read(); current.peerHistory = await read("/history");
    }
    const response = await route.fetch(), body = await response.json();
    current.attempts.push({ command, status: response.status(), body });
    await route.fulfill({ response });
  });
  try {
    for (const type of ["shape.move", "shape.transform"]) {
      const before = await read(), beforeHistory = await read("/history");
      active = { type, before: before.shapes[0], attempts: [], peer: null, peerHistory: null };
      await visual.click();
      expect(await page.locator(".react-flow__viewport").evaluate(element =>
        new DOMMatrix(getComputedStyle(element).transform).a)).toBe(1);
      const moving = type === "shape.move";
      const target = moving ? visual : page.getByRole("button", { name: "调整形状尺寸：左上", exact: true });
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + (moving ? 48 : -24), box.y + box.height / 2 + (moving ? 32 : -16), { steps: 5 });
      await page.mouse.up();
      const comparison = page.getByRole("region", { name: moving ? "形状位置保存冲突" : "形状尺寸保存冲突", exact: true });
      await expect(comparison).toBeVisible();
      expect(active.attempts).toHaveLength(1);
      const first = active.attempts[0], peer = active.peer;
      expect(first).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" },
        command: { projectId, type, expected: active.before.item.versionId, payload: { id: shape.id } } });
      const expectedPose = moving
        ? { ...active.before.item.pose, x: active.before.item.pose.x + 48, y: active.before.item.pose.y + 32 }
        : { x: active.before.item.pose.x - 24, y: active.before.item.pose.y - 16,
          width: active.before.item.pose.width + 24, height: active.before.item.pose.height + 16 };
      expect(peer.shapes[0].item.pose).toEqual(expectedPose);
      expect(peer.project.revision).toBe(before.project.revision + 1);
      expect(active.peerHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
      expect(await read()).toEqual(peer); expect(await read("/history")).toEqual(active.peerHistory);
      await expect(comparison.getByText("本次位置：" + expectedPose.x + ", " + expectedPose.y, { exact: true })).toBeVisible();
      await expect(comparison.getByText("已保存位置：" + expectedPose.x + ", " + expectedPose.y, { exact: true })).toBeVisible();
      await comparison.getByRole("button", { name: moving ? "确认保留本次位置" : "确认保留本次尺寸", exact: true }).click();
      await expect.poll(() => active!.attempts.length).toBe(2);
      const confirmed = active.attempts[1];
      expect(confirmed.status).toBe(200); expect(confirmed.body.changedIds).toEqual([]);
      expect(confirmed.body.shapeVersions).toBeUndefined();
      expect(confirmed.command.commandId).not.toBe(first.command.commandId);
      expect(confirmed.command).toEqual({ ...first.command, commandId: confirmed.command.commandId, expected: peer.shapes[0].item.versionId });
      expect(confirmed.body).toMatchObject({ commandId: confirmed.command.commandId, projectId, revision: peer.project.revision });
      expect(await read()).toEqual(peer); expect(await read("/history")).toEqual(active.peerHistory);
      await expect(page.getByRole("status"), "真实成功no-op必须解除形状几何保存屏障").toHaveText("已保存到本机");
      await expect(comparison).toHaveCount(0);
      await expect(page.getByRole("button", { name: moving ? "重试保存形状位置" : "重试保存形状尺寸", exact: true })).toHaveCount(0);
      const node = page.locator('.react-flow__node[data-id="' + shape.item.id + '"]');
      const geometry = await node.evaluate(element => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform), box = element.getBoundingClientRect();
        return { x: matrix.e, y: matrix.f, width: box.width, height: box.height };
      });
      for (const key of ["x", "y", "width", "height"] as const) expect(geometry[key]).toBeCloseTo(expectedPose[key], 2);
      await tab(otherId!).click(); await expect(tab(otherId!)).toHaveAttribute("aria-selected", "true");
      await expect(visual).toHaveCount(0);
      await tab(projectId).click(); await expect(tab(projectId)).toHaveAttribute("aria-selected", "true");
      await expect(visual).toBeVisible(); await visual.click();
      await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "形状文字", exact: true }); await expect(editor).toHaveValue(content.shortText);
      await editor.press("Escape"); await expect(editor).toHaveCount(0);
      expect(await read()).toEqual(peer); expect(await read("/history")).toEqual(active.peerHistory);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect.poll(async () => (await read()).shapes[0].item.pose).toEqual(active.before.item.pose);
      await page.getByRole("button", { name: "重做", exact: true }).click();
      await expect.poll(async () => (await read()).shapes[0].item.pose).toEqual(expectedPose);
      const after = await read();
      expect(after.project.revision).toBe(peer.project.revision + 2);
      expect(after.shapes[0]).toMatchObject({ id: shape.id, versionId: shape.versionId, content,
        item: { id: shape.item.id, createdOrder: shape.item.createdOrder, pose: expectedPose } });
      expect(after.cards).toEqual(original.cards); expect(after.texts).toEqual(original.texts); expect(after.tags).toEqual(original.tags);
      expect((await read("/history")).undo).toHaveLength(active.peerHistory.undo.length);
      expect(active.attempts).toHaveLength(2);
      active = null;
    }
    const final = await read(); await page.reload(); await expect(visual).toBeVisible(); expect(await read()).toEqual(final);
  } finally { await page.unrouteAll({ behavior: "wait" }); }
});
