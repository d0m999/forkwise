import { test, expect, place } from "./card-appearance-fixture";
import { writeFileSync } from "node:fs";

test("A9-R1 预览checkbox保留焦点时快捷键沿单一Mapping历史撤销和重做", async ({
  page,
  workspace,
}, info) => {
  await place(page, "checkbox历史");
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "卡片外观" });
  const checkbox = popup.getByRole("checkbox", { name: "显示正文预览" });
  const history = async () => {
    const state = await workspace.state();
    const response = await page.request.get(
      workspace.origin + `/api/mapping/projects/${state.project.id}/history`,
    );
    expect(response.status()).toBe(200);
    return response.json();
  };
  await checkbox.uncheck();
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect(checkbox).toBeFocused();
  const before = await workspace.state();
  const timeline = await history();
  const steps = [];
  expect(before.cards[0]!.appearance!.showPreview).toBe(false);
  await checkbox.press("Control+z");
  try {
    await expect
      .poll(async () => (await workspace.state()).project.revision)
      .toBe(before.project.revision + 1);
    const undone = await workspace.state();
    expect(undone.cards[0]!.appearance!.showPreview).toBe(true);
    expect(undone.cards[0]!.appearance!.versionId).not.toBe(
      before.cards[0]!.appearance!.versionId,
    );
    expect(undone.cards[0]!.body).toEqual(before.cards[0]!.body);
    expect(undone.cards[0]!.item).toEqual(before.cards[0]!.item);
    const after = await history();
    expect(after.undo).toHaveLength(timeline.undo.length - 1);
    expect(after.redo).toHaveLength(1);
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();
    await expect(popup).toBeVisible();
    let previous = undone;
    for (const [key, preview] of [
      ["Control+Shift+z", false],
      ["Control+z", true],
      ["Control+y", false],
      ["Meta+z", true],
      ["Meta+Shift+z", false],
      ["Meta+z", true],
      ["Meta+y", false],
    ] as const) {
      await expect(checkbox).toBeFocused();
      await checkbox.press(key);
      await expect
        .poll(async () => (await workspace.state()).project.revision)
        .toBe(previous.project.revision + 1);
      const current = await workspace.state();
      expect(current.cards[0]!.appearance!.showPreview).toBe(preview);
      expect(current.cards[0]!.appearance!.versionId).not.toBe(
        previous.cards[0]!.appearance!.versionId,
      );
      expect(current.cards[0]!.body).toEqual(before.cards[0]!.body);
      expect(current.cards[0]!.item).toEqual(before.cards[0]!.item);
      const currentHistory = await history();
      expect(currentHistory.undo).toHaveLength(
        timeline.undo.length - (preview ? 1 : 0),
      );
      expect(currentHistory.redo).toHaveLength(preview ? 1 : 0);
      await expect(checkbox).toBeFocused();
      if (preview) await expect(checkbox).toBeChecked();
      else await expect(checkbox).not.toBeChecked();
      steps.push({ key, current, currentHistory });
      previous = current;
    }
    // Synthetic events verify guards only; they do not qualify real OS IME.
    for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
      await checkbox.dispatchEvent("keydown", {
        key: "z",
        ctrlKey: true,
        ...properties,
      });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      expect(await workspace.state()).toEqual(previous);
    }
    // The still-open menu must submit against the versions produced by travel.
    await popup.getByRole("button", { name: "绿色", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const recolored = await workspace.state();
    expect(recolored.project.revision).toBe(previous.project.revision + 1);
    expect(recolored.cards[0]!.appearance!.titleColor).toBe("#dceee2");
    expect(recolored.cards[0]!.appearance!.showPreview).toBe(false);
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    await page.screenshot({ path: info.outputPath("checkbox-current-menu.png") });
  } finally {
    const path = info.outputPath("actual-mapping-history.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          before,
          timeline,
          steps,
          after: await workspace.state(),
          history: await history(),
        },
        null,
        2,
      ),
    );
    await info.attach("actual-mapping-history", {
      path,
      contentType: "application/json",
    });
  }
});

test("A9-R1 标题和项目名称保留原生文本撤销，不同时撤销项目", async ({
  page,
  workspace,
}) => {
  await place(page, "原标题");
  const before = await workspace.state();
  await page.getByRole("button", { name: "编辑标题", exact: true }).click();
  const title = page.getByLabel("卡片标题", { exact: true });
  await title.press("Meta+a");
  await title.pressSequentially("新标题");
  await title.press("Meta+z");
  await expect(title).toHaveValue("新标");
  await title.press("Meta+Shift+z");
  await expect(title).toHaveValue("新标题");
  expect((await workspace.state()).project.revision).toBe(
    before.project.revision,
  );
  await title.press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "重命名当前项目" }).click();
  const saved = await workspace.state();
  const name = page.getByLabel("项目名称", { exact: true });
  await name.press("Meta+a");
  await name.pressSequentially("新名称");
  await name.press("Meta+z");
  await expect(name).toHaveValue("新名");
  await name.press("Meta+Shift+z");
  await expect(name).toHaveValue("新名称");
  expect(await workspace.state()).toEqual(saved);
});
