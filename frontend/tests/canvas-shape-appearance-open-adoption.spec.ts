import { test, expect } from "./writing-board-fixture";

test("普通打开与恢复外观并发时仅首入口接管，其他完整草稿仍可依次恢复", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown) => workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId, type, expected: null, payload,
  });
  await execute("thought.create", { id: "protected-card", title: "保护卡片", text: "保护正文", x: 1050, y: 100 });
  await execute("text.create", { id: "protected-text", content: {
    runs: [{ text: "保护独立文字" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 190,
  }, pose: { x: 1050, y: 420, width: 190, height: 27 } });
  const aContent = { shapeType: "rectangle", shortText: "普通打开A", fill: "#ffffff" };
  const drafts = [
    { id: "draft-b", original: { shapeType: "diamond", shortText: "独立草稿B😀" }, fields: ["#dbeafe", "#1d4ed8", "3"],
      content: { shapeType: "diamond", shortText: "独立草稿B😀", fill: "#dbeafe", stroke: "#1d4ed8", strokeWidth: 3 } },
    { id: "draft-c", original: { shapeType: "ellipse", shortText: "独立草稿C\n保持原样", strokeWidth: 1 }, fields: ["#dcfce7", "#166534", "5"],
      content: { shapeType: "ellipse", shortText: "独立草稿C\n保持原样", fill: "#dcfce7", stroke: "#166534", strokeWidth: 5 } },
  ];
  await execute("shape.create", { id: "normal-a", content: aContent, pose: { x: 210, y: 200, width: 200, height: 120 } });
  for (const [index, draft] of drafts.entries()) await execute("shape.create", {
    id: draft.id, content: draft.original, pose: { x: 490 + index * 280, y: 200, width: 200, height: 120 },
  });
  const layout = page.waitForResponse(response => response.url().endsWith("/api/mapping/execute") &&
    response.request().postDataJSON()?.type === "card.layout");
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const original = await workspace.state() as any;
  const history = async () => {
    const response = await page.request.get(workspace.origin + "/api/mapping/projects/" + projectId + "/history");
    expect(response.status()).toBe(200); return response.json();
  };
  const originalHistory = await history();
  const dialog = page.getByRole("dialog", { name: "形状外观", exact: true });
  const fill = dialog.getByRole("textbox", { name: "填充颜色", exact: true });
  const stroke = dialog.getByRole("textbox", { name: "轮廓颜色", exact: true });
  const width = dialog.getByRole("spinbutton", { name: "轮廓粗细", exact: true });
  const restore = page.getByRole("button", { name: "恢复形状外观草稿", exact: true });
  for (const [index, draft] of drafts.entries()) {
    await page.getByRole("img", { name: draft.original.shortText, exact: true }).click();
    await page.getByRole("button", { name: "形状外观", exact: true }).click();
    await fill.fill(draft.fields[0]!); await stroke.fill(draft.fields[1]!); await width.fill(draft.fields[2]!);
    page.once("dialog", async event => { expect(event.type()).toBe("beforeunload"); await event.accept(); });
    await page.reload(); await expect(restore).toHaveCount(index + 1);
  }
  expect(await workspace.state()).toEqual(original); expect(await history()).toEqual(originalHistory);
  let releaseText!: () => void, enteredText!: () => void;
  const textGate = new Promise<void>(resolve => { releaseText = resolve; });
  const textStarted = new Promise<void>(resolve => { enteredText = resolve; });
  const edits: { command: any; receipt: any }[] = [];
  await page.route("**/api/mapping/execute", async route => {
    const command = route.request().postDataJSON();
    if (command?.type !== "shape.edit") { await route.continue(); return; }
    const response = await route.fetch(); edits.push({ command, receipt: await response.json() });
    if (command.payload.id === "normal-a") { enteredText(); await textGate; }
    await route.fulfill({ response });
  });
  const mapPattern = "**/api/mapping/projects/" + projectId + "/map?**";
  let rootReads = 0, competingSnapshot: string | undefined, competingRead = false, finishedCompeting!: () => void;
  const competingFinished = new Promise<void>(resolve => { finishedCompeting = resolve; });
  // Observe an actual competing authorization read if the old implementation
  // admits it. The corrected implementation must not issue that second read.
  const firstMapRoute = async (route: any) => {
    const url = new URL(route.request().url()), response = await route.fetch();
    if (url.searchParams.get("view") === "index" && !url.searchParams.has("snapshot") && ++rootReads === 2) {
      competingRead = true; competingSnapshot = (await response.json()).snapshot;
    }
    const last = competingSnapshot && url.searchParams.get("snapshot") === competingSnapshot && url.searchParams.get("view") === "stroke-index";
    await route.fulfill({ response }); if (last) finishedCompeting();
  };
  await page.route(mapPattern, firstMapRoute);
  let releaseAuthorization = () => {};
  try {
    await page.getByRole("img", { name: aContent.shortText, exact: true }).click();
    await page.getByRole("button", { name: "编辑形状文字", exact: true }).click();
    const shortText = "A自己的确认全文😀\n原样保留";
    const editor = page.getByRole("textbox", { name: "形状文字", exact: true });
    await editor.fill(shortText);
    await page.getByRole("button", { name: "形状外观", exact: true }).click(); await textStarted;
    await restore.nth(0).click(); await expect(dialog).toHaveCount(0);
    releaseText(); await expect(dialog).toBeVisible(); await expect(editor).toHaveCount(0);
    await expect(fill).toHaveValue("#ffffff");
    if (competingRead) await competingFinished;
    await fill.fill("#fef3c7");
    await dialog.getByRole("button", { name: "关闭形状外观", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(restore, "普通打开先接管后取消，不得吞掉另一入口选中的原草稿").toHaveCount(2);
    await page.unroute(mapPattern, firstMapRoute);
    expect(edits).toHaveLength(1);
    const afterText = await workspace.state() as any, afterTextHistory = await history();
    const a = original.shapes.find((shape: any) => shape.id === "normal-a");
    expect(afterText.shapes.find((shape: any) => shape.id === a.id)).toMatchObject({ id: a.id, item: a.item, content: { ...aContent, shortText } });
    expect(afterText.shapes.find((shape: any) => shape.id === a.id).versionId).toBe(edits[0].receipt.shapeVersions.shape);
    for (const draft of drafts) expect(afterText.shapes.find((shape: any) => shape.id === draft.id)).toEqual(original.shapes.find((shape: any) => shape.id === draft.id));
    let enteredAuthorization!: () => void, held = false;
    const authorizationGate = new Promise<void>(resolve => { releaseAuthorization = resolve; });
    const authorizationStarted = new Promise<void>(resolve => { enteredAuthorization = resolve; });
    await page.route(mapPattern, async route => {
      const url = new URL(route.request().url());
      if (!held && url.searchParams.get("view") === "index" && !url.searchParams.has("snapshot")) {
        held = true; const response = await route.fetch(); enteredAuthorization(); await authorizationGate; await route.fulfill({ response });
      } else await route.continue();
    });
    await restore.nth(0).click(); await authorizationStarted;
    await page.getByRole("button", { name: "形状外观", exact: true }).click();
    await expect(dialog, "恢复授权读取未完成时，普通打开不得越过已取得的入口").toHaveCount(0);
    expect(await workspace.state()).toEqual(afterText); expect(await history()).toEqual(afterTextHistory);
    releaseAuthorization(); await expect(dialog).toBeVisible();
    const visibleFill = await fill.inputValue();
    const selected = drafts.find(draft => draft.fields[0] === visibleFill);
    expect(selected, "恢复应完整显示实际选择的一份B或C草稿").toBeDefined();
    const remaining = drafts.find(draft => draft.id !== selected!.id)!;
    await expect(stroke).toHaveValue(selected!.fields[1]!); await expect(width).toHaveValue(selected!.fields[2]!);
    await dialog.getByRole("button", { name: "重试保存形状外观", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(restore).toHaveCount(1);
    const firstSaved = await workspace.state() as any;
    expect(firstSaved.shapes.find((shape: any) => shape.id === selected!.id)).toMatchObject({
      content: selected!.content, item: original.shapes.find((shape: any) => shape.id === selected!.id).item });
    expect(firstSaved.shapes.find((shape: any) => shape.id === remaining.id)).toEqual(original.shapes.find((shape: any) => shape.id === remaining.id));
    await restore.click(); await expect(dialog).toBeVisible();
    await expect(fill).toHaveValue(remaining.fields[0]!); await expect(stroke).toHaveValue(remaining.fields[1]!); await expect(width).toHaveValue(remaining.fields[2]!);
    await dialog.getByRole("button", { name: "重试保存形状外观", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(restore).toHaveCount(0); expect(edits).toHaveLength(3);
    const saved = await workspace.state() as any;
    expect(saved.shapes).toHaveLength(3);
    expect(saved.shapes.find((shape: any) => shape.id === a.id)).toEqual(afterText.shapes.find((shape: any) => shape.id === a.id));
    for (const draft of drafts) {
      const base = original.shapes.find((shape: any) => shape.id === draft.id), command = edits.find(edit => edit.command.payload.id === draft.id)!;
      expect(command.command).toMatchObject({ projectId, type: "shape.edit", expected: base.versionId, payload: { id: draft.id, content: draft.content } });
      expect(command.command.payload.content).toEqual(draft.content);
      expect(saved.shapes.find((shape: any) => shape.id === draft.id)).toMatchObject({ id: draft.id, item: base.item, content: draft.content, versionId: command.receipt.shapeVersions.shape });
    }
    expect(saved.project.revision).toBe(original.project.revision + 3);
    expect(saved.cards).toEqual(original.cards); expect(saved.texts).toEqual(original.texts); expect(saved.tags).toEqual(original.tags);
    expect((await history()).undo.filter((action: any) => action.label === "shape.edit")).toHaveLength(3);
    await page.reload(); await expect(restore).toHaveCount(0);
    await expect(page.locator(".workspace")).toHaveAttribute("data-revision", String(saved.project.revision));
    expect(await workspace.state()).toEqual(saved);
  } finally { releaseText(); releaseAuthorization(); await page.unrouteAll({ behavior: "wait" }); }
});
