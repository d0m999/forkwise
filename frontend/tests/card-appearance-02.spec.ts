import { test, expect, place } from "./card-appearance-fixture";

test("A9-02 默认无正文收紧，完整标题必要增高并缩回，手调floor/undo/redo及重开保留", async ({
  page,
  workspace,
}, info) => {
  await place(page, "短标题");
  const node = page.locator(".react-flow__node");
  const initial = await workspace.state();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBeLessThan(80);
  const short = (await workspace.state()).cards[0]!;
  await expect(page.locator(".preview")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑标题", exact: true }).click();
  await page
    .getByLabel("卡片标题", { exact: true })
    .fill("第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBeGreaterThan(200);
  const tall = (await workspace.state()).cards[0]!;
  expect(tall.item.pose).toMatchObject({
    x: initial.cards[0]!.item.pose.x,
    y: initial.cards[0]!.item.pose.y,
    width: 280,
  });
  const titleBox = (await page.locator(".title-button").boundingBox())!,
    nodeBox = (await node.boundingBox())!;
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(
    nodeBox.y + nodeBox.height,
  );
  await page.getByRole("button", { name: "编辑标题", exact: true }).click();
  await page.getByLabel("卡片标题", { exact: true }).fill("短标题");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBe(short.item.pose.height);
  const handle = page.getByRole("button", {
    name: "调整卡片尺寸：下",
    exact: true,
  });
  await handle.focus();
  await handle.press("ArrowDown");
  await expect
    .poll(
      async () =>
        (await workspace.state()).cards[0]!.item.heightPolicy?.manualHeight,
    )
    .toBe(80);
  await page.getByRole("button", { name: "编辑标题", exact: true }).click();
  await page
    .getByLabel("卡片标题", { exact: true })
    .fill("甲\n乙\n丙\n丁\n戊\n己");
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBeGreaterThan(160);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBe(80);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item.pose.height)
    .toBeGreaterThan(160);
  const saved = await workspace.state();
  await page.reload();
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item)
    .toEqual(saved.cards[0]!.item);
  await page.screenshot({ path: info.outputPath("necessary-height.png") });
});
