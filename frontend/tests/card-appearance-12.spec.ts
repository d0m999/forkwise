import { test, expect, place } from "./card-appearance-fixture";

test("A9-12 收紧卡后续保存完整正文不自动增高或写Pose，预览使用现有空间", async ({
  page,
  workspace,
}) => {
  await place(page, "收紧标题");
  const before = (await workspace.state()).cards[0]!;
  expect(before.item.pose.height).toBeLessThan(80);
  await page.getByRole("button", { name: "写字板", exact: true }).click();
  const full = Array.from(
    { length: 40 },
    (_, i) => `完整正文第${i + 1}行`,
  ).join("\n");
  await page.getByLabel("卡片正文", { exact: true }).fill(full);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.body.blocks.map(b => b.text).join("\n"))
    .toBe(full);
  await expect
    .poll(async () => (await workspace.state()).cards[0]!.item)
    .toEqual(before.item);
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  expect((await workspace.state()).cards[0]!.item).toEqual(before.item);
});
