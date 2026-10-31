import { expect, test } from "./writing-board-fixture";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAMSURBVAiZY2CgHAAAAEQAAYL+ZUsAAAAASUVORK5CYII=";

function order(state: any) {
  return [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? [])]
    .sort((a, b) => (a.item.createdOrder ?? 0) - (b.item.createdOrder ?? 0))
    .map(value => value.item.id);
}
async function undoLength(page: any, workspace: any) {
  const state = await workspace.state();
  return (await (await page.request.get(`${workspace.origin}/api/mapping/projects/${state.project.id}/history`)).json()).undo.length;
}
async function nodeBox(page: any, id: string) {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`节点不可见：${id}`);
  return box;
}
async function clickObject(page: any, id: string, modifiers: ("Shift" | "Control" | "Alt")[] = []) {
  const box = await nodeBox(page, id);
  const points: { x: number; y: number }[] = [
    { x: box.x + 1, y: box.y + 1 }, { x: box.x + 1, y: box.y + box.height / 2 },
    { x: box.x + 1, y: box.y + box.height - 1 }, { x: box.x + box.width - 1, y: box.y + 1 },
    { x: box.x + box.width - 1, y: box.y + box.height / 2 }, { x: box.x + box.width - 1, y: box.y + box.height - 1 },
    { x: box.x + box.width / 2, y: box.y + 1 }, { x: box.x + box.width / 2, y: box.y + box.height - 1 },
  ];
  const fractions = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
  for (const fy of fractions) for (const fx of fractions) points.push({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  for (const point of points) {
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return { target: element?.closest(".react-flow__node")?.getAttribute("data-id"),
        interactive: !!element?.closest("button, input, textarea, [contenteditable=true]") };
    }, point);
    if (hit.target === id && !hit.interactive) {
      await page.mouse.click(point.x, point.y, { modifiers });
      return;
    }
  }
  throw new Error(`没有可点击的空闲区域：${id}`);
}
async function deselect(page: any) {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.click(pane.x + pane.width - 30, pane.y + 30);
}
async function marqueeObjects(page: any, ids: string[]) {
  const boxes = await Promise.all(ids.map(id => nodeBox(page, id)));
  const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height));
  await page.mouse.move(left - 10, top - 10);
  await page.mouse.down();
  await page.mouse.move(right + 10, bottom + 10, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(ids.length);
}
async function overlapPoint(page: any, ids: string[]) {
  const boxes = await Promise.all(ids.map(id => nodeBox(page, id)));
  const left = Math.max(...boxes.map(box => box.x)), right = Math.min(...boxes.map(box => box.x + box.width));
  const top = Math.max(...boxes.map(box => box.y)), bottom = Math.min(...boxes.map(box => box.y + box.height));
  if (right <= left || bottom <= top) throw new Error("节点没有交集");
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
async function hitAt(page: any, point: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".react-flow__node")?.getAttribute("data-id"), point);
}
async function openLayer(page: any, toolbar: string) {
  await page.getByRole("toolbar", { name: toolbar, exact: true }).getByRole("button", { name: "层级", exact: true }).click();
}
async function chooseLayer(page: any, label: string) {
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
}
async function seed(page: any, workspace: any, values: { kind: "card" | "text" | "shape" | "image"; id: string; x: number; y: number; width: number; height: number }[]) {
  const projectId = (await workspace.state()).project.id;
  for (const value of values) {
    if (value.kind === "card")
      await workspace.execute(page, { commandId: `seed-${value.id}`, projectId, type: "thought.create", expected: null,
        payload: { id: value.id, title: value.id, text: "", x: value.x, y: value.y } });
    else if (value.kind === "text")
      await workspace.execute(page, { commandId: `seed-${value.id}`, projectId, type: "text.create", expected: null,
        payload: { id: value.id, content: { runs: [{ text: value.id }], fontSize: 18, lineHeight: 1.5, align: "left", widthMode: "fixed", width: value.width },
          pose: { x: value.x, y: value.y, width: value.width, height: value.height } } });
    else if (value.kind === "shape")
      await workspace.execute(page, { commandId: `seed-${value.id}`, projectId, type: "shape.create", expected: null,
        payload: { id: value.id, content: { shapeType: "rectangle", shortText: value.id },
          pose: { x: value.x, y: value.y, width: value.width, height: value.height } } });
    else {
      await workspace.execute(page, { commandId: `asset-${value.id}`, projectId, type: "asset.save", expected: null,
        payload: { id: `${value.id}-asset`, name: `${value.id}.png`, mime: "image/png", base64: png } });
      await workspace.execute(page, { commandId: `seed-${value.id}`, projectId, type: "image.create", expected: null,
        payload: { id: value.id, content: { assetId: `${value.id}-asset`, crop: { x: 0, y: 0, width: 1, height: 1 } },
          pose: { x: value.x, y: value.y, width: value.width, height: value.height, rotation: 0 } } });
    }
  }
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect(page.locator(".react-flow__node")).toHaveCount(values.length);
}
function itemIds(state: any, objectIds: string[]) {
  const all = [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? [])];
  return objectIds.map(id => all.find(value => value.id === id)!.item.id);
}

