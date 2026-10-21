import { test, expect } from "./writing-board-fixture";

test("形状调整确认目标已删除后可明确取消，未知请求仍原样重试且清除同目标键盘等待", async ({ page, workspace }) => {
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
  for (const [id, x, y] of [["missing-move", 200, 180], ["missing-transform", 500, 180], ["missing-keys", 200, 410], ["protected-shape", 500, 410]] as const) {
    await execute("shape.create", { id, content: { shapeType: "rectangle", shortText: id, fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 },
      pose: { x, y, width: 200, height: 120 } });
  }
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") && response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await read(), protectedShape = original.shapes.find((value: any) => value.id === "protected-shape");
  await page.getByRole("button", { name: "新建研究", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect.poll(() => page.getByRole("tab", { selected: true }).getAttribute("title")).not.toBe(projectId);
  const otherId = (await page.getByRole("tab", { selected: true }).getAttribute("title"))!;
  const tab = (id: string) => page.locator('[role="tab"][title="' + id + '"]');
  await tab(projectId).click(); await expect(tab(projectId)).toHaveAttribute("aria-selected", "true");
  type Scenario = { kind: string; shape: any; attempts: any[]; gate: Promise<void>; release: () => void };
  let active: Scenario | null = null, failRead = false, failedReads = 0;
  const releases: (() => void)[] = [];
  await page.route("**/api/mapping/projects/" + projectId + "/map?**", async route => {
    const url = new URL(route.request().url());
    if (failRead && url.searchParams.get("view") === "index" && !url.searchParams.has("snapshot")) {
      failRead = false; const response = await route.fetch(); expect(response.status()).toBe(200); failedReads++;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "UNAVAILABLE", message: "目标删除确认读取暂未完成" }) });
    } else await route.continue();
  });
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON(), current = active;
    if (!current || !["shape.move", "shape.transform"].includes(command?.type) || command.payload.id !== current.shape.id) { await route.continue(); return; }
    if (current.kind === "not-found" && current.attempts.length === 0) {
      const body = { code: "UNAVAILABLE", message: "几何提交前503，结果尚未确认" };
      current.attempts.push({ command, status: 503, body });
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(body) }); return;
    }
    if (current.kind === "conflict" && current.attempts.length === 0)
      await execute("shape.move", { id: current.shape.id, x: current.shape.item.pose.x + 60, y: current.shape.item.pose.y + 30 }, current.shape.item.versionId);
    const response = await route.fetch(), body = await response.json();
    current.attempts.push({ command, status: response.status(), body });
    if (current.kind === "not-found" && current.attempts.length === 2) failRead = true;
    if (current.kind !== "not-found" && current.attempts.length === 1) await current.gate;
    await route.fulfill({ response });
  });
  const panel = page.getByRole("region", { name: "形状调整目标已删除", exact: true });
  const cancel = page.getByRole("button", { name: "取消本次调整", exact: true });
  const drag = async (shape: any, resize: boolean) => {
    await page.getByRole("img", { name: shape.content.shortText, exact: true }).click();
    expect(await page.locator(".react-flow__viewport").evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)).toBe(1);
    const target = resize ? page.getByRole("button", { name: "调整形状尺寸：左上", exact: true }) : page.getByRole("img", { name: shape.content.shortText, exact: true });
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + (resize ? -24 : 48), box.y + box.height / 2 + (resize ? -16 : 32), { steps: 5 }); await page.mouse.up();
  };
  try {
    for (const [id, kind] of [["missing-move", "not-found"], ["missing-transform", "conflict"], ["missing-keys", "keys"]]) {
      const before = await read(), beforeHistory = await read("/history"), shape = before.shapes.find((value: any) => value.id === id);
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
      const current: Scenario = { kind, shape, attempts: [], gate, release }; active = current;
      const retry = page.getByRole("button", { name: kind === "not-found" ? "重试保存形状位置" : "重试保存形状尺寸", exact: true });
      if (kind === "keys") {
        await page.getByRole("img", { name: shape.content.shortText, exact: true }).click();
        const handle = page.getByRole("button", { name: "调整形状尺寸：左上", exact: true }); await handle.focus(); await handle.press("ArrowLeft");
        await expect.poll(() => current.attempts.length).toBe(1);
        expect(current.attempts[0].status).toBe(200); await handle.press("Shift+ArrowUp");
      } else await drag(shape, kind === "conflict");
      await expect.poll(() => current.attempts.length).toBe(1);
      const first = current.attempts[0], priorDelete = await read();
      if (kind === "not-found") {
        await expect(page.locator(".save-state").getByRole("alert")).toContainText("几何提交前503");
        expect(priorDelete).toEqual(before); expect(await read("/history")).toEqual(beforeHistory); await expect(cancel).toHaveCount(0);
      } else if (kind === "conflict") expect(first).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
      else {
        expect(first.command).toMatchObject({ projectId, type: "shape.transform", expected: shape.item.versionId,
          payload: { id, pose: { ...shape.item.pose, x: shape.item.pose.x - 1, width: shape.item.pose.width + 1 } } });
        expect(priorDelete.project.revision).toBe(before.project.revision + 1);
      }
      const target = priorDelete.shapes.find((value: any) => value.id === id);
      await execute("shape.delete", { id }, { shape: target.versionId, pose: target.item.versionId });
      const deleted = await read(), deletedHistory = await read("/history");
      await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(deleted.project.revision));
      await expect(page.locator('.react-flow__node[data-id="' + shape.item.id + '"]')).toHaveCount(0);
      if (kind === "not-found") {
        await expect(cancel).toHaveCount(0); await retry.click();
        await expect.poll(() => current.attempts.length).toBe(2); await expect(retry).toBeEnabled();
        expect(current.attempts[1]).toMatchObject({ command: first.command, status: 404, body: { code: "NOT_FOUND" } });
        await expect(cancel, "确认读取失败时不能丢弃原请求").toHaveCount(0);
        await retry.click(); await expect.poll(() => current.attempts.length).toBe(3);
        expect(current.attempts[2]).toEqual(current.attempts[1]);
      } else release();
      await expect(panel, "明确确认目标删除后必须提供保留已确认历史的显式取消出口").toBeVisible();
      await expect(cancel).toBeEnabled();
      if (kind === "not-found") expect(failedReads).toBe(1);
      expect(await read()).toEqual(deleted); expect(await read("/history")).toEqual(deletedHistory);
      await tab(otherId).click(); await expect(tab(projectId)).toHaveAttribute("aria-selected", "true");
      const attemptsBeforeCancel = current.attempts.length;
      await cancel.click(); await expect(panel).toHaveCount(0); await expect(cancel).toHaveCount(0);
      await expect(page.getByRole("status")).toHaveText("已保存到本机"); await expect(retry).toHaveCount(0);
      expect(await read()).toEqual(deleted); expect(await read("/history")).toEqual(deletedHistory);
      await tab(otherId).click(); await expect(tab(otherId)).toHaveAttribute("aria-selected", "true");
      await tab(projectId).click(); await expect(tab(projectId)).toHaveAttribute("aria-selected", "true");
      await page.getByRole("img", { name: protectedShape.content.shortText, exact: true }).click();
      await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "形状文字", exact: true }); await expect(editor).toHaveValue(protectedShape.content.shortText);
      await editor.press("Escape"); await expect(editor).toHaveCount(0);
      expect(await read()).toEqual(deleted); expect(await read("/history")).toEqual(deletedHistory);
      expect(current.attempts).toHaveLength(attemptsBeforeCancel);
      if (kind !== "not-found") expect(current.attempts).toHaveLength(1);
      expect(deleted.cards).toEqual(original.cards); expect(deleted.texts).toEqual(original.texts); expect(deleted.tags).toEqual(original.tags);
      expect(deleted.shapes.find((value: any) => value.id === protectedShape.id)).toEqual(protectedShape); active = null;
    }
    const beforeFinal = await read(), beforeFinalHistory = await read("/history");
    expect(beforeFinal.shapes).toEqual([protectedShape]);
    const handle = page.getByRole("button", { name: "调整形状尺寸：左上", exact: true }); await handle.focus(); await handle.press("ArrowLeft");
    const pose = { ...protectedShape.item.pose, x: protectedShape.item.pose.x - 1, width: protectedShape.item.pose.width + 1 };
    await expect.poll(async () => (await read()).shapes[0].item.pose).toEqual(pose);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const final = await read(); expect(final.project.revision).toBe(beforeFinal.project.revision + 1);
    expect(final.shapes[0]).toMatchObject({ id: protectedShape.id, content: protectedShape.content, versionId: protectedShape.versionId,
      item: { id: protectedShape.item.id, createdOrder: protectedShape.item.createdOrder, pose } });
    expect((await read("/history")).undo).toHaveLength(beforeFinalHistory.undo.length + 1);
    expect(final.cards).toEqual(original.cards); expect(final.texts).toEqual(original.texts); expect(final.tags).toEqual(original.tags);
    await page.reload(); await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect(cancel).toHaveCount(0); expect(await read()).toEqual(final);
  } finally { for (const release of releases) release(); await page.unrouteAll({ behavior: "wait" }); }
});
