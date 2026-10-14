import { test, expect, place } from "./card-appearance-fixture";

test("A9-04 同一完整Body的预览只显示整行，放大显示更多，全文不撑高且开关不删原文", async ({
  page,
  workspace,
}, info) => {
  await place(page, "有限预览");
  await page.getByRole("button", { name: "写字板", exact: true }).click();
  const text = Array.from(
    { length: 60 },
    (_, i) =>
      `第${i + 1}行：完整正文包含足够多的中文来换行，不删除或另存摘要。`,
  ).join("\n");
  await page.getByLabel("卡片正文", { exact: true }).fill(text);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBe(160);
  const preview = page.locator(".preview");
  await expect(preview).toHaveText(text);
  const before = await preview.evaluate((el) => ({
    lines: Number((el as HTMLElement).dataset.previewLines),
    height: el.clientHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(before.lines).toBeGreaterThan(0);
  expect(before.height).toBe(before.lines * before.lineHeight);
  const handle = page.getByRole("button", {
    name: "调整卡片尺寸：下",
    exact: true,
  });
  await handle.focus();
  for (let i = 0; i < 6; i++) {
    await handle.press("ArrowDown");
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
  }
  await expect
    .poll(async () => Number(await preview.getAttribute("data-preview-lines")))
    .toBeGreaterThan(before.lines);
  const box = (await preview.boundingBox())!,
    node = (await page.locator(".thought-card").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(node.y + node.height);
  expect(
    await preview.evaluate(
      (el) => el.clientHeight % parseFloat(getComputedStyle(el).lineHeight),
    ),
  ).toBe(0);
  const full = await workspace.state();
  expect(full.cards[0]!.body.blocks[0]!.text).toBe(text);
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByLabel("显示正文预览", { exact: true }).uncheck();
  await expect(preview).toHaveCount(0);
  await expect
    .poll(
      async () => (await workspace.state()).cards[0]!.appearance?.showPreview,
    )
    .toBe(false);
  expect((await workspace.state()).cards[0]!.body).toEqual(full.cards[0]!.body);
  await page.getByLabel("显示正文预览", { exact: true }).check();
  await expect(preview).toHaveText(text);
  await page.keyboard.press("Escape");
  await page.getByLabel("卡片正文", { exact: true }).fill("");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBe(full.cards[0]!.item.pose.height);
  await expect(preview).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("whole-lines-preview.png") });
  await info.attach("whole-lines-geometry", {
    body: JSON.stringify({ before, full, previewBox: box, cardBox: node }),
    contentType: "application/json",
  });
});
