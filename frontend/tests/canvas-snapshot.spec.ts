import { expect, test } from "./writing-board-fixture";
import { preserveClipboard } from "./clipboard-fixture";

test("键盘与菜单完成复制副本、冻结粘贴、独立编辑和保存重开", async ({ page, workspace }, info) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: "seed-card", projectId, type: "thought.create", expected: null,
    payload: { id: "origin", title: "市场观察", text: "需求增长", x: 80, y: 120 } });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  page.on('console', message => { if (message.text().startsWith('ISSUE30_PASTE_EVENT')) console.log(message.text()); });
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'canvas.paste')
      console.log('ISSUE30_PASTE_SEND', JSON.stringify({ at: Date.now(), commandId: request.postDataJSON().commandId }));
  });
  page.on('response', response => {
    const request = response.request();
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'canvas.paste')
      console.log('ISSUE30_PASTE_ACK', JSON.stringify({ at: Date.now(), commandId: request.postDataJSON().commandId, status: response.status() }));
  });
  await page.evaluate(() => window.addEventListener('paste', event => {
    const observation = { at: Date.now(), trusted: event.isTrusted, status: document.querySelector('[role=status]')?.textContent,
      types: [...(event.clipboardData?.types ?? [])] };
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(event.clipboardData?.getData('text/plain') ?? '')).then(hash =>
      console.log('ISSUE30_PASTE_EVENT', JSON.stringify({ ...observation, textSha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') })));
  }, true));
  const guard = await preserveClipboard(page, info, "市场观察");
  try {
    const origin = (await workspace.state()).cards[0]!;
    await page.getByRole("button", { name: "市场观察", exact: true }).click();
    await page.keyboard.press("Meta+d");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(2);
    const duplicated = (await workspace.state()).cards.find(card => card.id !== origin.id)!;
    expect(duplicated.title).toBe("市场观察");
    expect(duplicated.body.blocks.map(block => block.text).join("")).toBe("需求增长");
    expect(duplicated.body.id).not.toBe(origin.body.id);
    expect(duplicated.item.pose).toEqual({ x: origin.item.pose.x + 24, y: origin.item.pose.y + 24, width: origin.item.pose.width, height: origin.item.pose.height });
    await expect(page.locator(`.react-flow__node.selected`)).toHaveCount(1);
    await expect(page.locator(`.react-flow__node.selected`)).toHaveAttribute("data-id", duplicated.item.id);
    const history = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
    expect(history.undo.at(-1).label).toBe("canvas.duplicate");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await workspace.state()).cards.map(card => card.id)).toEqual([origin.id]);
    await expect(page.getByRole("button", { name: "市场观察", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "市场观察", exact: true }).click();
    await page.keyboard.press("Meta+c");
    await expect.poll(async () => page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find(value => value.types.includes("web application/x-forkwise-canvas"));
      return item ? (await item.getType("web application/x-forkwise-canvas")).text() : "";
    })).toContain("\"title\":\"市场观察\"");
    await page.getByRole("button", { name: "市场观察", exact: true }).dblclick();
    await page.getByLabel("卡片标题", { exact: true }).fill("需求下降");
    await page.getByLabel("卡片标题", { exact: true }).press("Enter");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const pane = (await page.locator(".react-flow__pane").boundingBox())!;
    await page.mouse.move(pane.x + 420, pane.y + 260);
    await page.locator(".canvas").press("Meta+v");
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(2);
    const pasted = (await workspace.state()).cards.find(card => card.id !== origin.id)!;
    expect(pasted.title).toBe("市场观察");
    expect(pasted.body.blocks.map(block => block.text).join("")).toBe("需求增长");
    expect((await workspace.state()).cards.find(card => card.id === origin.id)!.title).toBe("需求下降");
    await page.mouse.move(pane.x + 420, pane.y + 260);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.locator(".canvas").press("Meta+v");
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(3);
    const third = (await workspace.state()).cards.find(card => card.id !== origin.id && card.id !== pasted.id)!;
    expect(third.item.pose.x).toBeCloseTo(pasted.item.pose.x + 24, 0);
    expect(third.item.pose.y).toBeCloseTo(pasted.item.pose.y + 24, 0);
    await page.locator(`.react-flow__node[data-id="${pasted.item.id}"]`).getByRole("button", { name: "市场观察", exact: true }).dblclick({ force: true });
    await page.getByLabel("卡片标题", { exact: true }).fill("副本自改");
    await page.getByLabel("卡片标题", { exact: true }).press("Enter");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    expect((await workspace.state()).cards.find(card => card.id === origin.id)!.title).toBe("需求下降");
    await guard.restore();
    await workspace.restart();
    await page.reload();
    await expect(page.getByRole("button", { name: "副本自改", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "需求下降", exact: true })).toBeVisible();

    const text = "外部研究文字";
    await page.locator(".react-flow__pane").evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    await expect.poll(async () => (await workspace.state()).cards.some(card => card.title === "" && card.body.blocks.some(block => block.text === text))).toBe(true);
  } catch (error) {
    await guard.restore().catch(() => undefined);
    throw error;
  }
});

test("整组选中时不提供复制入口，成员单独复制仍在组外", async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: "seed-a", projectId, type: "text.create", expected: null, payload: {
    id: "note", content: { runs: [{ text: "说明" }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: 120 },
    pose: { x: 80, y: 80, width: 120, height: 40 } } });
  await workspace.execute(page, { commandId: "seed-b", projectId, type: "shape.create", expected: null, payload: {
    id: "mark", content: { shapeType: "ellipse", shortText: "标记" }, pose: { x: 240, y: 80, width: 100, height: 60 } } });
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  const state = await workspace.state();
  const note = state.texts!.find(value => value.id === "note")!;
  const mark = state.shapes!.find(value => value.id === "mark")!;
  await page.locator(`.react-flow__node[data-id="${note.item.id}"]`).click();
  await page.locator(`.react-flow__node[data-id="${mark.item.id}"]`).click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "组合所选对象", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const grouped = (await workspace.state()).texts!.length;
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "复制副本", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "粘贴", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+d");
  await expect.poll(async () => (await workspace.state()).texts!.length).toBe(grouped);
  await page.getByRole("button", { name: "进入组合", exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${note.item.id}"]`).click();
  await page.getByRole("button", { name: "复制", exact: true }).click();
  await page.getByRole("menuitem", { name: "复制副本", exact: true }).click();
  await expect.poll(async () => (await workspace.state()).texts!.length).toBe(grouped + 1);
  const copy = (await workspace.state()).texts!.find(value => value.id !== note.id)!;
  expect((await workspace.state()).groups![0]!.memberItemIds).toEqual([note.item.id, mark.item.id]);
  expect((await workspace.state()).containment!.some(value => value.id === copy.item.id)).toBe(false);
});
