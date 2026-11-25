import { test, expect, place } from "./card-appearance-fixture";

test("默认短卡在写字板首次保存两段后提供有限正文预览，清空和重开保持实际高度", async ({
  page,
  workspace,
}, info) => {
  await place(page, "库存观察");
  const card = page.locator(".thought-card");
  const preview = card.locator(".preview");
  const state = async () => (await workspace.state()).cards[0]!;
  const initial = await workspace.state();
  const empty = initial.cards[0]!;
  const historyUrl = `${workspace.origin}/api/mapping/projects/${initial.project.id}/history`;
  const readHistory = async () => (await page.request.get(historyUrl)).json();
  const priorHistory = await readHistory();
  expect(empty.item.pose.height).toBeLessThan(80);
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "写字板", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "卡片正文", exact: true });
  await editor.fill("库存回落");
  await editor.press("End");
  await editor.press("Enter");
  await page.keyboard.insertText("等待新财报");
  const paragraphs = ["库存回落", "等待新财报"];
  await expect.poll(async () => (await state()).body.blocks.map(block => block.text)).toEqual(paragraphs);
  await expect.poll(async () => (await state()).item.pose).toEqual({ ...empty.item.pose, height: 160 });
  await expect(preview).toHaveText(paragraphs.join("\n"));
  await expect.poll(() => preview.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = element.getBoundingClientRect();
    const lines = [...range.getClientRects()].filter(rect => rect.width > 0);
    return lines.filter(line => line.top >= box.top && line.bottom <= box.bottom).length;
  })).toBe(2);
  await page.getByRole("button", { name: "关闭正文", exact: true }).click();
  const firstWriting = (await readHistory()).undo.slice(priorHistory.undo.length);
  expect(firstWriting.length).toBeGreaterThan(0);
  expect(firstWriting.map((action: { label: string }) => action.label)).toEqual(firstWriting.map(() => "body.edit"));
  await page.screenshot({ path: info.outputPath("two-paragraph-preview.png") });
  for (let i = firstWriting.length; i > 0; i--) {
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(async () => (await readHistory()).undo.length).toBe(priorHistory.undo.length + i - 1);
    expect((await state()).item.pose).toEqual({ ...empty.item.pose, height: i === 1 ? empty.item.pose.height : 160 });
  }
  await expect.poll(async () => (await state()).body.blocks).toEqual(empty.body.blocks);
  await expect(preview).toHaveCount(0);
  for (let i = 1; i <= firstWriting.length; i++) {
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await expect.poll(async () => (await readHistory()).undo.length).toBe(priorHistory.undo.length + i);
    expect((await state()).item.pose.height).toBe(160);
  }
  await expect(preview).toHaveText(paragraphs.join("\n"));
  await card.getByRole("button", { name: "编辑正文", exact: true }).click();

  const full = Array.from({ length: 40 }, (_, i) => `完整正文第${i + 1}行`).join("\n");
  await editor.fill(full);
  await expect.poll(async () => (await state()).body.blocks.map(block => block.text).join("\n")).toBe(full);
  expect((await state()).item.pose.height).toBe(160);
  const budget = await preview.evaluate(element => ({
    height: element.clientHeight,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    content: element.scrollHeight,
  }));
  expect(budget.height % budget.lineHeight).toBe(0);
  expect(budget.content).toBeGreaterThan(budget.height);

  await editor.fill("");
  await expect.poll(async () => (await state()).item.pose).toEqual(empty.item.pose);
  await expect(preview).toHaveCount(0);
  await editor.fill("重新写入");
  await expect.poll(async () => (await state()).item.pose.height).toBe(160);
  await expect(preview).toHaveText("重新写入");

  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("显示正文预览", { exact: true }).uncheck();
  await expect(preview).toHaveCount(0);
  await editor.fill("关闭预览后保存的全文");
  await expect.poll(async () => (await state()).body.blocks.map(block => block.text)).toEqual(["关闭预览后保存的全文"]);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = await state();
  await workspace.restart();
  await workspace.open(page);
  expect(await state()).toEqual(saved);
  await expect(preview).toHaveCount(0);
  await card.locator(".title-button").click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("显示正文预览", { exact: true }).check();
  await expect(preview).toHaveText("关闭预览后保存的全文");
});

test("关闭预览的空卡首写仍保持紧凑，开启后显示已保存两段", async ({ page, workspace }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await place(page, "库存观察");
  const card = page.locator(".thought-card");
  const state = async () => (await workspace.state()).cards[0]!;
  const before = await state();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("显示正文预览", { exact: true }).uncheck();
  await expect.poll(async () => (await state()).appearance?.showPreview).toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "写字板", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "卡片正文", exact: true });
  await editor.fill("库存回落");
  await editor.press("End");
  await editor.press("Enter");
  await page.keyboard.insertText("等待新财报");
  await expect.poll(async () => (await state()).body.blocks.map(block => block.text)).toEqual(["库存回落", "等待新财报"]);
  const saved = await state();
  expect(saved.item).toEqual(before.item);
  await page.getByRole("button", { name: "关闭正文", exact: true }).click();
  await expect(card.locator(".preview")).toHaveCount(0);
  await card.locator(".title-button").click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("显示正文预览", { exact: true }).check();
  await expect.poll(async () => (await state()).item.pose).toEqual({ ...before.item.pose, height: 160 });
  await expect(card.locator(".preview")).toHaveText("库存回落\n等待新财报");
  expect((await state()).body).toEqual(saved.body);
});