test("四类对象共用层级：纯卡临时置前、非卡保持遮挡、置底立即显示且暂停本次置前", async ({ page, workspace }) => {
  await seed(page, workspace, [
    { kind: "card", id: "a", x: 100, y: 80, width: 280, height: 160 },
    { kind: "image", id: "b", x: 120, y: 100, width: 200, height: 150 },
    { kind: "text", id: "c", x: 100, y: 100, width: 220, height: 60 },
    { kind: "shape", id: "d", x: 160, y: 100, width: 180, height: 120 },
  ]);
  const state = await workspace.state(), [a, b, c, d] = itemIds(state, ["a", "b", "c", "d"]);
  expect(order(state)).toEqual([a, b, c, d]);
  const overlap = await overlapPoint(page, [a, b, c, d]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(d);

  await clickObject(page, a);
  await expect(page.getByRole("toolbar", { name: "卡片操作", exact: true })).toBeVisible();
  await expect.poll(async () => hitAt(page, overlap)).toBe(a);

  await openLayer(page, "卡片操作");
  await expect(page.getByRole("menuitem", { name: "置顶", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "前移一层", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "置顶", exact: true })).toBeFocused();
  await chooseLayer(page, "置顶");
  await expect(page.getByRole("button", { name: "层级", exact: true })).toBeFocused();
  await expect.poll(async () => order(await workspace.state())).toEqual([b, c, d, a]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(a);

  const historyBefore = await undoLength(page, workspace), revisionBefore = (await workspace.state()).project.revision;
  await openLayer(page, "卡片操作");
  await expect(page.getByRole("menuitem", { name: "置顶", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "前移一层", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "后移一层", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "置底", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  expect(await undoLength(page, workspace)).toBe(historyBefore);
  expect((await workspace.state()).project.revision).toBe(revisionBefore);

  await openLayer(page, "卡片操作");
  await chooseLayer(page, "置底");
  await expect.poll(async () => order(await workspace.state())).toEqual([a, b, c, d]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(d);
  await expect(page.getByRole("toolbar", { name: "卡片操作", exact: true })).toBeVisible();

  await deselect(page);
  await expect.poll(async () => hitAt(page, overlap)).toBe(d);
  await clickObject(page, a);
  await expect.poll(async () => hitAt(page, overlap)).toBe(a);
  await deselect(page);
  await expect.poll(async () => hitAt(page, overlap)).toBe(d);

  await clickObject(page, c);
  await expect(page.getByRole("toolbar", { name: "独立文字样式", exact: true })).toBeVisible();
  await expect.poll(async () => hitAt(page, overlap)).toBe(d);
  await deselect(page);

  await clickObject(page, d);
  await openLayer(page, "形状操作");
  await chooseLayer(page, "后移一层");
  await expect.poll(async () => order(await workspace.state())).toEqual([a, b, d, c]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(c);
  await openLayer(page, "形状操作");
  await chooseLayer(page, "前移一层");
  await expect.poll(async () => order(await workspace.state())).toEqual([a, b, c, d]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(d);

  await deselect(page);
  await clickObject(page, c);
  await openLayer(page, "独立文字样式");
  await chooseLayer(page, "前移一层");
  await expect.poll(async () => order(await workspace.state())).toEqual([a, b, d, c]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(c);
  await openLayer(page, "独立文字样式");
  await chooseLayer(page, "后移一层");
  await expect.poll(async () => order(await workspace.state())).toEqual([a, b, c, d]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(d);
});

test("纯卡多选整体临时置前保内部顺序，置底后暂停并立即显示实际遮挡", async ({ page, workspace }) => {
  await seed(page, workspace, [
    { kind: "card", id: "a", x: 100, y: 100, width: 280, height: 160 },
    { kind: "card", id: "e", x: 130, y: 120, width: 280, height: 160 },
    { kind: "image", id: "b", x: 150, y: 110, width: 200, height: 100 },
  ]);
  const state = await workspace.state(), [a, e, b] = itemIds(state, ["a", "e", "b"]);
  expect(order(state)).toEqual([a, e, b]);
  const overlap = await overlapPoint(page, [a, e, b]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(b);

  await marqueeObjects(page, [a, e]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(e);
  await openLayer(page, "组合操作");
  await chooseLayer(page, "置顶");
  await expect.poll(async () => order(await workspace.state())).toEqual([b, a, e]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(e);
  await openLayer(page, "组合操作");
  await chooseLayer(page, "后移一层");
  await expect.poll(async () => order(await workspace.state())).toEqual([a, e, b]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(b);
  await deselect(page);
  await expect.poll(async () => hitAt(page, overlap)).toBe(b);
});

test("撤销重做、删除恢复、新建置顶、保存重开后UI与权威投影一致", async ({ page, workspace }) => {
  await seed(page, workspace, [
    { kind: "card", id: "a", x: 100, y: 80, width: 280, height: 160 },
    { kind: "image", id: "b", x: 120, y: 100, width: 200, height: 150 },
    { kind: "text", id: "c", x: 100, y: 100, width: 220, height: 60 },
    { kind: "shape", id: "d", x: 160, y: 100, width: 180, height: 120 },
  ]);
  const initial = await workspace.state(), [a, b, c, d] = itemIds(initial, ["a", "b", "c", "d"]);
  expect(order(initial)).toEqual([a, b, c, d]);

  await clickObject(page, a);
  await openLayer(page, "卡片操作");
  await chooseLayer(page, "置顶");
  await expect.poll(async () => order(await workspace.state())).toEqual([b, c, d, a]);

  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => order(await workspace.state())).toEqual([a, b, c, d]);
  const undoneOverlap = await overlapPoint(page, [a, b, c, d]);
  await expect.poll(async () => hitAt(page, undoneOverlap)).toBe(d);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect.poll(async () => order(await workspace.state())).toEqual([b, c, d, a]);
  const redoneOverlap = await overlapPoint(page, [a, b, c, d]);
  await expect.poll(async () => hitAt(page, redoneOverlap)).toBe(a);

  await workspace.restart();
  await workspace.open(page);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const reopenedOverlap = await overlapPoint(page, [a, b, c, d]);
  await expect.poll(async () => hitAt(page, reopenedOverlap)).toBe(a);
  expect(order(await workspace.state())).toEqual([b, c, d, a]);

  await clickObject(page, a);
  await page.getByRole("toolbar", { name: "卡片操作", exact: true }).getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("dialog", { name: "更多", exact: true }).getByRole("button", { name: "删除卡片", exact: true }).click();
  await expect.poll(async () => order(await workspace.state())).toEqual([b, c, d]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => order(await workspace.state())).toEqual([b, c, d, a]);
  const restoredOverlap = await overlapPoint(page, [a, b, c, d]);
  await expect.poll(async () => hitAt(page, restoredOverlap)).toBe(a);

  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 400 } });
  await page.getByLabel("卡片标题", { exact: true }).fill("新卡");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.locator(".react-flow__pane").click({ position: { x: pane.width - 40, y: pane.height - 40 } });
  const created = await workspace.state();
  expect(order(created).at(-1)).toBe(created.cards.find(value => value.title === "新卡")!.item.id);
});

test("组合与直选卡片形成混合选区时保持实际遮挡，不单独抬升卡片", async ({ page, workspace }) => {
  await seed(page, workspace, [
    { kind: "card", id: "c", x: 100, y: 80, width: 280, height: 160 },
    { kind: "card", id: "a", x: 120, y: 100, width: 280, height: 160 },
    { kind: "image", id: "b", x: 140, y: 100, width: 200, height: 150 },
  ]);
  const state = await workspace.state(), [c, a, b] = itemIds(state, ["c", "a", "b"]);
  await workspace.execute(page, {
    commandId: "group-mixed", projectId: state.project.id, type: "group.create", expected: {
      groups: { g: null },
      containment: Object.fromEntries([a, b].map(itemId => [itemId,
        state.containment.find((value: any) => value.id === itemId)?.versionId ?? null])),
    }, payload: { id: "g", itemIds: [a, b] },
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect(order(await workspace.state())).toEqual([c, a, b]);
  const overlap = await overlapPoint(page, [c, a, b]);
  await expect.poll(async () => hitAt(page, overlap)).toBe(b);

  await clickObject(page, b);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await page.waitForTimeout(350);
  await page.keyboard.down("Shift");
  await clickObject(page, c);
  await page.keyboard.up("Shift");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
  await expect.poll(async () => hitAt(page, overlap)).toBe(b);
});
