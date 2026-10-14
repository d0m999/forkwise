import { writeFileSync } from "node:fs";
import { test, expect, place } from "./card-appearance-fixture";

test("A9-13 同标题进入原生编辑不产生几何动作，组合中未确认标题不写必要高度", async ({
  page,
  workspace,
}, info) => {
  await place(page, "初始短标题");
  const before = await workspace.state();
  const commands: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mapping/execute"))
      commands.push(r.postDataJSON());
  });
  await page.getByRole("button", { name: "编辑标题", exact: true }).click();
  const editor = page.getByLabel("卡片标题", { exact: true });
  await editor.focus();
  await page.evaluate(() =>
    document.fonts.ready.then(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    ),
  );
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const dom = await editor.evaluate((el) => ({
    offsetHeight: (el as HTMLElement).offsetHeight,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    style: getComputedStyle(el).cssText,
    border: getComputedStyle(el).borderWidth,
  }));
  const observation = JSON.stringify({
    before,
    after: await workspace.state(),
    dom,
    commands,
  });
  writeFileSync(info.outputPath("native-title-measurement.json"), observation, {
    mode: 0o600,
  });
  await info.attach("native-title-measurement", {
    body: observation,
    contentType: "application/json",
  });
  expect((await workspace.state()).cards[0]!.item).toEqual(
    before.cards[0]!.item,
  );
  expect(commands).toEqual([]);
  await editor.dispatchEvent("compositionstart");
  await editor.fill("第一行\n第二行\n第三行\n尚未确认");
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  expect((await workspace.state()).cards[0]!.item).toEqual(
    before.cards[0]!.item,
  );
  expect(commands).toEqual([]);
  // Synthetic composition verifies the coordinator, not OS IME acceptance.
});
